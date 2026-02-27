/**
 * Backtest the current live R-base config against recent data.
 * Mimics the real Drift setup: 10x leverage, 30% Kelly, $27.51 balance.
 *
 * Usage: npx tsx src/backtest-live.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import type { BaseStrategy } from './base-strategy.js';
import { STRATEGIES } from './strategies.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';
import { SOL_FEED_ID } from './feed.js';

/* ─── Config ─────────────────────────────────────────────── */

const DATA_PATH = resolve('data/history-180d.jsonl');
const LAST_N_DAYS = parseInt(process.env.DAYS || '90');

// Mimic live setup
const BALANCE_USDC = parseFloat(process.env.BAL || '27.51');
const SOL_PRICE_APPROX = 86; // rough current price for converting USDC → SOL
const BALANCE_SOL = BALANCE_USDC / SOL_PRICE_APPROX;
const LEVERAGE = 10;

/* ─── Load Data ──────────────────────────────────────────── */

function loadTicks(filePath: string): Tick[] {
  const raw = readFileSync(filePath, 'utf-8');
  const ticks: Tick[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      ticks.push({ feedId: obj.feedId, price: obj.price, publishTime: obj.publishTime });
    } catch { /* skip */ }
  }
  ticks.sort((a, b) => a.publishTime - b.publishTime);
  return ticks;
}

/* ─── Main ───────────────────────────────────────────────── */

function main(): void {
  console.log(`[backtest-live] Loading data from ${DATA_PATH}...`);
  const allTicks = loadTicks(DATA_PATH);
  const lastTs = allTicks[allTicks.length - 1].publishTime;
  const startTs = lastTs - (LAST_N_DAYS * 24 * 3600);

  // Slice to last 3 months
  const ticks = allTicks.filter(t => t.publishTime >= startTs);
  const solTicks = ticks.filter(t => t.feedId === SOL_FEED_ID);

  const firstSolPrice = solTicks[0]?.price ?? 0;
  const lastSolPrice = solTicks[solTicks.length - 1]?.price ?? 0;
  const hours = (lastTs - startTs) / 3600;
  const days = hours / 24;

  console.log(`[backtest-live] ${ticks.length.toLocaleString()} ticks (${solTicks.length.toLocaleString()} SOL) over ${days.toFixed(0)} days`);
  console.log(`[backtest-live] SOL: $${firstSolPrice.toFixed(2)} → $${lastSolPrice.toFixed(2)} (${(((lastSolPrice/firstSolPrice)-1)*100).toFixed(1)}%)`);
  console.log(`[backtest-live] Starting equity: ${BALANCE_SOL.toFixed(4)} SOL ($${BALANCE_USDC.toFixed(2)} @ $${SOL_PRICE_APPROX})`);
  console.log('');

  // Get R-base config
  const rBaseConfig = STRATEGIES.find(s => s.name === 'R-base');
  if (!rBaseConfig) { console.error('R-base not found'); process.exit(1); }

  // Create strategy with bankroll
  const bankroll = new BankrollManager({
    mode: 'paper',
    initialEquitySol: BALANCE_SOL,
  });
  const strategy = new RegimeStrategy(rBaseConfig);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  // Patch enter() — reserve margin, open leveraged position
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

  // Patch exit() — release margin, not leveraged size
  (strategy as any).exit = function(price: number, now: number, feeRate: number, reason: string) {
    if (!this.paper.inPosition) return;
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
  };

  // Track equity over time for reporting
  let peakEquity = BALANCE_SOL;
  let maxDdPct = 0;
  let maxDdSol = 0;
  let lastSnapTime = 0;
  const equityCurve: { ts: number; equity: number; price: number }[] = [];
  const monthlyPnl: Record<string, { start: number; end: number; trades: number }> = {};
  let lastMonth = '';

  // Track trades
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;

  // Suppress trade logs
  const origLog = console.log;
  console.log = () => {};

  for (const tick of ticks) {
    bankroll.updateSolPrice(tick.price);
    strategy.onTick(tick);

    // Snapshot every 60s
    if (tick.publishTime - lastSnapTime >= 60) {
      const eq = bankroll.getEquity();

      // Track peaks and drawdown
      if (eq > peakEquity) peakEquity = eq;
      const dd = peakEquity - eq;
      if (dd > maxDdSol) maxDdSol = dd;
      const ddPct = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
      if (ddPct > maxDdPct) maxDdPct = ddPct;

      // Monthly tracking
      const date = new Date(tick.publishTime * 1000);
      const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      if (month !== lastMonth) {
        if (lastMonth && monthlyPnl[lastMonth]) {
          monthlyPnl[lastMonth].end = eq;
        }
        if (!monthlyPnl[month]) {
          monthlyPnl[month] = { start: eq, end: eq, trades: 0 };
        }
        lastMonth = month;
      }
      if (monthlyPnl[month]) monthlyPnl[month].end = eq;

      // Equity curve (sample every hour)
      if (equityCurve.length === 0 || tick.publishTime - equityCurve[equityCurve.length - 1].ts >= 3600) {
        equityCurve.push({ ts: tick.publishTime, equity: eq, price: tick.price });
      }

      lastSnapTime = tick.publishTime;
    }
  }

  console.log = origLog;

  // Get final metrics
  const metrics = strategy.getMetrics();
  const finalEquity = bankroll.getEquity();
  const roiPct = ((finalEquity / BALANCE_SOL) - 1) * 100;
  const finalUsdc = finalEquity * lastSolPrice;

  // Print results
  console.log('═'.repeat(80));
  console.log('  R-BASE 3-MONTH BACKTEST — Mimicking Live Drift Setup');
  console.log('═'.repeat(80));
  console.log('');
  console.log('  Setup:');
  console.log(`    Balance:    ${BALANCE_SOL.toFixed(4)} SOL ($${BALANCE_USDC.toFixed(2)})`);
  console.log(`    Leverage:   10x (profit-locking uses 10x for portfolio % calc)`);
  console.log(`    Kelly:      30% per trade`);
  console.log(`    Strategy:   R-base (regime-switching, current config)`);
  console.log(`    Period:     ${days.toFixed(0)} days`);
  console.log(`    SOL price:  $${firstSolPrice.toFixed(2)} → $${lastSolPrice.toFixed(2)}`);
  console.log('');
  console.log('  Results:');
  console.log(`    Final Equity: ${finalEquity.toFixed(4)} SOL ($${finalUsdc.toFixed(2)})`);
  console.log(`    ROI:          ${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(2)}%`);
  console.log(`    P&L (SOL):    ${metrics.netPnlSol >= 0 ? '+' : ''}${metrics.netPnlSol.toFixed(4)} SOL`);
  console.log(`    P&L (USD):    ${(metrics.netPnlSol * lastSolPrice) >= 0 ? '+' : ''}$${(metrics.netPnlSol * lastSolPrice).toFixed(2)}`);
  console.log('');
  console.log('  Trade Stats:');
  console.log(`    Total Trades: ${metrics.totalTrades}`);
  console.log(`    Win Rate:     ${metrics.winRate.toFixed(1)}%`);
  console.log(`    Wins:         ${metrics.wins}`);
  console.log(`    Losses:       ${metrics.losses}`);
  console.log(`    Profit Factor:${metrics.profitFactor === Infinity ? ' Inf' : ` ${metrics.profitFactor.toFixed(2)}`}`);
  console.log(`    Sharpe:       ${metrics.sharpe.toFixed(3)}`);
  console.log(`    Avg Trade:    ${metrics.totalTrades > 0 ? (metrics.netPnlSol / metrics.totalTrades).toFixed(6) : '0'} SOL`);
  console.log(`    Trades/Day:   ${(metrics.totalTrades / days).toFixed(1)}`);
  console.log('');
  console.log('  Risk:');
  console.log(`    Peak Equity:  ${peakEquity.toFixed(4)} SOL`);
  console.log(`    Max Drawdown: ${maxDdSol.toFixed(4)} SOL (${maxDdPct.toFixed(1)}%)`);
  console.log(`    Bust:         ${finalEquity <= 0 ? 'YES — ACCOUNT BLOWN' : 'NO'}`);

  // Monthly breakdown
  console.log('');
  console.log('  Monthly Breakdown:');
  console.log('  ──────────────────────────────────────');
  for (const [month, data] of Object.entries(monthlyPnl)) {
    const pnl = data.end - data.start;
    const pnlPct = data.start > 0 ? ((data.end / data.start) - 1) * 100 : 0;
    const sign = pnl >= 0 ? '+' : '';
    console.log(`    ${month}:  ${sign}${pnl.toFixed(4)} SOL (${sign}${pnlPct.toFixed(1)}%)  equity=${data.end.toFixed(4)}`);
  }

  // Weekly equity curve (sampled)
  console.log('');
  console.log('  Equity Curve (weekly samples):');
  console.log('  ──────────────────────────────────────');
  let lastWeekTs = 0;
  for (const point of equityCurve) {
    if (point.ts - lastWeekTs >= 7 * 24 * 3600) {
      const date = new Date(point.ts * 1000).toISOString().slice(0, 10);
      const eqUsdc = point.equity * point.price;
      const bar = '█'.repeat(Math.max(1, Math.round(point.equity / BALANCE_SOL * 20)));
      console.log(`    ${date}  ${point.equity.toFixed(4)} SOL ($${eqUsdc.toFixed(2)})  ${bar}`);
      lastWeekTs = point.ts;
    }
  }
  // Always show final
  const last = equityCurve[equityCurve.length - 1];
  if (last) {
    const date = new Date(last.ts * 1000).toISOString().slice(0, 10);
    const eqUsdc = last.equity * last.price;
    const bar = '█'.repeat(Math.max(1, Math.round(last.equity / BALANCE_SOL * 20)));
    console.log(`    ${date}  ${last.equity.toFixed(4)} SOL ($${eqUsdc.toFixed(2)})  ${bar} ← FINAL`);
  }

  console.log('');
  console.log('═'.repeat(80));

  strategy.stop();
}

main();
