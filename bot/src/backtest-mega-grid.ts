/**
 * Comprehensive regime parameter search — random sampling across ALL parameters.
 * Tests extreme ranges from minutes to days.
 *
 * Stage 1: 8000 random samples on 90d data
 * Stage 2: Fine grid around top 20 winners
 * Stage 3: Validate top candidates on 30d and 14d subsets
 *
 * Usage: npx tsx src/backtest-mega-grid.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import type { StrategyConfig } from './strategies.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';

const BALANCE_USDC = 20;
const SOL_PRICE_APPROX = 130; // approx mid-period price
const BALANCE_SOL = BALANCE_USDC / SOL_PRICE_APPROX;
const LEVERAGE = 10;

/* ─── Data ───────────────────────────────────────────────── */

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

/* ─── Parameter Ranges (minutes to days) ─────────────────── */

interface ParamSet {
  atrPeriod: number;           // minutes
  regimeWindowSeconds: number; // seconds
  trendThreshold: number;
  rangeThreshold: number;
  signalWindowSeconds: number; // seconds
  signalMultiple: number;
  trailingAtrMultiple: number;
  slAtrMultiple: number;
  trailDelaySeconds: number;
  meanWindowSeconds: number;   // seconds
  entryBandMultiple: number;
  reversionSlMultiple: number;
  cooldownSeconds: number;
  minAtrPct: number;
  uncertainMultiple: number;
}

// Discrete value pools for random sampling — from minutes to days
const RANGES = {
  atrPeriod:           [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360],
  regimeWindowSec:     [30*60, 1*3600, 2*3600, 4*3600, 6*3600, 8*3600, 12*3600, 24*3600],
  trendThreshold:      [0.3, 0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0],
  rangeThreshold:      [0.2, 0.3, 0.5, 0.8, 1.0, 1.2, 1.5, 2.0],
  signalWindowSec:     [3*60, 5*60, 10*60, 15*60, 20*60, 30*60, 40*60, 60*60, 90*60, 120*60],
  signalMultiple:      [1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 7.0, 8.0],
  trailingAtrMultiple: [0.3, 0.5, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0],
  slAtrMultiple:       [0.5, 0.8, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0],
  trailDelaySec:       [0, 30, 60, 120, 180, 300, 480, 600, 900, 1200, 1800],
  meanWindowSec:       [5*60, 10*60, 15*60, 30*60, 1*3600, 2*3600, 4*3600, 8*3600, 12*3600, 24*3600],
  entryBandMultiple:   [0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0],
  reversionSlMultiple: [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0],
  cooldownSec:         [0, 30, 60, 120, 180, 300, 600, 900, 1800],
  minAtrPct:           [0, 0.01, 0.02, 0.035, 0.05, 0.08, 0.10],
  uncertainMultiple:   [0.5, 0.8, 1.0, 1.2, 1.5, 2.0],
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomParams(): ParamSet {
  return {
    atrPeriod: pick(RANGES.atrPeriod),
    regimeWindowSeconds: pick(RANGES.regimeWindowSec),
    trendThreshold: pick(RANGES.trendThreshold),
    rangeThreshold: pick(RANGES.rangeThreshold),
    signalWindowSeconds: pick(RANGES.signalWindowSec),
    signalMultiple: pick(RANGES.signalMultiple),
    trailingAtrMultiple: pick(RANGES.trailingAtrMultiple),
    slAtrMultiple: pick(RANGES.slAtrMultiple),
    trailDelaySeconds: pick(RANGES.trailDelaySec),
    meanWindowSeconds: pick(RANGES.meanWindowSec),
    entryBandMultiple: pick(RANGES.entryBandMultiple),
    reversionSlMultiple: pick(RANGES.reversionSlMultiple),
    cooldownSeconds: pick(RANGES.cooldownSec),
    minAtrPct: pick(RANGES.minAtrPct),
    uncertainMultiple: pick(RANGES.uncertainMultiple),
  };
}

/* ─── Runner ─────────────────────────────────────────────── */

interface Result {
  params: ParamSet;
  trades: number;
  wins: number;
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

function runParams(ticks: Tick[], p: ParamSet, balanceSol: number): Result {
  const config = {
    type: 'regime' as const,
    name: 'test',
    atrPeriod: p.atrPeriod,
    regimeWindowSeconds: p.regimeWindowSeconds,
    trendThreshold: p.trendThreshold,
    rangeThreshold: p.rangeThreshold,
    signalWindowSeconds: p.signalWindowSeconds,
    signalMultiple: p.signalMultiple,
    trailingAtrMultiple: p.trailingAtrMultiple,
    slAtrMultiple: p.slAtrMultiple,
    trailDelaySeconds: p.trailDelaySeconds,
    meanWindowSeconds: p.meanWindowSeconds,
    entryBandMultiple: p.entryBandMultiple,
    reversionSlMultiple: p.reversionSlMultiple,
    cooldownSeconds: p.cooldownSeconds,
    betSizeSol: 1.0,
    minAtrPct: p.minAtrPct,
    uncertainMultiple: p.uncertainMultiple,
  };

  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: balanceSol });
  const strategy = new RegimeStrategy(config as any);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  let peakEquity = balanceSol;
  let maxDdPct = 0;
  let trendTrades = 0, trendWins = 0, trendPnl = 0;
  let rangeTrades = 0, rangeWins = 0, rangePnl = 0;
  let totalHoldSec = 0;
  let totalTrades = 0;

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
    totalTrades++;

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
  const hours = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 3600;
  const wins = trendWins + rangeWins;

  const trades = (strategy as any).paper?.trades ?? [];
  const grossWin = trades.filter((t: any) => t.netPnlSol > 0).reduce((s: number, t: any) => s + t.netPnlSol, 0);
  const grossLoss = Math.abs(trades.filter((t: any) => t.netPnlSol <= 0).reduce((s: number, t: any) => s + t.netPnlSol, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;

  // Sharpe
  const pnls = trades.map((t: any) => t.netPnlSol);
  let sharpe = 0;
  if (pnls.length > 1) {
    const mean = pnls.reduce((a: number, b: number) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((s: number, p: number) => s + (p - mean) ** 2, 0) / (pnls.length - 1);
    const std = Math.sqrt(variance);
    if (std > 0) sharpe = (mean / std) * Math.sqrt(pnls.length);
  }

  return {
    params: p,
    trades: totalTrades,
    wins,
    wr: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    pnlSol: finalEquity - balanceSol,
    roiPct: ((finalEquity / balanceSol) - 1) * 100,
    pf,
    sharpe,
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

/* ─── Formatting ─────────────────────────────────────────── */

function fmtTime(sec: number): string {
  if (sec >= 86400) return `${(sec / 86400).toFixed(0)}d`;
  if (sec >= 3600) return `${(sec / 3600).toFixed(0)}h`;
  return `${(sec / 60).toFixed(0)}m`;
}

function printRow(rank: number, r: Result) {
  const p = r.params;
  const rk = `#${rank}`.padStart(4);
  const atr = `${p.atrPeriod}m`.padStart(5);
  const regime = fmtTime(p.regimeWindowSeconds).padStart(4);
  const tThr = p.trendThreshold.toFixed(1).padStart(4);
  const rThr = p.rangeThreshold.toFixed(1).padStart(4);
  const sigWin = fmtTime(p.signalWindowSeconds).padStart(5);
  const sigMul = p.signalMultiple.toFixed(1).padStart(4);
  const trail = p.trailingAtrMultiple.toFixed(1).padStart(4);
  const sl = p.slAtrMultiple.toFixed(1).padStart(4);
  const delay = fmtTime(p.trailDelaySeconds || 1).padStart(4);
  const meanW = fmtTime(p.meanWindowSeconds).padStart(5);
  const eBand = p.entryBandMultiple.toFixed(1).padStart(4);
  const revSl = p.reversionSlMultiple.toFixed(1).padStart(4);
  const cd = fmtTime(p.cooldownSeconds || 1).padStart(4);
  const minA = (p.minAtrPct * 100).toFixed(0).padStart(3);

  const trades = String(r.trades).padStart(4);
  const wr = `${r.wr.toFixed(0)}%`.padStart(4);
  const roi = `${r.roiPct >= 0 ? '+' : ''}${r.roiPct.toFixed(0)}%`.padStart(6);
  const pf = r.pf >= 90 ? ' Inf' : r.pf.toFixed(1).padStart(4);
  const dd = `${r.maxDdPct.toFixed(0)}%`.padStart(4);
  const sh = r.sharpe.toFixed(2).padStart(5);
  const tpd = r.tradesPerDay.toFixed(1).padStart(4);
  const avgH = `${r.avgHoldMin.toFixed(0)}m`.padStart(5);

  console.log(`  ${rk} ${atr} ${regime} ${tThr} ${rThr} ${sigWin} ${sigMul} ${trail}  ${sl} ${delay} ${meanW} ${eBand} ${revSl}  ${cd} ${minA}  ${trades} ${wr} ${roi}  ${pf}  ${dd} ${sh} ${tpd} ${avgH}`);
}

function printHeader() {
  console.log('  Rank  ATR  Reg tThr rThr SigWn SigM Trl   SL  Del MeanW eBnd rSL   CD  mA   #Tr  WR    ROI    PF  MDD Sharp T/D  AvgH');
  console.log('  ' + '─'.repeat(145));
}

/* ─── Main ───────────────────────────────────────────────── */

function main() {
  // Load 90d data
  const dataPath = resolve('data/history-90d.jsonl');
  console.log(`[mega] Loading ${dataPath}...`);
  const ticks90 = loadTicks(dataPath);
  const hours90 = (ticks90[ticks90.length - 1].publishTime - ticks90[0].publishTime) / 3600;
  const firstPrice = ticks90[0].price;
  const lastPrice = ticks90[ticks90.length - 1].price;
  console.log(`[mega] 90d: ${ticks90.length} ticks, ${(hours90 / 24).toFixed(0)} days, SOL $${firstPrice.toFixed(2)} → $${lastPrice.toFixed(2)} (${((lastPrice / firstPrice - 1) * 100).toFixed(1)}%)`);

  // Adjust balance for mid-period price
  const midPrice = (firstPrice + lastPrice) / 2;
  const balanceSol = BALANCE_USDC / midPrice;

  // ═══════════════════════════════════════════════════════════
  // STAGE 1: Random search — 8000 samples
  // ═══════════════════════════════════════════════════════════

  const N_SAMPLES = 8000;
  console.log(`\n[mega] STAGE 1: Random search — ${N_SAMPLES} samples on 90d data...`);
  const t0 = Date.now();

  const results: Result[] = [];

  // Also include current R-base and R-fast configs explicitly
  const rBaseParams: ParamSet = {
    atrPeriod: 90, regimeWindowSeconds: 4*3600, trendThreshold: 1.2, rangeThreshold: 1.0,
    signalWindowSeconds: 40*60, signalMultiple: 4.5, trailingAtrMultiple: 1.5, slAtrMultiple: 1.0,
    trailDelaySeconds: 300, meanWindowSeconds: 1*3600, entryBandMultiple: 2.5, reversionSlMultiple: 4.0,
    cooldownSeconds: 120, minAtrPct: 0.035, uncertainMultiple: 1.0,
  };
  const rFastParams: ParamSet = {
    atrPeriod: 30, regimeWindowSeconds: 4*3600, trendThreshold: 1.5, rangeThreshold: 0.5,
    signalWindowSeconds: 20*60, signalMultiple: 5.0, trailingAtrMultiple: 1.5, slAtrMultiple: 2.5,
    trailDelaySeconds: 300, meanWindowSeconds: 2*3600, entryBandMultiple: 1.5, reversionSlMultiple: 3.0,
    cooldownSeconds: 120, minAtrPct: 0.035, uncertainMultiple: 1.0,
  };
  // Also original R-base (pre-optimization)
  const rBaseOldParams: ParamSet = {
    ...rBaseParams, trailingAtrMultiple: 0.8, signalWindowSeconds: 25*60,
  };

  results.push(runParams(ticks90, rBaseParams, balanceSol));
  results.push(runParams(ticks90, rFastParams, balanceSol));
  results.push(runParams(ticks90, rBaseOldParams, balanceSol));

  for (let i = 0; i < N_SAMPLES; i++) {
    const p = randomParams();
    results.push(runParams(ticks90, p, balanceSol));
    if ((i + 1) % 500 === 0) {
      process.stdout.write(`\r[mega] ${i + 1}/${N_SAMPLES} (${((i + 1) / N_SAMPLES * 100).toFixed(0)}%)`);
    }
  }
  console.log(`\r[mega] ${N_SAMPLES} samples complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Filter: min 15 trades (enough signal on 90d)
  const valid = results.filter(r => r.trades >= 15);
  console.log(`[mega] ${valid.length} configs with >= 15 trades`);

  // ─── Top 40 by ROI ───
  const byRoi = [...valid].sort((a, b) => b.roiPct - a.roiPct);
  console.log('\n' + '═'.repeat(150));
  console.log('  TOP 40 BY ROI% (90 days, min 15 trades)');
  console.log('═'.repeat(150));
  printHeader();
  for (let i = 0; i < Math.min(40, byRoi.length); i++) printRow(i + 1, byRoi[i]);

  // ─── Top 30 by Sharpe ───
  const bySharpe = [...valid].filter(r => r.trades >= 25).sort((a, b) => b.sharpe - a.sharpe);
  console.log('\n' + '═'.repeat(150));
  console.log('  TOP 30 BY SHARPE (min 25 trades)');
  console.log('═'.repeat(150));
  printHeader();
  for (let i = 0; i < Math.min(30, bySharpe.length); i++) printRow(i + 1, bySharpe[i]);

  // ─── Top 30 by PF (min 25 trades) ───
  const byPf = [...valid].filter(r => r.trades >= 25 && r.pf < 90).sort((a, b) => b.pf - a.pf);
  console.log('\n' + '═'.repeat(150));
  console.log('  TOP 30 BY PROFIT FACTOR (min 25 trades)');
  console.log('═'.repeat(150));
  printHeader();
  for (let i = 0; i < Math.min(30, byPf.length); i++) printRow(i + 1, byPf[i]);

  // ─── Top 30 by ROI/MaxDD (risk-adjusted, min 20 trades) ───
  const byRisk = [...valid].filter(r => r.trades >= 20 && r.maxDdPct > 1)
    .sort((a, b) => (b.roiPct / b.maxDdPct) - (a.roiPct / a.maxDdPct));
  console.log('\n' + '═'.repeat(150));
  console.log('  TOP 30 BY ROI/MAXDD RATIO (min 20 trades, MDD>1%)');
  console.log('═'.repeat(150));
  printHeader();
  for (let i = 0; i < Math.min(30, byRisk.length); i++) printRow(i + 1, byRisk[i]);

  // ─── Show current configs ───
  console.log('\n' + '═'.repeat(150));
  console.log('  REFERENCE CONFIGS');
  console.log('═'.repeat(150));
  printHeader();
  console.log('  R-base (new):');
  printRow(0, results[0]);
  console.log('  R-fast:');
  printRow(0, results[1]);
  console.log('  R-base (old):');
  printRow(0, results[2]);

  // ═══════════════════════════════════════════════════════════
  // STAGE 2: Parameter frequency analysis in top 100
  // ═══════════════════════════════════════════════════════════

  console.log('\n' + '═'.repeat(150));
  console.log('  PARAMETER PATTERNS IN TOP 100 CONFIGS (by ROI, min 15 trades)');
  console.log('═'.repeat(150));

  const top100 = byRoi.slice(0, 100);

  const paramAnalysis: Record<string, Record<string, { count: number; avgRoi: number }>> = {};

  for (const [key, values] of Object.entries(RANGES)) {
    const paramKey = key === 'regimeWindowSec' ? 'regimeWindowSeconds'
      : key === 'signalWindowSec' ? 'signalWindowSeconds'
      : key === 'trailDelaySec' ? 'trailDelaySeconds'
      : key === 'meanWindowSec' ? 'meanWindowSeconds'
      : key === 'cooldownSec' ? 'cooldownSeconds'
      : key === 'minAtrPct' ? 'minAtrPct'
      : key;

    paramAnalysis[key] = {};
    for (const v of values) {
      const matching = top100.filter(r => {
        const pv = (r.params as any)[paramKey];
        return pv === v;
      });
      if (matching.length > 0) {
        paramAnalysis[key][String(v)] = {
          count: matching.length,
          avgRoi: matching.reduce((s, r) => s + r.roiPct, 0) / matching.length,
        };
      }
    }
  }

  for (const [param, values] of Object.entries(paramAnalysis)) {
    const sorted = Object.entries(values).sort((a, b) => b[1].count - a[1].count);
    if (sorted.length === 0) continue;
    let line = `  ${param.padEnd(22)}`;
    for (const [val, data] of sorted.slice(0, 8)) {
      const label = param.includes('Window') || param.includes('regime') || param.includes('Delay') || param.includes('cooldown') || param.includes('mean')
        ? fmtTime(Number(val))
        : val;
      line += `  ${label}:${data.count}×(${data.avgRoi >= 0 ? '+' : ''}${data.avgRoi.toFixed(0)}%)`.padEnd(18);
    }
    console.log(line);
  }

  // ═══════════════════════════════════════════════════════════
  // STAGE 3: Validate top 5 on 30d and 14d subsets
  // ═══════════════════════════════════════════════════════════

  console.log('\n' + '═'.repeat(150));
  console.log('  STAGE 3: CROSS-VALIDATION — Top 5 + references on 30d and 14d');
  console.log('═'.repeat(150));

  // Load subsets
  const ticks30 = loadTicks(resolve('data/history-30d.jsonl'));
  const ticks14 = loadTicks(resolve('data/history-14d.jsonl'));
  const hours30 = (ticks30[ticks30.length - 1].publishTime - ticks30[0].publishTime) / 3600;
  const hours14 = (ticks14[ticks14.length - 1].publishTime - ticks14[0].publishTime) / 3600;
  const bal30 = BALANCE_USDC / ticks30[Math.floor(ticks30.length / 2)].price;
  const bal14 = BALANCE_USDC / ticks14[Math.floor(ticks14.length / 2)].price;

  // Pick top 5 unique configs by ROI (skip near-duplicates)
  const top5: Result[] = [];
  for (const r of byRoi) {
    if (top5.length >= 5) break;
    // Skip if too similar to existing
    const isDupe = top5.some(e => {
      const ep = e.params, rp = r.params;
      return ep.atrPeriod === rp.atrPeriod && ep.trailingAtrMultiple === rp.trailingAtrMultiple
        && ep.signalMultiple === rp.signalMultiple && ep.signalWindowSeconds === rp.signalWindowSeconds;
    });
    if (!isDupe) top5.push(r);
  }

  // Also add top by Sharpe if different
  for (const r of bySharpe.slice(0, 3)) {
    const isDupe = top5.some(e => {
      const ep = e.params, rp = r.params;
      return ep.atrPeriod === rp.atrPeriod && ep.trailingAtrMultiple === rp.trailingAtrMultiple
        && ep.signalMultiple === rp.signalMultiple && ep.signalWindowSeconds === rp.signalWindowSeconds;
    });
    if (!isDupe && top5.length < 8) top5.push(r);
  }

  const candidates = [
    { label: 'R-base (new)', params: rBaseParams },
    { label: 'R-fast', params: rFastParams },
    { label: 'R-base (old)', params: rBaseOldParams },
    ...top5.map((r, i) => ({ label: `TOP-${i + 1}`, params: r.params })),
  ];

  // Cross-validate
  for (const { label: dataLabel, ticks: dataTicks, bal, h } of [
    { label: '90d', ticks: ticks90, bal: balanceSol, h: hours90 },
    { label: '30d', ticks: ticks30, bal: bal30, h: hours30 },
    { label: '14d', ticks: ticks14, bal: bal14, h: hours14 },
  ]) {
    console.log(`\n  ── ${dataLabel} ──`);
    console.log(`  ${'Label'.padEnd(18)} Trades  WR     ROI%    PF    MDD%   Sharpe  T/Day  TrdWR  TrdPnl     RngWR  RngPnl`);
    console.log('  ' + '─'.repeat(120));

    for (const c of candidates) {
      const r = runParams(dataTicks, c.params, bal);
      const lab = c.label.padEnd(18);
      const trades = String(r.trades).padStart(5);
      const wr = `${r.wr.toFixed(0)}%`.padStart(4);
      const roi = `${r.roiPct >= 0 ? '+' : ''}${r.roiPct.toFixed(1)}%`.padStart(7);
      const pf = r.pf >= 90 ? '  Inf' : r.pf.toFixed(2).padStart(5);
      const dd = `${r.maxDdPct.toFixed(1)}%`.padStart(5);
      const sh = r.sharpe.toFixed(2).padStart(6);
      const tpd = r.tradesPerDay.toFixed(1).padStart(5);
      const twr = r.trendTrades > 0 ? `${r.trendWr.toFixed(0)}%`.padStart(4) : '  --';
      const tpnl = `${r.trendPnl >= 0 ? '+' : ''}${r.trendPnl.toFixed(4)}`.padStart(10);
      const rwr = r.rangeTrades > 0 ? `${r.rangeWr.toFixed(0)}%`.padStart(4) : '  --';
      const rpnl = `${r.rangePnl >= 0 ? '+' : ''}${r.rangePnl.toFixed(4)}`.padStart(10);
      console.log(`  ${lab} ${trades}  ${wr}  ${roi}  ${pf}  ${dd}  ${sh}  ${tpd}  ${twr} ${tpnl}  ${rwr} ${rpnl}`);
    }
  }

  // ─── Print full param sets for top candidates ───
  console.log('\n' + '═'.repeat(150));
  console.log('  FULL PARAMETER SETS — Top candidates');
  console.log('═'.repeat(150));

  for (const c of candidates) {
    const p = c.params;
    console.log(`\n  ${c.label}:`);
    console.log(`    atrPeriod=${p.atrPeriod}  regimeWin=${fmtTime(p.regimeWindowSeconds)}  trendThr=${p.trendThreshold}  rangeThr=${p.rangeThreshold}`);
    console.log(`    sigWin=${fmtTime(p.signalWindowSeconds)}  sigMult=${p.signalMultiple}  trail=${p.trailingAtrMultiple}  sl=${p.slAtrMultiple}  trailDelay=${fmtTime(p.trailDelaySeconds || 1)}`);
    console.log(`    meanWin=${fmtTime(p.meanWindowSeconds)}  entryBand=${p.entryBandMultiple}  revSl=${p.reversionSlMultiple}  cooldown=${fmtTime(p.cooldownSeconds || 1)}  minAtr=${p.minAtrPct}  uncMult=${p.uncertainMultiple}`);
  }

  console.log('');
}

main();
