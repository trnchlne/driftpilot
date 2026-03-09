/**
 * Backtest: portfolio TP rule for R-fast.
 * Fine-grained sweep to find optimal TP% threshold.
 *
 * Portfolio TP = trade P&L as % of TOTAL portfolio equity (not just margin/Kelly).
 * With 30% Kelly + 10x leverage, position = 300% of equity.
 * So 1% portfolio gain = 0.33% price move.
 *
 * Usage: npx tsx src/backtest-portfolio-tp.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import { STRATEGIES } from './strategies.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';
import { SOL_FEED_ID } from './feed.js';

/* ─── Config ─────────────────────────────────────────────── */

const DATA_PATH = resolve(process.env.DATA || 'data/history-2y.jsonl');
const LAST_N_DAYS = parseInt(process.env.DAYS || '730');

const BALANCE_USDC = 27.51;
const SOL_PRICE_APPROX = 86;
const BALANCE_SOL = BALANCE_USDC / SOL_PRICE_APPROX;
const LEVERAGE = 10;
const KELLY = 0.30;
const FIXED_BET = Math.floor(BALANCE_SOL * KELLY * 100) / 100;
const FIXED_POSITION = FIXED_BET * LEVERAGE;

// Fine sweep: 0 (no TP), then 1% to 30% in 1% steps
const TP_THRESHOLDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30];

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

/* ─── Run One Backtest ───────────────────────────────────── */

interface TradeInfo {
  direction: string;
  entryPrice: number;
  exitPrice: number;
  pnlSol: number;
  pnlPctOfPortfolio: number;
  reason: string;
  holdSec: number;
}

interface BacktestResult {
  tpPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnlSol: number;
  roiPct: number;
  maxDdPct: number;
  sharpe: number;
  profitFactor: number;
  portfolioTpHits: number;
  trades: TradeInfo[];
}

function runBacktest(ticks: Tick[], tpPct: number): BacktestResult {
  const config = STRATEGIES.find(s => s.name === 'R-fast');
  if (!config) throw new Error('R-fast not found');

  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: BALANCE_SOL });
  const strategy = new RegimeStrategy(config as any);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  let portfolioTpHits = 0;
  const allTrades: TradeInfo[] = [];

  (strategy as any).enter = function(direction: any, price: number, now: number, regime: any, feeRate: number) {
    this.entryPrice = price;
    this.entryDirection = direction;
    this.entryTickTime = now;
    this.entryRegime = regime;
    this.bestPriceSinceEntry = price;
    this.entryRollingMean = this.rollingMean;
    this.entryScaledAtr = this.scaledAtr(this.config.meanWindowSeconds / 60);
    this.lastTrailCheckTime = now;
    this.bankroll?.reserveCapital(FIXED_BET);
    this.paper.openPaper(direction, price, FIXED_POSITION, feeRate, now);
    this.paper.saveEntryRegime(regime);
  };

  (strategy as any).exit = function(price: number, now: number, feeRate: number, reason: string) {
    if (!this.paper.inPosition) return;
    const trade = this.paper.closePaper(price, feeRate, now);
    if (!trade) return;
    this.bankroll?.releaseCapital(FIXED_BET);

    const pnlPct = (trade.netPnlSol / BALANCE_SOL) * 100;
    allTrades.push({
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      pnlSol: trade.netPnlSol,
      pnlPctOfPortfolio: pnlPct,
      reason,
      holdSec: now - this.entryTickTime,
    });

    this.lastTradeInfo = {
      direction: trade.direction, entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice, holdSec: now - this.entryTickTime,
      netPnl: trade.netPnlSol, reason, atrAtExit: this.atrPct, trailPctAtExit: 0,
    };
  };

  const origLog = console.log;
  console.log = () => {};

  for (const tick of ticks) {
    bankroll.updateSolPrice(tick.price);
    strategy.onTick(tick);

    // Portfolio TP check — SOL ticks only
    if (tpPct > 0 && tick.feedId === SOL_FEED_ID && (strategy as any).paper.inPosition) {
      const entryPrice = (strategy as any).entryPrice;
      const direction = (strategy as any).entryDirection;

      const pnlUsd = direction === 'long'
        ? FIXED_POSITION * (tick.price - entryPrice)
        : FIXED_POSITION * (entryPrice - tick.price);
      const pnlSol = tick.price > 0 ? pnlUsd / tick.price : 0;
      const pnlPctOfPortfolio = (pnlSol / BALANCE_SOL) * 100;

      if (pnlPctOfPortfolio >= tpPct) {
        portfolioTpHits++;
        (strategy as any).exit(tick.price, tick.publishTime, 0.0002, 'portfolio-TP');
      }
    }
  }

  console.log = origLog;

  const netPnlSol = allTrades.reduce((s, t) => s + t.pnlSol, 0);
  const roiPct = (netPnlSol / BALANCE_SOL) * 100;
  const wins = allTrades.filter(t => t.pnlSol > 0).length;
  const losses = allTrades.filter(t => t.pnlSol <= 0).length;
  const grossWin = allTrades.filter(t => t.pnlSol > 0).reduce((s, t) => s + t.pnlSol, 0);
  const grossLoss = Math.abs(allTrades.filter(t => t.pnlSol <= 0).reduce((s, t) => s + t.pnlSol, 0));

  const returns = allTrades.map(t => t.pnlSol);
  const mean = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const variance = returns.length > 0 ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length : 0;
  const sharpe = Math.sqrt(variance) > 0 ? mean / Math.sqrt(variance) : 0;

  let peak = 0, cumPnl = 0, maxDd = 0;
  for (const t of allTrades) {
    cumPnl += t.pnlSol;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDd) maxDd = dd;
  }
  const maxDdPct = (maxDd / BALANCE_SOL) * 100;

  strategy.stop();

  return {
    tpPct,
    totalTrades: allTrades.length,
    wins, losses,
    winRate: allTrades.length > 0 ? (wins / allTrades.length) * 100 : 0,
    netPnlSol, roiPct, maxDdPct, sharpe,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    portfolioTpHits,
    trades: allTrades,
  };
}

/* ─── Multi-period validation ────────────────────────────── */

function runPeriod(allTicks: Tick[], days: number, tpPct: number): BacktestResult {
  const lastTs = allTicks[allTicks.length - 1].publishTime;
  const startTs = lastTs - (days * 86400);
  const ticks = allTicks.filter(t => t.publishTime >= startTs);
  return runBacktest(ticks, tpPct);
}

/* ─── Main ───────────────────────────────────────────────── */

function main(): void {
  console.log(`Loading data from ${DATA_PATH}...`);
  const allTicks = loadTicks(DATA_PATH);
  const lastTs = allTicks[allTicks.length - 1].publishTime;
  const startTs = lastTs - (LAST_N_DAYS * 86400);
  const ticks = allTicks.filter(t => t.publishTime >= startTs);
  const solTicks = ticks.filter(t => t.feedId === SOL_FEED_ID);

  const firstPrice = solTicks[0]?.price ?? 0;
  const lastPrice = solTicks[solTicks.length - 1]?.price ?? 0;

  console.log(`${ticks.length.toLocaleString()} ticks over ${LAST_N_DAYS} days`);
  console.log(`SOL: $${firstPrice.toFixed(2)} → $${lastPrice.toFixed(2)} (${(((lastPrice/firstPrice)-1)*100).toFixed(1)}%)`);
  console.log(`Balance: ${BALANCE_SOL.toFixed(4)} SOL ($${BALANCE_USDC}), 10x leverage, 30% Kelly`);
  console.log(`Fixed position: ${FIXED_POSITION.toFixed(2)} SOL (${FIXED_BET.toFixed(2)} margin × ${LEVERAGE}x)`);
  console.log('');
  console.log(`NOTE: TP% is relative to TOTAL PORTFOLIO equity.`);
  console.log(`  With 30% Kelly × 10x = 300% exposure, a 1% portfolio gain = ~0.33% price move.`);
  console.log(`  25% portfolio TP ≈ 8.3% price move in your favor.`);
  console.log('');

  // ── Phase 1: Full 180-day sweep ──────────────────────────
  const results: BacktestResult[] = [];

  for (const tp of TP_THRESHOLDS) {
    const label = tp === 0 ? 'no TP' : `${tp}%`;
    process.stdout.write(`  R-fast @ ${label.padEnd(6)}...`);
    const r = runBacktest(ticks, tp);
    results.push(r);
    process.stdout.write(` ${String(r.totalTrades).padStart(3)} trades, ${String(r.portfolioTpHits).padStart(2)} TP hits, ROI ${r.roiPct >= 0 ? '+' : ''}${r.roiPct.toFixed(1)}%\n`);
  }

  const baseline = results[0];

  console.log('');
  console.log('═'.repeat(95));
  console.log(`  R-fast — PORTFOLIO TP OPTIMIZATION (${LAST_N_DAYS} days, fixed sizing)`);
  console.log('═'.repeat(95));

  // Distribution
  const pnlPcts = baseline.trades.map(t => t.pnlPctOfPortfolio).sort((a, b) => a - b);
  if (pnlPcts.length > 0) {
    const pctl = (p: number) => pnlPcts[Math.floor(pnlPcts.length * p / 100)] ?? 0;
    console.log('');
    console.log('  Baseline trade P&L distribution (% of portfolio):');
    console.log(`    P5: ${pctl(5).toFixed(1)}% | P25: ${pctl(25).toFixed(1)}% | P50: ${pctl(50).toFixed(1)}% | P75: ${pctl(75).toFixed(1)}% | P95: ${pctl(95).toFixed(1)}% | Max: ${pnlPcts[pnlPcts.length-1].toFixed(1)}%`);
  }

  // Table
  console.log('');
  const h = (s: string, w: number) => s.padStart(w);
  console.log(`  ${h('TP%', 6)} ${h('ROI', 10)} ${h('PnL SOL', 10)} ${h('Trades', 7)} ${h('WinR', 7)} ${h('Sharpe', 8)} ${h('PF', 6)} ${h('MaxDD', 8)} ${h('TP Hits', 8)} ${h('vs Base', 10)}`);
  console.log(`  ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(10)}`);

  let bestResult = baseline;
  for (const r of results) {
    const label = r.tpPct === 0 ? 'none' : `${r.tpPct}%`;
    const delta = r.roiPct - baseline.roiPct;
    const deltaStr = r.tpPct === 0 ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
    const marker = r.roiPct > bestResult.roiPct ? ' ★' : '';
    if (r.roiPct > bestResult.roiPct) bestResult = r;
    console.log(
      `  ${h(label, 6)} ${h(`${r.roiPct >= 0 ? '+' : ''}${r.roiPct.toFixed(1)}%`, 10)} ${h(`${r.netPnlSol >= 0 ? '+' : ''}${r.netPnlSol.toFixed(4)}`, 10)} ${h(`${r.totalTrades}`, 7)} ${h(`${r.winRate.toFixed(0)}%`, 7)} ${h(r.sharpe.toFixed(3), 8)} ${h(r.profitFactor >= 999 ? 'Inf' : r.profitFactor.toFixed(2), 6)} ${h(`${r.maxDdPct.toFixed(1)}%`, 8)} ${h(`${r.portfolioTpHits}`, 8)} ${h(deltaStr, 10)}${marker}`
    );
  }

  console.log('');
  if (bestResult.tpPct === 0) {
    console.log('  WINNER: No TP (baseline is best)');
  } else {
    console.log(`  WINNER: ${bestResult.tpPct}% portfolio TP (+${(bestResult.roiPct - baseline.roiPct).toFixed(1)}% vs baseline)`);
  }

  // ── Phase 2: Top candidates across all time periods ──────
  const candidates = [0, 4, 5, 6, 7, 8, 10];
  const periods = [30, 60, 90, 120, 180, 365, LAST_N_DAYS].filter((v, i, a) => a.indexOf(v) === i && v <= LAST_N_DAYS);

  console.log('');
  console.log('═'.repeat(95));
  console.log('  MULTI-PERIOD VALIDATION: top TP candidates vs baseline');
  console.log('═'.repeat(95));
  console.log('');

  // Header
  const colW = 10;
  process.stdout.write('  ' + 'Period'.padEnd(8));
  for (const tp of candidates) {
    const label = tp === 0 ? 'No TP' : `${tp}% TP`;
    process.stdout.write(label.padStart(colW));
  }
  console.log('');
  process.stdout.write('  ' + '─'.repeat(8));
  for (const _ of candidates) process.stdout.write('─'.repeat(colW));
  console.log('');

  // Track wins per candidate
  const winsPerCandidate: Record<number, number> = {};
  for (const tp of candidates) winsPerCandidate[tp] = 0;

  for (const days of periods) {
    process.stdout.write(`  ${(days + 'd').padEnd(8)}`);
    const baseResult = runPeriod(allTicks, days, 0);
    for (const tp of candidates) {
      const r = tp === 0 ? baseResult : runPeriod(allTicks, days, tp);
      const roi = `${r.roiPct >= 0 ? '+' : ''}${r.roiPct.toFixed(1)}%`;
      const better = tp > 0 && r.roiPct > baseResult.roiPct;
      if (better) winsPerCandidate[tp]++;
      if (tp === 0) winsPerCandidate[tp] = -1; // skip baseline
      process.stdout.write(roi.padStart(colW));
    }
    console.log('');
  }

  // Summary row
  process.stdout.write('  ' + '─'.repeat(8));
  for (const _ of candidates) process.stdout.write('─'.repeat(colW));
  console.log('');
  process.stdout.write('  ' + 'Wins'.padEnd(8));
  for (const tp of candidates) {
    const label = tp === 0 ? '—' : `${winsPerCandidate[tp]}/${periods.length}`;
    process.stdout.write(label.padStart(colW));
  }
  console.log('');

  // Average ROI across periods
  process.stdout.write('  ' + 'Avg ROI'.padEnd(8));
  for (const tp of candidates) {
    let totalRoi = 0;
    for (const days of periods) {
      const r = runPeriod(allTicks, days, tp);
      totalRoi += r.roiPct;
    }
    const avg = totalRoi / periods.length;
    process.stdout.write(`${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%`.padStart(colW));
  }
  console.log('');

  console.log('');
  console.log('═'.repeat(95));
}

main();
