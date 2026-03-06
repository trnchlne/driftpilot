/**
 * Compare backtest vs live results for the current session.
 *
 * Fetches real price data from Pyth for the exact period the bot has been live,
 * runs R-base and R-fast with identical configs, and prints every trade
 * so you can diff against the decision log.
 *
 * Usage: npx tsx src/backtest-compare.ts
 */

import type { Tick } from './feed.js';
import { SOL_FEED_ID } from './feed.js';
import { STRATEGIES } from './strategies.js';
import type { StrategyConfig } from './strategies.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';
import type { PaperTrade } from './base-strategy.js';

/* ─── Config ─────────────────────────────────────────────── */

// Bot session: warmup started 2026-03-05T15:20 UTC
// Warmup fetched 5h prior, so price data from ~10:20 UTC
// We'll fetch from 10:00 UTC Mar 5 to now
const WARMUP_START = Math.floor(new Date('2026-03-05T10:00:00Z').getTime() / 1000);
const SESSION_START = Math.floor(new Date('2026-03-05T15:20:58Z').getTime() / 1000);
const NOW = Math.floor(Date.now() / 1000);

const BALANCE_USDC = 27.51;
const SOL_PRICE_APPROX = 89;
const BALANCE_SOL = BALANCE_USDC / SOL_PRICE_APPROX;
const LEVERAGE = 10;

/* ─── Fetch Data from Pyth ───────────────────────────────── */

async function fetchPythCandles(from: number, to: number): Promise<Tick[]> {
  const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.SOL/USD&resolution=1&from=${from}&to=${to}`;
  console.log(`[fetch] Pyth Benchmarks ${new Date(from * 1000).toISOString()} → ${new Date(to * 1000).toISOString()}`);

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Pyth API error: ${resp.status}`);

  const data = await resp.json() as { s: string; t: number[]; c: number[] };
  if (data.s !== 'ok' || !data.t || !data.c) throw new Error(`Pyth returned: ${data.s}`);

  const ticks: Tick[] = [];
  for (let i = 0; i < data.t.length; i++) {
    ticks.push({ feedId: SOL_FEED_ID, price: data.c[i], publishTime: data.t[i] });
  }
  console.log(`[fetch] Got ${ticks.length} candles (${(ticks.length / 60).toFixed(1)}h)`);
  return ticks;
}

/* ─── Run Strategy ───────────────────────────────────────── */

interface TradeRecord {
  strategy: string;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  holdSec: number;
  pnlSol: number;
  reason: string;
}

function runStrategy(name: string, ticks: Tick[]): TradeRecord[] {
  const config = STRATEGIES.find(s => s.name === name);
  if (!config) throw new Error(`Strategy ${name} not found`);

  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: BALANCE_SOL });
  const strategy = new RegimeStrategy(config as any);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  const trades: TradeRecord[] = [];
  let lastReason = '';

  // Capture exit reasons
  const origExit = (strategy as any).exit.bind(strategy);
  (strategy as any).exit = function(price: number, now: number, feeRate: number, reason: string) {
    lastReason = reason;
    origExit(price, now, feeRate, reason);
  };

  // Patch enter for leveraged sizing (same as backtest-live.ts)
  (strategy as any).enter = function(direction: any, price: number, now: number, regime: any, feeRate: number) {
    const betSize = this.getBetSize();
    if (betSize <= 0) return;
    this.entryPrice = price;
    this.entryDirection = direction;
    this.entryTickTime = now;
    this.entryRegime = regime;
    this.bestPriceSinceEntry = price;
    this.entryRollingMean = this.rollingMean;
    this.entryScaledAtr = this.scaledAtr(this.config.meanWindowSeconds / 60);
    this.lastTrailCheckTime = now;
    this.bankroll?.reserveCapital(betSize);
    this.paper.openPaper(direction, price, betSize * LEVERAGE, feeRate, now);
    this.paper.saveEntryRegime(regime);
  };

  // Patch exit for leveraged sizing
  (strategy as any).exit = function(price: number, now: number, feeRate: number, reason: string) {
    if (!this.paper.inPosition) return;
    lastReason = reason;
    const trade = this.paper.closePaper(price, feeRate, now);
    if (!trade) return;
    const margin = trade.sizeSol / LEVERAGE;
    this.bankroll?.releaseCapital(margin);
    this.bankroll?.recordPnl(trade.netPnlSol);
    this.lastTradeInfo = {
      direction: trade.direction, entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice, holdSec: now - this.entryTickTime,
      netPnl: trade.netPnlSol, reason, atrAtExit: this.atrPct, trailPctAtExit: 0,
    };

    trades.push({
      strategy: name,
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      holdSec: trade.exitTime - trade.entryTime,
      pnlSol: trade.netPnlSol,
      reason,
    });
  };

  // Suppress console noise
  const origLog = console.log;
  console.log = () => {};

  for (const tick of ticks) {
    bankroll.updateSolPrice(tick.price);
    strategy.onTick(tick);
  }

  console.log = origLog;

  const metrics = strategy.getMetrics();
  const finalEquity = bankroll.getEquity();

  return trades;
}

/* ─── Main ───────────────────────────────────────────────── */

async function main() {
  // Fetch the exact period
  const ticks = await fetchPythCandles(WARMUP_START, NOW);
  if (ticks.length === 0) { console.error('No data'); process.exit(1); }

  const firstPrice = ticks[0].price;
  const lastPrice = ticks[ticks.length - 1].price;
  const hours = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 3600;

  console.log(`[data] ${ticks.length} candles over ${hours.toFixed(1)}h`);
  console.log(`[data] SOL: $${firstPrice.toFixed(2)} → $${lastPrice.toFixed(2)}`);
  console.log(`[data] Balance: ${BALANCE_SOL.toFixed(4)} SOL ($${BALANCE_USDC}), 10x leverage`);
  console.log('');

  // Find where warmup ends and live trading starts
  const liveStartIdx = ticks.findIndex(t => t.publishTime >= SESSION_START);
  console.log(`[data] Warmup ticks: ${liveStartIdx} | Live ticks: ${ticks.length - liveStartIdx}`);
  console.log('');

  // Run both strategies
  for (const name of ['R-base', 'R-fast']) {
    console.log('═'.repeat(70));
    console.log(`  ${name} — BACKTEST TRADES`);
    console.log('═'.repeat(70));

    const trades = runStrategy(name, ticks);

    // Filter to only trades that occurred during the live period
    const liveTrades = trades.filter(t => t.entryTime >= SESSION_START);
    const warmupTrades = trades.filter(t => t.entryTime < SESSION_START);

    if (warmupTrades.length > 0) {
      console.log(`  (${warmupTrades.length} trades during warmup period, excluded)`);
    }

    if (liveTrades.length === 0) {
      console.log('  No trades during live period.');
    } else {
      let totalPnl = 0;
      for (const t of liveTrades) {
        const entryDate = new Date(t.entryTime * 1000).toISOString().replace('T', ' ').slice(0, 19);
        const exitDate = new Date(t.exitTime * 1000).toISOString().replace('T', ' ').slice(0, 19);
        const holdMin = (t.holdSec / 60).toFixed(0);
        const sign = t.pnlSol >= 0 ? '+' : '';
        totalPnl += t.pnlSol;
        console.log(`  ${t.direction.toUpperCase().padEnd(5)} $${t.entryPrice.toFixed(2)} → $${t.exitPrice.toFixed(2)} | ${sign}${t.pnlSol.toFixed(6)} SOL | ${holdMin}m | ${t.reason}`);
        console.log(`         entry: ${entryDate} UTC  exit: ${exitDate} UTC`);
      }
      console.log(`  ────────────────────────────────────`);
      const sign = totalPnl >= 0 ? '+' : '';
      console.log(`  Total: ${liveTrades.length} trades, ${sign}${totalPnl.toFixed(6)} SOL`);
    }
    console.log('');
  }

  // Print the actual live trades for comparison
  console.log('═'.repeat(70));
  console.log('  ACTUAL LIVE TRADES (from decision log)');
  console.log('═'.repeat(70));
  console.log('  R-fast: SHORT $88.67 → $88.36 | +0.001061 SOL | 63m | TP');
  console.log('          entry: 2026-03-06 07:26:45 UTC  exit: 2026-03-06 08:30:13 UTC');
  console.log('  R-base: No trades');
  console.log('');
}

main().catch(console.error);
