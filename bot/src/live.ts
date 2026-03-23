/**
 * Live trading entry point.
 *
 * Connects to Drift, creates subaccount-isolated LiveTraders per strategy,
 * recovers open positions from Drift state on restart, and pipes
 * PriceFeed ticks through the same Arena/Strategy logic.
 *
 * Supports multi-market trading (SOL, HYPE, etc.) — a single Pyth SSE
 * connection streams all needed feeds, and each strategy filters by feedId.
 *
 * Usage: npx tsx src/live.ts
 * Requires: .env with PRIVATE_KEY and RPC_URL
 */

import { config } from 'dotenv';
config();

import {
  DriftClient,
  Wallet,
  initialize,
} from '@drift-labs/sdk';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

import { PriceFeed, fetchWarmupTicks } from './feed.js';
import { STRATEGIES, SUBACCOUNT_MAP, MARKETS, getStopLossPct, getMarketForStrategy } from './strategies.js';
import type { StrategyConfig } from './strategies.js';
import type { BaseStrategy } from './base-strategy.js';
import { TrendStrategy } from './trend.js';
import { MomentumStrategy } from './momentum.js';
import { LevelStrategy } from './level.js';
import { RegimeStrategy } from './regime.js';
import { Arena } from './arena.js';
import type { StrategyMeta } from './arena.js';
import { DashboardServer } from './dashboard-server.js';
import { dashboardBus } from './dashboard-bus.js';
import { BankrollManager } from './bankroll.js';
import { DriftExecutor } from './executor.js';
import { LiveStateManager } from './live-state.js';
import { LiveTrader } from './live-trader.js';
import { RoiTracker } from './roi-tracker.js';
import type { RoiResult } from './roi-tracker.js';


function createLiveStrategy(
  cfg: StrategyConfig,
  executor: DriftExecutor,
  driftClient: DriftClient,
  subIdOverride?: number,
): { strategy: BaseStrategy; bankroll: BankrollManager; trader: LiveTrader } {
  const subId = subIdOverride ?? SUBACCOUNT_MAP[cfg.name];
  if (subId === undefined) {
    throw new Error(`No subaccount mapped for strategy ${cfg.name}`);
  }

  const market = getMarketForStrategy(cfg);
  const slPct = getStopLossPct(cfg.name);
  const trader = new LiveTrader({
    strategyName: cfg.name,
    subAccountId: subId,
    executor,
    slPct,
    marketIndex: market.marketIndex,
  });

  // Per-subaccount bankroll — each strategy sizes bets against its own collateral
  const bankroll = new BankrollManager({
    mode: 'drift',
    initialEquitySol: 0, // 0 until first refresh — unfunded subs stay inactive
    driftClient,
    subAccountIds: [subId],
  });

  let strategy: BaseStrategy;
  switch (cfg.type) {
    case 'trend':
      strategy = new TrendStrategy(cfg, trader);
      break;
    case 'momentum':
      strategy = new MomentumStrategy(cfg, trader);
      break;
    case 'level':
      strategy = new LevelStrategy(cfg, trader);
      break;
    case 'regime': {
      // Inject feedId from market config so the strategy filters the right ticks
      const regimeCfg = { ...cfg, feedId: market.feedId };
      strategy = new RegimeStrategy(regimeCfg, trader);
      break;
    }
    default:
      throw new Error(`Unsupported strategy type for live trading: ${cfg.type}`);
  }

  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  return { strategy, bankroll, trader };
}

async function main(): Promise<void> {
  // 0. Parse CLI args
  const args = process.argv.slice(2);
  let onlyStrategies: string[] | null = null;
  let subOverride: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--only' && args[i + 1]) {
      onlyStrategies = args[i + 1].split(',');
      i++;
    }
    if (args[i] === '--sub' && args[i + 1]) {
      subOverride = parseInt(args[i + 1], 10);
      i++;
    }
  }

  // 1. Load environment
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const RPC_URL = process.env.RPC_URL;

  if (!PRIVATE_KEY || !RPC_URL) {
    console.error('[live] Missing PRIVATE_KEY or RPC_URL in .env');
    process.exit(1);
  }

  // Determine which strategies and subaccounts to use
  const activeStrategies = STRATEGIES.filter((cfg) => {
    if (SUBACCOUNT_MAP[cfg.name] === undefined) return false;
    if (onlyStrategies && !onlyStrategies.includes(cfg.name)) return false;
    return true;
  });

  if (activeStrategies.length === 0) {
    console.error('[live] No matching strategies found');
    process.exit(1);
  }

  // Build subaccount mapping (with optional override)
  const activeSubAccountMap: Record<string, number> = {};
  for (const cfg of activeStrategies) {
    activeSubAccountMap[cfg.name] = subOverride ?? SUBACCOUNT_MAP[cfg.name];
  }
  const activeSubAccountIds = [...new Set(Object.values(activeSubAccountMap))];

  // Build market index mapping per strategy
  const strategyMarketIndices: Record<string, number> = {};
  for (const cfg of activeStrategies) {
    strategyMarketIndices[cfg.name] = getMarketForStrategy(cfg).marketIndex;
  }

  // Collect unique feed IDs and market configs for the active strategies
  const feedIdSet = new Set<string>();
  const warmupMarkets: { feedId: string; pythSymbol: string }[] = [];
  const seenFeedIds = new Set<string>();
  for (const cfg of activeStrategies) {
    const market = getMarketForStrategy(cfg);
    feedIdSet.add(market.feedId);
    if (!seenFeedIds.has(market.feedId)) {
      seenFeedIds.add(market.feedId);
      warmupMarkets.push({ feedId: market.feedId, pythSymbol: market.pythSymbol });
    }
  }
  const uniqueFeedIds = [...feedIdSet];

  console.log('[live] Starting Live Trading Bridge');
  console.log(`[live] ${activeStrategies.length} strategies → subaccounts [${activeSubAccountIds.join(', ')}]`);
  console.log(`[live] Markets: ${warmupMarkets.map(m => m.pythSymbol).join(', ')}`);
  if (onlyStrategies) console.log(`[live] Filtered to: ${onlyStrategies.join(', ')}`);
  if (subOverride !== null) console.log(`[live] Subaccount override: all strategies → sub ${subOverride}`);

  // 2. Create Drift client (subscribe only to needed subaccounts)
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  const wallet = new Wallet(keypair);

  initialize({ env: 'mainnet-beta' });

  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    activeSubAccountId: activeSubAccountIds[0],
    subAccountIds: activeSubAccountIds,
    accountSubscription: { type: 'websocket' },
  });

  await driftClient.subscribe();
  console.log('[live] Drift client connected');

  // 2b. Set 10x max leverage on all active subaccounts per market
  const TARGET_LEVERAGE = 10;
  const MARGIN_PRECISION = 10_000;
  const marginRatio = MARGIN_PRECISION / TARGET_LEVERAGE; // 1000 = 10x

  // Collect unique (subId, marketIndex) pairs to set leverage
  const leveragePairs = new Set<string>();
  for (const cfg of activeStrategies) {
    const subId = subOverride ?? SUBACCOUNT_MAP[cfg.name];
    const mktIdx = strategyMarketIndices[cfg.name];
    leveragePairs.add(`${subId}:${mktIdx}`);
  }
  for (const pair of leveragePairs) {
    const [subIdStr, mktIdxStr] = pair.split(':');
    const subId = parseInt(subIdStr, 10);
    const mktIdx = parseInt(mktIdxStr, 10);
    try {
      await driftClient.switchActiveUser(subId);
      const tx = await driftClient.updateUserPerpPositionCustomMarginRatio(
        mktIdx,
        marginRatio,
        subId,
      );
      console.log(`[live] Set ${TARGET_LEVERAGE}x on sub ${subId} mkt ${mktIdx} tx=${tx}`);
    } catch (err) {
      console.warn(`[live] Failed to set leverage on sub ${subId} mkt ${mktIdx}:`, err);
    }
  }

  // 3. Create executor + state manager
  const stateManager = new LiveStateManager();
  const executor = new DriftExecutor(driftClient, stateManager);

  // 4. Recovery: read positions from Drift
  console.log('[live] Checking for open positions (recovery)...');
  const openPositions = await executor.readAllPositions(activeSubAccountMap, strategyMarketIndices);

  if (openPositions.size > 0) {
    console.log(`[live] Found ${openPositions.size} open position(s):`);
    for (const [name, pos] of openPositions) {
      const extras = stateManager.get(name);
      console.log(
        `[live]   ${name}: ${pos.direction.toUpperCase()} ${pos.size.toFixed(4)} @ $${pos.entryPrice.toFixed(2)}` +
        (extras ? ` | bestPrice=$${extras.bestPriceSinceEntry.toFixed(2)}` : ' | no state file (using defaults)'),
      );
    }
  } else {
    console.log('[live] No open positions found — clean start');
  }

  // Clear stale state entries for strategies that have no position
  const activeStratNames = new Set(openPositions.keys());
  stateManager.clearStale(activeStratNames);

  // 5. Create strategies with per-subaccount bankrolls
  const bankrolls: BankrollManager[] = [];
  const strategies: BaseStrategy[] = [];
  const traders: LiveTrader[] = [];

  for (const cfg of activeStrategies) {
    const overriddenSub = subOverride ?? undefined;
    const { strategy, bankroll, trader } = createLiveStrategy(cfg, executor, driftClient, overriddenSub);
    strategies.push(strategy);
    bankrolls.push(bankroll);
    traders.push(trader);
  }

  // Build metadata for Arena (market + subaccount per strategy)
  const arenaMeta: Record<string, StrategyMeta> = {};
  for (const cfg of activeStrategies) {
    const market = getMarketForStrategy(cfg);
    arenaMeta[cfg.name] = {
      market: market.symbol,
      subAccountId: activeSubAccountMap[cfg.name],
    };
  }
  const arena = new Arena(strategies, arenaMeta);

  // 6b. Warmup: replay historical ticks so strategies start warm (no 4h wait)
  try {
    const warmupTicks = await fetchWarmupTicks(5, warmupMarkets);
    console.log(`[warmup] Replaying ${warmupTicks.length} ticks through strategies...`);
    for (const tick of warmupTicks) {
      arena.onTick(tick);
    }
    console.log('[warmup] Done — strategies are warm');
  } catch (err) {
    console.warn('[warmup] Failed (strategies will warm up from live feed):', err);
  }

  // 7. Recovery: reconstruct strategy state for open positions (after warmup
  // so ATR/price buffers are full and exit management works immediately)
  if (openPositions.size > 0) {
    for (const [stratName, pos] of openPositions) {
      const strategy = strategies.find(s => s.name === stratName);
      if (!strategy?.recoverPosition) continue;

      const extras = stateManager.get(stratName);
      strategy.recoverPosition(pos, extras);
    }
  }

  // 8. Start dashboard
  const dashboard = new DashboardServer();
  dashboard.start();

  // Wire feed to dashboard for health reporting — subscribe to all needed feeds
  const feed = new PriceFeed(uniqueFeedIds);
  dashboard.setFeed(feed);

  // Drift mark/oracle prices from SDK (updated alongside market data emit)
  const driftPriceCache: Record<string, { mark: number; oracle: number }> = {};

  // Start ROI tracker (fetches from Drift data API, no local state)
  const subToStrategy: Record<number, string> = {};
  for (const [name, subId] of Object.entries(activeSubAccountMap)) {
    subToStrategy[subId] = name;
  }
  const roiTracker = new RoiTracker(wallet.publicKey, activeSubAccountIds, subToStrategy);
  let latestRoiData: RoiResult | null = null;
  roiTracker.onUpdate((data) => { latestRoiData = data; });
  roiTracker.start();

  // Track prices + account balance + market data
  let lastSol = 0;
  const marketPrices: Record<string, number> = {}; // symbol → last price
  let lastAccountEmit = 0;
  let lastMarketEmit = 0;
  let lastBankrollRefresh = 0;
  const ACCOUNT_EMIT_INTERVAL_MS = 30_000;   // 30s
  const MARKET_EMIT_INTERVAL_MS = 60_000;    // 60s
  const BANKROLL_REFRESH_MS = 30_000;         // 30s — avoid flooding RPC on every tick

  // Build feedId → market symbol lookup
  const SOL_FEED_ID = MARKETS.SOL.feedId;
  const feedIdToSymbol: Record<string, string> = {};
  for (const [sym, mkt] of Object.entries(MARKETS)) {
    if (feedIdSet.has(mkt.feedId)) feedIdToSymbol[mkt.feedId] = sym;
  }

  feed.onTick((tick) => {
    const now = Date.now();

    // Strategy tick processing — isolated so account/market emit still runs on error
    try {
      arena.onTick(tick);
    } catch (err) {
      console.error('[live] Strategy tick error:', err);
      dashboardBus.emitActivity({
        strategyName: 'SYSTEM',
        level: 'error',
        message: `Tick handler error — ${err instanceof Error ? err.message : String(err)}`,
        timestamp: now / 1000,
      });
    }

    // Track per-market prices
    const sym = feedIdToSymbol[tick.feedId];
    if (sym) marketPrices[sym] = tick.price;

    // Use SOL price for bankroll SOL conversion (throttle RPC refresh)
    if (tick.feedId === SOL_FEED_ID) {
      lastSol = tick.price;
      for (const bm of bankrolls) {
        bm.updateSolPrice(tick.price);
      }
      if (now - lastBankrollRefresh >= BANKROLL_REFRESH_MS) {
        lastBankrollRefresh = now;
        for (const bm of bankrolls) {
          bm.refreshFromDrift().catch((err) => {
            console.error('[live] Bankroll refresh failed:', err);
          });
        }
      }
    }

    // Emit price event with all market prices (throttled by dashboardBus)
    if (lastSol > 0) {
      dashboardBus.emitPrice({
        sol: lastSol,
        timestamp: Date.now(),
        prices: { ...marketPrices },
        driftPrices: Object.keys(driftPriceCache).length > 0 ? { ...driftPriceCache } : undefined,
      });
    }

    // Emit account balance periodically (aggregate all active subaccounts)
    if (now - lastAccountEmit >= ACCOUNT_EMIT_INTERVAL_MS) {
      lastAccountEmit = now;
      let totalCollateral = 0;
      let unrealizedPnl = 0;
      let allTimePnl = 0;
      let tradingPnl = 0;

      // Per-subaccount balances (dedup since multiple strategies may share a sub)
      const subBalances: Record<number, { totalCollateral: number; unrealizedPnl: number; allTimePnl: number; tradingPnl: number }> = {};
      for (const subId of activeSubAccountIds) {
        subBalances[subId] = executor.readAccountBalance(subId);
        totalCollateral += subBalances[subId].totalCollateral;
        unrealizedPnl += subBalances[subId].unrealizedPnl;
        allTimePnl += subBalances[subId].allTimePnl;
        tradingPnl += subBalances[subId].tradingPnl;
      }

      // Build per-strategy breakdown (with ROI data if available)
      const perStrategy: Record<string, { balanceUsdc: number; unrealizedPnl: number; startBalanceUsdc: number; realizedPnl: number; totalPnl: number; tradingPnl: number; dailyRoi?: number; avgDailyRoi?: number; annualizedRoi?: number; cumulativeTwr?: number }> = {};
      for (const [stratName, subId] of Object.entries(activeSubAccountMap)) {
        const sb = subBalances[subId];
        if (sb) {
          const roi = latestRoiData?.perSubAccount[subId];
          perStrategy[stratName] = {
            balanceUsdc: sb.totalCollateral,
            unrealizedPnl: sb.unrealizedPnl,
            startBalanceUsdc: sb.totalCollateral - sb.allTimePnl,
            realizedPnl: sb.allTimePnl - sb.unrealizedPnl,
            totalPnl: sb.allTimePnl,
            tradingPnl: sb.tradingPnl,
            ...(roi ? { yesterdayRoi: roi.yesterdayRoi, avgDailyRoi: roi.avgDailyRoi, annualizedRoi: roi.annualizedRoi, cumulativeTwr: roi.cumulativeTwr } : {}),
          };
        }
      }

      if (totalCollateral > 0) {
        const realizedPnl = allTimePnl - unrealizedPnl;
        const aggRoi = latestRoiData?.aggregate;
        dashboardBus.emitAccount({
          balanceUsdc: totalCollateral,
          unrealizedPnl,
          startBalanceUsdc: totalCollateral - allTimePnl,
          realizedPnl,
          totalPnl: allTimePnl,
          tradingPnl,
          timestamp: now,
          perStrategy,
          ...(aggRoi ? { yesterdayRoi: aggRoi.yesterdayRoi, avgDailyRoi: aggRoi.avgDailyRoi, annualizedRoi: aggRoi.annualizedRoi, cumulativeTwr: aggRoi.cumulativeTwr } : {}),
        });
      }
    }

    // Emit market data periodically + update Drift mark/oracle price cache
    if (now - lastMarketEmit >= MARKET_EMIT_INTERVAL_MS) {
      lastMarketEmit = now;
      for (const [sym, mkt] of Object.entries(MARKETS)) {
        if (!feedIdSet.has(mkt.feedId)) continue;
        const md = executor.readMarketData(mkt.marketIndex);
        if (md) {
          driftPriceCache[sym] = { mark: md.markPrice, oracle: md.oraclePrice };
          if (sym === 'SOL') dashboardBus.emitMarket(md);
        }
      }
    }
  });

  feed.start();
  arena.start();

  // 9. Position sync — detect external closes (SL trigger, manual, liquidation)
  const SYNC_INTERVAL_MS = 10_000; // check every 10s
  const syncTimer = setInterval(() => {
    for (const trader of traders) {
      trader.syncWithDrift().catch((err) => {
        console.error('[live] Position sync error:', err);
      });
    }
  }, SYNC_INTERVAL_MS);

  // 10. Feed stale detection — alert when Pyth feed goes silent
  let feedStaleNotified = false;
  const feedWatchTimer = setInterval(() => {
    const lastTick = feed.lastTickMs;
    if (lastTick > 0 && Date.now() - lastTick > 60_000) {
      if (!feedStaleNotified) {
        feedStaleNotified = true;
        const silentSec = Math.round((Date.now() - lastTick) / 1000);
        console.error(`[live] Price feed stale — no ticks for ${silentSec}s`);
        dashboardBus.emitActivity({
          strategyName: 'SYSTEM',
          level: 'error',
          message: `Price feed stale — no ticks for ${silentSec}s. On-chain SL protects open positions.`,
          timestamp: Date.now() / 1000,
        });
      }
    } else if (feedStaleNotified) {
      feedStaleNotified = false;
      dashboardBus.emitActivity({
        strategyName: 'SYSTEM',
        level: 'info',
        message: 'Price feed recovered',
        timestamp: Date.now() / 1000,
      });
    }
  }, 30_000);

  // Startup summary
  console.log('');
  console.log('[live] ═══ LIVE TRADING ACTIVE ═══');
  console.log('');
  console.log('  Sub  Market  Strategy         SL%    Type');
  console.log('  ───  ──────  ───────────────  ─────  ────────');
  for (const cfg of activeStrategies) {
    const sub = activeSubAccountMap[cfg.name];
    const sl = getStopLossPct(cfg.name);
    const market = getMarketForStrategy(cfg);
    console.log(
      `  ${String(sub).padStart(3)}  ${market.symbol.padEnd(6)}  ${cfg.name.padEnd(15)}  ${sl.toFixed(2)}%  ${cfg.type}`,
    );
  }
  console.log('');
  console.log('[live] Waiting for Pyth price feed...');

  // 8. Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[live] ${signal} — shutting down...`);
    console.log('[live] SL triggers remain on-chain for protection');
    clearInterval(syncTimer);
    clearInterval(feedWatchTimer);
    feed.stop();
    roiTracker.stop();
    arena.stop();
    dashboard.stop();
    dashboardBus.shutdown();

    try {
      await driftClient.unsubscribe();
      console.log('[live] Drift disconnected');
    } catch (err) {
      console.error('[live] Drift disconnect error:', err);
    }

    console.log('[live] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Catch unhandled promise rejections — prevents silent death of the event loop
process.on('unhandledRejection', (reason, promise) => {
  console.error('[live] Unhandled promise rejection:', reason);
});

main().catch((err) => {
  console.error('[live] Fatal error:', err);
  process.exit(1);
});
