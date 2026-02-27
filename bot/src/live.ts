/**
 * Live trading entry point.
 *
 * Connects to Drift, creates subaccount-isolated LiveTraders per strategy,
 * recovers open positions from Drift state on restart, and pipes
 * PriceFeed ticks through the same Arena/Strategy logic.
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
import { STRATEGIES, SUBACCOUNT_MAP, getStopLossPct } from './strategies.js';
import type { StrategyConfig } from './strategies.js';
import type { BaseStrategy } from './base-strategy.js';
import { TrendStrategy } from './trend.js';
import { MomentumStrategy } from './momentum.js';
import { LevelStrategy } from './level.js';
import { RegimeStrategy } from './regime.js';
import { Arena } from './arena.js';
import { DashboardServer } from './dashboard-server.js';
import { dashboardBus } from './dashboard-bus.js';
import { BankrollManager } from './bankroll.js';
import { DriftExecutor } from './executor.js';
import { LiveStateManager } from './live-state.js';
import { LiveTrader } from './live-trader.js';

function createLiveStrategy(
  cfg: StrategyConfig,
  executor: DriftExecutor,
  driftClient: DriftClient,
  subIdOverride?: number,
): { strategy: BaseStrategy; bankroll: BankrollManager } {
  const subId = subIdOverride ?? SUBACCOUNT_MAP[cfg.name];
  if (subId === undefined) {
    throw new Error(`No subaccount mapped for strategy ${cfg.name}`);
  }

  const slPct = getStopLossPct(cfg.name);
  const trader = new LiveTrader({
    strategyName: cfg.name,
    subAccountId: subId,
    executor,
    slPct,
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
    case 'regime':
      strategy = new RegimeStrategy(cfg, trader);
      break;
    default:
      throw new Error(`Unsupported strategy type for live trading: ${cfg.type}`);
  }

  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  return { strategy, bankroll };
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

  console.log('[live] Starting Live Trading Bridge');
  console.log(`[live] ${activeStrategies.length} strategies → subaccounts [${activeSubAccountIds.join(', ')}]`);
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

  // 2b. Set 10x max leverage on all active subaccounts (margin ratio = MARGIN_PRECISION / leverage)
  const TARGET_LEVERAGE = 10;
  const MARGIN_PRECISION = 10_000;
  const marginRatio = MARGIN_PRECISION / TARGET_LEVERAGE; // 1000 = 10x
  for (const subId of activeSubAccountIds) {
    try {
      await driftClient.switchActiveUser(subId);
      const tx = await driftClient.updateUserPerpPositionCustomMarginRatio(
        0,           // SOL-PERP market index
        marginRatio,
        subId,
      );
      console.log(`[live] Set ${TARGET_LEVERAGE}x max leverage on sub ${subId} tx=${tx}`);
    } catch (err) {
      console.warn(`[live] Failed to set leverage on sub ${subId}:`, err);
    }
  }

  // 3. Create executor + state manager
  const stateManager = new LiveStateManager();
  const executor = new DriftExecutor(driftClient, stateManager);

  // 4. Recovery: read positions from Drift
  console.log('[live] Checking for open positions (recovery)...');
  const openPositions = await executor.readAllPositions(activeSubAccountMap);

  if (openPositions.size > 0) {
    console.log(`[live] Found ${openPositions.size} open position(s):`);
    for (const [name, pos] of openPositions) {
      const extras = stateManager.get(name);
      console.log(
        `[live]   ${name}: ${pos.direction.toUpperCase()} ${pos.size.toFixed(4)} SOL @ $${pos.entryPrice.toFixed(2)}` +
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

  for (const cfg of activeStrategies) {
    const overriddenSub = subOverride ?? undefined;
    const { strategy, bankroll } = createLiveStrategy(cfg, executor, driftClient, overriddenSub);
    strategies.push(strategy);
    bankrolls.push(bankroll);
  }

  const arena = new Arena(strategies);

  // 6b. Warmup: replay historical ticks so strategies start warm (no 4h wait)
  // Fetches 5h of 1-minute candles from Pyth Benchmarks API and feeds them
  // through the strategies. Drift orders are suppressed during warmup since
  // the paper.inPosition check prevents entries (no position = no exit management).
  // Any entry signals during warmup are harmless — the bankroll has 0 equity
  // until the first refreshFromDrift() call, so getBetSize() returns 0.
  try {
    const warmupTicks = await fetchWarmupTicks(5);
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

  // Track SOL price + account balance
  let lastSol = 0;
  let lastAccountEmit = 0;
  const ACCOUNT_EMIT_INTERVAL_MS = 30_000; // 30s

  const feed = new PriceFeed();
  feed.onTick((tick) => {
    arena.onTick(tick);

    lastSol = tick.price;
    // Fan out SOL price + equity refresh to all per-sub bankrolls
    for (const bm of bankrolls) {
      bm.updateSolPrice(tick.price);
      bm.refreshFromDrift().catch(() => {});
    }
    if (lastSol > 0) {
      dashboardBus.emitPrice({ sol: lastSol, timestamp: Date.now() });
    }

    // Emit account balance periodically
    const now = Date.now();
    if (now - lastAccountEmit >= ACCOUNT_EMIT_INTERVAL_MS) {
      lastAccountEmit = now;
      const subId = activeSubAccountIds[0];
      const { totalCollateral, unrealizedPnl, allTimePnl } = executor.readAccountBalance(subId);
      if (totalCollateral > 0) {
        const realizedPnl = allTimePnl - unrealizedPnl;
        dashboardBus.emitAccount({
          balanceUsdc: totalCollateral,
          unrealizedPnl,
          startBalanceUsdc: totalCollateral - allTimePnl, // derived: deposits = balance - allTimePnl
          realizedPnl,
          totalPnl: allTimePnl,
          timestamp: now,
        });
      }
    }
  });

  feed.start();
  arena.start();

  // Startup summary
  console.log('');
  console.log('[live] ═══ LIVE TRADING ACTIVE ═══');
  console.log('');
  console.log('  Sub  Strategy         SL%    Type');
  console.log('  ───  ───────────────  ─────  ────────');
  for (const cfg of activeStrategies) {
    const sub = activeSubAccountMap[cfg.name];
    const sl = getStopLossPct(cfg.name);
    console.log(
      `  ${String(sub).padStart(3)}  ${cfg.name.padEnd(15)}  ${sl.toFixed(2)}%  ${cfg.type}`,
    );
  }
  console.log('');
  console.log('[live] Waiting for Pyth price feed...');

  // 8. Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[live] ${signal} — shutting down...`);
    console.log('[live] SL triggers remain on-chain for protection');
    feed.stop();
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

main().catch((err) => {
  console.error('[live] Fatal error:', err);
  process.exit(1);
});
