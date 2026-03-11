/**
 * Grid search over R-base trending parameters on 14d data.
 * Keeps ranging params fixed (they're working), sweeps:
 *   - trailingAtrMultiple (trail width)
 *   - signalMultiple (entry bar)
 *   - signalWindowSeconds (breakout window)
 *   - trailDelaySeconds (delay before trail activates)
 *   - slAtrMultiple (stop loss width)
 *
 * Usage: npx tsx src/backtest-trend-grid.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import type { StrategyConfig } from './strategies.js';
import { STRATEGIES } from './strategies.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';

/* ─── Config ─────────────────────────────────────────────── */

const BALANCE_USDC = 20;
const SOL_PRICE_APPROX = 87;
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

/* ─── Run Single Config ──────────────────────────────────── */

interface Result {
  trail: number;
  signal: number;
  signalWin: number;
  trailDelay: number;
  sl: number;
  trades: number;
  wins: number;
  losses: number;
  wr: number;
  pnlSol: number;
  roiPct: number;
  pf: number;
  sharpe: number;
  maxDdPct: number;
  trendTrades: number;
  trendWr: number;
  trendPnl: number;
  rangeTrades: number;
  rangeWr: number;
  rangePnl: number;
  avgHoldMin: number;
  tradesPerDay: number;
}

function runConfig(ticks: Tick[], overrides: Partial<StrategyConfig & { type: 'regime' }>): Result {
  const baseConfig = STRATEGIES.find(s => s.name === 'R-base')! as StrategyConfig & { type: 'regime' };
  const config = { ...baseConfig, ...overrides, name: 'grid-test' };

  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: BALANCE_SOL });
  const strategy = new RegimeStrategy(config as any);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  let peakEquity = BALANCE_SOL;
  let maxDdPct = 0;

  // Track per-regime stats
  let trendTrades = 0, trendWins = 0, trendPnl = 0;
  let rangeTrades = 0, rangeWins = 0, rangePnl = 0;
  let totalHoldSec = 0;

  // Patch enter for leveraged sizing
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

  // Patch exit for leveraged sizing + regime tracking
  (strategy as any).exit = function(price: number, now: number, feeRate: number, reason: string) {
    if (!this.paper.inPosition) return;
    const regime = this.entryRegime;
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

    totalHoldSec += now - this.entryTickTime;

    if (regime === 'TRENDING' || regime === 'UNCERTAIN') {
      trendTrades++;
      if (trade.netPnlSol > 0) trendWins++;
      trendPnl += trade.netPnlSol;
    } else {
      rangeTrades++;
      if (trade.netPnlSol > 0) rangeWins++;
      rangePnl += trade.netPnlSol;
    }
  };

  const origLog = console.log;
  console.log = () => {};

  for (const tick of ticks) {
    bankroll.updateSolPrice(tick.price);
    strategy.onTick(tick);
    const eq = bankroll.getEquity();
    if (eq > peakEquity) peakEquity = eq;
    const dd = peakEquity > 0 ? ((peakEquity - eq) / peakEquity) * 100 : 0;
    if (dd > maxDdPct) maxDdPct = dd;
  }

  console.log = origLog;
  strategy.stop();

  const finalEquity = bankroll.getEquity();
  const metrics = strategy.getMetrics();
  const hours = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 3600;
  const totalTrades = trendTrades + rangeTrades;

  // Profit factor
  const trades = (strategy as any).paper?.trades ?? [];
  const grossWin = trades.filter((t: any) => t.netPnlSol > 0).reduce((s: number, t: any) => s + t.netPnlSol, 0);
  const grossLoss = Math.abs(trades.filter((t: any) => t.netPnlSol <= 0).reduce((s: number, t: any) => s + t.netPnlSol, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;

  return {
    trail: config.trailingAtrMultiple,
    signal: config.signalMultiple,
    signalWin: config.signalWindowSeconds / 60,
    trailDelay: config.trailDelaySeconds,
    sl: config.slAtrMultiple,
    trades: totalTrades,
    wins: trendWins + rangeWins,
    losses: totalTrades - trendWins - rangeWins,
    wr: totalTrades > 0 ? ((trendWins + rangeWins) / totalTrades) * 100 : 0,
    pnlSol: finalEquity - BALANCE_SOL,
    roiPct: ((finalEquity / BALANCE_SOL) - 1) * 100,
    pf,
    sharpe: metrics.sharpe,
    maxDdPct,
    trendTrades,
    trendWr: trendTrades > 0 ? (trendWins / trendTrades) * 100 : 0,
    trendPnl,
    rangeTrades,
    rangeWr: rangeTrades > 0 ? (rangeWins / rangeTrades) * 100 : 0,
    rangePnl,
    avgHoldMin: totalTrades > 0 ? (totalHoldSec / totalTrades / 60) : 0,
    tradesPerDay: hours > 0 ? totalTrades / (hours / 24) : 0,
  };
}

/* ─── Main ───────────────────────────────────────────────── */

function main() {
  const dataPath = resolve('data/history-14d.jsonl');
  console.log(`[grid] Loading ${dataPath}...`);
  const ticks = loadTicks(dataPath);

  const hours = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 3600;
  const firstPrice = ticks[0].price;
  const lastPrice = ticks[ticks.length - 1].price;
  console.log(`[grid] ${ticks.length} ticks, ${hours.toFixed(0)}h, SOL $${firstPrice.toFixed(2)} → $${lastPrice.toFixed(2)}`);

  // Grid sweep — trending params only
  const trailValues =      [0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5];
  const signalValues =     [3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 7.0];
  const signalWinValues =  [20, 25, 30, 40];        // minutes
  const trailDelayValues = [300, 480, 600, 900];     // seconds
  const slValues =         [1.0, 1.5, 2.0, 2.5];

  const totalCombos = trailValues.length * signalValues.length * signalWinValues.length * trailDelayValues.length * slValues.length;
  console.log(`[grid] ${totalCombos} combinations to test`);

  const results: Result[] = [];
  let count = 0;
  const t0 = Date.now();

  for (const trail of trailValues) {
    for (const signal of signalValues) {
      for (const signalWin of signalWinValues) {
        for (const trailDelay of trailDelayValues) {
          for (const sl of slValues) {
            const r = runConfig(ticks, {
              trailingAtrMultiple: trail,
              signalMultiple: signal,
              signalWindowSeconds: signalWin * 60,
              trailDelaySeconds: trailDelay,
              slAtrMultiple: sl,
            } as any);
            results.push(r);
            count++;
            if (count % 100 === 0) {
              process.stdout.write(`\r[grid] ${count}/${totalCombos} (${((count / totalCombos) * 100).toFixed(0)}%)`);
            }
          }
        }
      }
    }
  }

  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\r[grid] ${totalCombos} combos complete in ${elapsed.toFixed(1)}s`);

  // Filter to configs with >= 5 trades (enough signal)
  const valid = results.filter(r => r.trades >= 5);

  // ─── Sort by ROI and show top 30 ───
  const byRoi = [...valid].sort((a, b) => b.roiPct - a.roiPct);

  console.log('');
  console.log('═'.repeat(160));
  console.log('  TOP 30 BY ROI%');
  console.log('═'.repeat(160));
  console.log('  Rank  Trail  Signal  SigWin  Delay   SL    Trades  WR     ROI%    PnL SOL     PF     MaxDD%  TrdTr WR%   TrdPnl    RngTr WR%   RngPnl    AvgH  T/Day');
  console.log('  ' + '─'.repeat(155));

  for (let i = 0; i < Math.min(30, byRoi.length); i++) {
    const r = byRoi[i];
    printRow(i + 1, r);
  }

  // ─── Sort by Sharpe ───
  const bySharpe = [...valid].filter(r => r.trades >= 8).sort((a, b) => b.sharpe - a.sharpe);

  console.log('');
  console.log('═'.repeat(160));
  console.log('  TOP 20 BY SHARPE (min 8 trades)');
  console.log('═'.repeat(160));
  console.log('  Rank  Trail  Signal  SigWin  Delay   SL    Trades  WR     ROI%    PnL SOL     PF     MaxDD%  TrdTr WR%   TrdPnl    RngTr WR%   RngPnl    AvgH  T/Day');
  console.log('  ' + '─'.repeat(155));

  for (let i = 0; i < Math.min(20, bySharpe.length); i++) {
    const r = bySharpe[i];
    printRow(i + 1, r);
  }

  // ─── Sort by PF (profit factor) ───
  const byPf = [...valid].filter(r => r.trades >= 8 && r.pf < 90).sort((a, b) => b.pf - a.pf);

  console.log('');
  console.log('═'.repeat(160));
  console.log('  TOP 20 BY PROFIT FACTOR (min 8 trades)');
  console.log('═'.repeat(160));
  console.log('  Rank  Trail  Signal  SigWin  Delay   SL    Trades  WR     ROI%    PnL SOL     PF     MaxDD%  TrdTr WR%   TrdPnl    RngTr WR%   RngPnl    AvgH  T/Day');
  console.log('  ' + '─'.repeat(155));

  for (let i = 0; i < Math.min(20, byPf.length); i++) {
    const r = byPf[i];
    printRow(i + 1, r);
  }

  // ─── ROI/MaxDD ratio (risk-adjusted) ───
  const byRiskAdj = [...valid].filter(r => r.trades >= 8 && r.maxDdPct > 0)
    .sort((a, b) => (b.roiPct / b.maxDdPct) - (a.roiPct / a.maxDdPct));

  console.log('');
  console.log('═'.repeat(160));
  console.log('  TOP 20 BY ROI/MaxDD RATIO (min 8 trades)');
  console.log('═'.repeat(160));
  console.log('  Rank  Trail  Signal  SigWin  Delay   SL    Trades  WR     ROI%    PnL SOL     PF     MaxDD%  TrdTr WR%   TrdPnl    RngTr WR%   RngPnl    AvgH  T/Day');
  console.log('  ' + '─'.repeat(155));

  for (let i = 0; i < Math.min(20, byRiskAdj.length); i++) {
    const r = byRiskAdj[i];
    printRow(i + 1, r);
  }

  // ─── Current config for comparison ───
  const current = results.find(r =>
    r.trail === 0.8 && r.signal === 4.5 && r.signalWin === 25 && r.trailDelay === 300 && r.sl === 1.0
  );

  console.log('');
  console.log('═'.repeat(160));
  console.log('  CURRENT R-BASE CONFIG vs BEST');
  console.log('═'.repeat(160));

  if (current) {
    console.log('  Current: trail=0.8 signal=4.5 win=25m delay=300s sl=1.0');
    console.log(`           ${current.trades} trades, ${current.wr.toFixed(1)}% WR, ${current.roiPct >= 0 ? '+' : ''}${current.roiPct.toFixed(1)}% ROI, PF ${current.pf.toFixed(2)}, MaxDD ${current.maxDdPct.toFixed(1)}%`);
    console.log(`           Trending: ${current.trendTrades} trades (${current.trendWr.toFixed(0)}% WR, ${current.trendPnl >= 0 ? '+' : ''}${current.trendPnl.toFixed(6)} SOL)`);
    console.log(`           Ranging:  ${current.rangeTrades} trades (${current.rangeWr.toFixed(0)}% WR, ${current.rangePnl >= 0 ? '+' : ''}${current.rangePnl.toFixed(6)} SOL)`);
  }

  const best = byRoi[0];
  if (best) {
    console.log('');
    console.log(`  Best:    trail=${best.trail} signal=${best.signal} win=${best.signalWin}m delay=${best.trailDelay}s sl=${best.sl}`);
    console.log(`           ${best.trades} trades, ${best.wr.toFixed(1)}% WR, ${best.roiPct >= 0 ? '+' : ''}${best.roiPct.toFixed(1)}% ROI, PF ${best.pf.toFixed(2)}, MaxDD ${best.maxDdPct.toFixed(1)}%`);
    console.log(`           Trending: ${best.trendTrades} trades (${best.trendWr.toFixed(0)}% WR, ${best.trendPnl >= 0 ? '+' : ''}${best.trendPnl.toFixed(6)} SOL)`);
    console.log(`           Ranging:  ${best.rangeTrades} trades (${best.rangeWr.toFixed(0)}% WR, ${best.rangePnl >= 0 ? '+' : ''}${best.rangePnl.toFixed(6)} SOL)`);
  }

  // ─── Parameter sensitivity analysis ───
  console.log('');
  console.log('═'.repeat(100));
  console.log('  PARAMETER SENSITIVITY (avg ROI% across all combos with this value)');
  console.log('═'.repeat(100));

  for (const [paramName, values] of [
    ['trail', trailValues],
    ['signal', signalValues],
    ['signalWin', signalWinValues],
    ['trailDelay', trailDelayValues],
    ['sl', slValues],
  ] as const) {
    const header = `  ${String(paramName).padEnd(12)}`;
    let line = header;
    for (const v of values) {
      const subset = valid.filter(r => r[paramName] === v);
      const avgRoi = subset.length > 0 ? subset.reduce((s, r) => s + r.roiPct, 0) / subset.length : 0;
      const avgTrades = subset.length > 0 ? subset.reduce((s, r) => s + r.trades, 0) / subset.length : 0;
      line += `  ${v}→${avgRoi >= 0 ? '+' : ''}${avgRoi.toFixed(1)}%(${avgTrades.toFixed(0)}t)`.padEnd(18);
    }
    console.log(line);
  }

  console.log('');
}

function printRow(rank: number, r: Result) {
  const rk = `#${rank}`.padStart(4);
  const trail = r.trail.toFixed(1).padStart(5);
  const signal = r.signal.toFixed(1).padStart(5);
  const sigWin = `${r.signalWin}m`.padStart(5);
  const delay = `${r.trailDelay}`.padStart(5);
  const sl = r.sl.toFixed(1).padStart(5);
  const trades = String(r.trades).padStart(5);
  const wr = `${r.wr.toFixed(1)}%`.padStart(6);
  const roi = `${r.roiPct >= 0 ? '+' : ''}${r.roiPct.toFixed(1)}%`.padStart(7);
  const pnl = `${r.pnlSol >= 0 ? '+' : ''}${r.pnlSol.toFixed(6)}`.padStart(11);
  const pf = r.pf >= 90 ? '   Inf' : r.pf.toFixed(2).padStart(6);
  const dd = `${r.maxDdPct.toFixed(1)}%`.padStart(6);
  const trdTr = String(r.trendTrades).padStart(4);
  const trdWr = `${r.trendWr.toFixed(0)}%`.padStart(4);
  const trdPnl = `${r.trendPnl >= 0 ? '+' : ''}${r.trendPnl.toFixed(4)}`.padStart(9);
  const rngTr = String(r.rangeTrades).padStart(4);
  const rngWr = `${r.rangeWr.toFixed(0)}%`.padStart(4);
  const rngPnl = `${r.rangePnl >= 0 ? '+' : ''}${r.rangePnl.toFixed(4)}`.padStart(9);
  const avgH = `${r.avgHoldMin.toFixed(0)}m`.padStart(5);
  const tpd = r.tradesPerDay.toFixed(1).padStart(5);

  console.log(`  ${rk}  ${trail}   ${signal}   ${sigWin}  ${delay}  ${sl}   ${trades}  ${wr}  ${roi}  ${pnl}  ${pf}  ${dd}  ${trdTr} ${trdWr}  ${trdPnl}  ${rngTr} ${rngWr}  ${rngPnl}  ${avgH}  ${tpd}`);
}

main();
