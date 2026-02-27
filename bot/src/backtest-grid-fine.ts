/**
 * Fine-grained grid search for OPTIMAL ATR + strategy parameters.
 * Narrow ranges around previous winners, then combined cross-validation.
 *
 * Phase 1: Fine exit params (atr period, trail, SL, hard SL)
 * Phase 2: Fine entry params (signal, window, delay, cooldown)
 * Phase 3: Fine regime thresholds (trend, range, regime window, mean window)
 * Phase 4: Fine reversion params (entry band, reversion SL)
 * Phase 5: Combined top-N search (cross all phase winners)
 * Phase 6: Multi-period validation (30/60/90/120/150/180 days)
 *
 * Usage: cd bot && npx tsx src/backtest-grid-fine.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import type { StrategyConfig } from './strategies.js';
import { STRATEGIES } from './strategies.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';
import { SOL_FEED_ID } from './feed.js';

const DATA_PATH = resolve('data/history-180d.jsonl');
const LAST_N_DAYS = 180; // use full 180d for optimization
const BALANCE_USDC = 27.51;
const SOL_PRICE_APPROX = 140; // approximate current SOL price
const BALANCE_SOL = BALANCE_USDC / SOL_PRICE_APPROX;
const LEVERAGE = 10;
const KELLY = 0.30;

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

/* ─── Grid config overrides ────────────────────────────── */

interface GridOverrides {
  atrPeriod?: number;
  trailingAtrMultiple?: number;
  slAtrMultiple?: number;
  hardSlPct?: number;
  signalMultiple?: number;
  signalWindowSeconds?: number;
  trailDelaySeconds?: number;
  cooldownSeconds?: number;
  meanWindowSeconds?: number;
  regimeWindowSeconds?: number;
  trendThreshold?: number;
  rangeThreshold?: number;
  entryBandMultiple?: number;
  reversionSlMultiple?: number;
  minAtrPct?: number;
}

interface RunResult {
  label: string;
  overrides: GridOverrides;
  roi: number;
  trades: number;
  winRate: number;
  pf: number;
  maxDd: number;
  netPnl: number;
  sharpe: number;
  finalEquity: number;
  wins: number;
  losses: number;
}

function runVariant(overrides: GridOverrides, ticks: Tick[], hardSlPct: number): RunResult {
  const rBaseConfig = STRATEGIES.find(s => s.name === 'R-base')!;

  const config = { ...rBaseConfig } as any;
  if (overrides.atrPeriod !== undefined) config.atrPeriod = overrides.atrPeriod;
  if (overrides.trailingAtrMultiple !== undefined) config.trailingAtrMultiple = overrides.trailingAtrMultiple;
  if (overrides.slAtrMultiple !== undefined) config.slAtrMultiple = overrides.slAtrMultiple;
  if (overrides.signalMultiple !== undefined) config.signalMultiple = overrides.signalMultiple;
  if (overrides.signalWindowSeconds !== undefined) config.signalWindowSeconds = overrides.signalWindowSeconds;
  if (overrides.trailDelaySeconds !== undefined) config.trailDelaySeconds = overrides.trailDelaySeconds;
  if (overrides.cooldownSeconds !== undefined) config.cooldownSeconds = overrides.cooldownSeconds;
  if (overrides.meanWindowSeconds !== undefined) config.meanWindowSeconds = overrides.meanWindowSeconds;
  if (overrides.regimeWindowSeconds !== undefined) config.regimeWindowSeconds = overrides.regimeWindowSeconds;
  if (overrides.trendThreshold !== undefined) config.trendThreshold = overrides.trendThreshold;
  if (overrides.rangeThreshold !== undefined) config.rangeThreshold = overrides.rangeThreshold;
  if (overrides.entryBandMultiple !== undefined) config.entryBandMultiple = overrides.entryBandMultiple;
  if (overrides.reversionSlMultiple !== undefined) config.reversionSlMultiple = overrides.reversionSlMultiple;
  if (overrides.minAtrPct !== undefined) config.minAtrPct = overrides.minAtrPct;

  const bankroll = new BankrollManager({
    mode: 'paper',
    initialEquitySol: BALANCE_SOL,
  });
  const strategy = new RegimeStrategy(config as any);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  // Patch enter() for leveraged position
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

  // Patch checkTrendExit for pure ATR trail + custom hard SL
  (strategy as any).checkTrendExit = function(price: number, now: number) {
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;
    if (favorable <= -hardSlPct) {
      this.exit(price, now, 2 / 10_000, 'SL');
      return;
    }
    const holdTime = now - this.entryTickTime;
    if (holdTime < this.config.trailDelaySeconds) {
      if (now - this.lastTrailCheckTime >= 60) {
        this.trackBestPrice(price);
        this.lastTrailCheckTime = now;
      }
      return;
    }
    if (now - this.lastTrailCheckTime < 60) return;
    this.lastTrailCheckTime = now;
    this.trackBestPrice(price);
    const stopAtr = this.scaledAtr(this.config.regimeWindowSeconds / 60);
    const trailPct = this.config.trailingAtrMultiple * stopAtr;
    if (this.entryDirection === 'long') {
      const drawdown = ((this.bestPriceSinceEntry - price) / this.bestPriceSinceEntry) * 100;
      if (drawdown >= trailPct) this.exit(price, now, 2 / 10_000, 'trail');
    } else {
      const drawup = ((price - this.bestPriceSinceEntry) / this.bestPriceSinceEntry) * 100;
      if (drawup >= trailPct) this.exit(price, now, 2 / 10_000, 'trail');
    }
  };

  // Suppress logs
  const origLog = console.log;
  console.log = () => {};

  let peakEquity = BALANCE_SOL;
  let maxDdPct = 0;
  let lastSnap = 0;

  for (const tick of ticks) {
    bankroll.updateSolPrice(tick.price);
    strategy.onTick(tick);
    if (tick.publishTime - lastSnap >= 60) {
      const eq = bankroll.getEquity();
      if (eq > peakEquity) peakEquity = eq;
      const ddPct = peakEquity > 0 ? ((peakEquity - eq) / peakEquity) * 100 : 0;
      if (ddPct > maxDdPct) maxDdPct = ddPct;
      lastSnap = tick.publishTime;
    }
  }

  console.log = origLog;

  const metrics = strategy.getMetrics();
  const finalEquity = bankroll.getEquity();
  const roi = ((finalEquity / BALANCE_SOL) - 1) * 100;
  strategy.stop();

  return {
    label: '',
    overrides,
    roi,
    trades: metrics.totalTrades,
    winRate: metrics.winRate,
    pf: metrics.profitFactor,
    maxDd: maxDdPct,
    netPnl: metrics.netPnlSol,
    sharpe: metrics.sharpe,
    finalEquity,
    wins: metrics.wins,
    losses: metrics.losses,
  };
}

/* ─── Printing helpers ───────────────────────────────── */

function printTable(results: RunResult[], headers: string[], rowFn: (r: RunResult) => string[], limit: number): void {
  console.log('  ' + headers.join('  '));
  console.log('  ' + '─'.repeat(headers.join('  ').length));
  for (let i = 0; i < Math.min(limit, results.length); i++) {
    const cols = rowFn(results[i]);
    console.log(`  ${String(i+1).padStart(3)}  ${cols.join('  ')}`);
  }
}

function commonCols(r: RunResult): string[] {
  return [
    String(r.trades).padStart(6),
    (r.wins + '/' + r.losses).padStart(8),
    (r.winRate.toFixed(1) + '%').padStart(6),
    ((r.roi >= 0 ? '+' : '') + r.roi.toFixed(1) + '%').padStart(9),
    ((r.netPnl >= 0 ? '+' : '') + r.netPnl.toFixed(4)).padStart(9),
    (r.pf === Infinity ? 'Inf' : r.pf.toFixed(2)).padStart(5),
    r.sharpe.toFixed(3).padStart(7),
    (r.maxDd.toFixed(1) + '%').padStart(7),
  ];
}

/* ─── Score function: balance ROI, Sharpe, DD, trade count ─── */

function score(r: RunResult): number {
  // Weighted composite:
  //   50% ROI (main objective)
  //   25% Sharpe (risk-adjusted)
  //   15% MaxDD penalty (lower is better)
  //   10% trade count bonus (prefer 50+ trades for statistical significance)
  const roiScore = r.roi;
  const sharpeScore = r.sharpe * 200; // scale sharpe to roughly same range as ROI
  const ddPenalty = r.maxDd > 30 ? -(r.maxDd - 30) * 2 : 0; // penalize >30% DD
  const tradeBonus = r.trades >= 50 ? 5 : r.trades >= 30 ? 0 : -10; // penalize <30 trades
  return roiScore * 0.50 + sharpeScore * 0.25 + ddPenalty * 0.15 + tradeBonus * 0.10;
}

/* ─── Main ───────────────────────────────────────────────── */

function main(): void {
  console.log('Loading data...');
  const allTicks = loadTicks(DATA_PATH);
  const lastTs = allTicks[allTicks.length - 1].publishTime;

  // Use full 180d for phases 1-5
  const startTs180 = lastTs - (180 * 24 * 3600);
  const ticks180 = allTicks.filter(t => t.publishTime >= startTs180);
  const solTicks180 = ticks180.filter(t => t.feedId === SOL_FEED_ID);
  const solStart = solTicks180[0]?.price ?? 0;
  const solEnd = solTicks180[solTicks180.length - 1]?.price ?? 0;

  console.log(`${ticks180.length.toLocaleString()} ticks, 180 days, SOL $${solStart.toFixed(2)} → $${solEnd.toFixed(2)} (${(((solEnd/solStart)-1)*100).toFixed(1)}%)`);
  console.log(`Starting: ${BALANCE_SOL.toFixed(4)} SOL ($${BALANCE_USDC}) | ${LEVERAGE}x leverage | ${(KELLY*100).toFixed(0)}% Kelly`);
  console.log('');

  const globalT0 = Date.now();

  // ═══════════════════════════════════════════════════════════
  //  PHASE 1: Fine-grained exit parameters
  // ═══════════════════════════════════════════════════════════

  // Previous winner: atr=90, trail=0.8, sl=1.5, hardSl=2.0
  // Now sweep tighter around those with finer steps
  const atrPeriods  = [70, 75, 80, 85, 90, 95, 100, 110, 120];
  const trailMults  = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2];
  const slMults     = [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5];
  const hardSls     = [1.5, 2.0, 2.5, 3.0];

  const totalP1 = atrPeriods.length * trailMults.length * slMults.length * hardSls.length;
  console.log(`═══ PHASE 1: Fine Exit Sweep (${totalP1} combos) ═══`);
  console.log('Previous winner: atr=90 trail=0.8 sl=1.5 hardSl=2.0');
  console.log('Testing narrow ranges with fine steps\n');

  const phase1Results: RunResult[] = [];
  let count = 0;
  const t0 = Date.now();

  for (const atr of atrPeriods) {
    for (const trail of trailMults) {
      for (const sl of slMults) {
        for (const hardSl of hardSls) {
          count++;
          if (count % 100 === 0) process.stdout.write(`  ${count}/${totalP1}...\r`);
          const overrides: GridOverrides = {
            atrPeriod: atr,
            trailingAtrMultiple: trail,
            slAtrMultiple: sl,
            hardSlPct: hardSl,
          };
          const r = runVariant(overrides, ticks180, hardSl);
          r.label = `atr=${atr} trail=${trail} sl=${sl} hardSl=${hardSl}`;
          r.overrides = overrides;
          phase1Results.push(r);
        }
      }
    }
  }

  phase1Results.sort((a, b) => score(b) - score(a));
  console.log(`\n  Phase 1 done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('\n  TOP 20 EXIT CONFIGS (by composite score):');
  printTable(phase1Results, [
    ' # ', 'atrPer', 'trail', 'slATR', 'hardSL', 'Trades', '  W/L   ', '  WR ', '     ROI%', '  P&L SOL', '  PF ', ' Sharpe', ' MaxDD%',
  ], (r) => {
    const o = r.overrides;
    return [
      String(o.atrPeriod).padStart(6),
      o.trailingAtrMultiple!.toFixed(2).padStart(5),
      o.slAtrMultiple!.toFixed(2).padStart(5),
      o.hardSlPct!.toFixed(1).padStart(6),
      ...commonCols(r),
    ];
  }, 20);

  // ═══════════════════════════════════════════════════════════
  //  PHASE 2: Fine-grained entry parameters
  // ═══════════════════════════════════════════════════════════

  const bestExit = phase1Results[0].overrides;
  console.log('');
  console.log(`═══ PHASE 2: Fine Entry Sweep ═══`);
  console.log(`Best exit: atr=${bestExit.atrPeriod} trail=${bestExit.trailingAtrMultiple} sl=${bestExit.slAtrMultiple} hardSl=${bestExit.hardSlPct}`);

  // Previous winner: signal=4.0, window=30m, delay=300, cd=120
  const signalMults   = [3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0];
  const signalWindows = [15*60, 20*60, 25*60, 30*60, 35*60, 40*60, 45*60];
  const trailDelays   = [120, 180, 240, 300, 360, 420, 480];
  const cooldowns     = [60, 90, 120, 150, 180, 240, 300];

  const totalP2 = signalMults.length * signalWindows.length * trailDelays.length * cooldowns.length;
  console.log(`Sweep: ${totalP2} combos\n`);

  const phase2Results: RunResult[] = [];
  count = 0;
  const t1 = Date.now();

  for (const sigMult of signalMults) {
    for (const sigWin of signalWindows) {
      for (const delay of trailDelays) {
        for (const cd of cooldowns) {
          count++;
          if (count % 200 === 0) process.stdout.write(`  ${count}/${totalP2}...\r`);
          const overrides: GridOverrides = {
            ...bestExit,
            signalMultiple: sigMult,
            signalWindowSeconds: sigWin,
            trailDelaySeconds: delay,
            cooldownSeconds: cd,
          };
          const r = runVariant(overrides, ticks180, bestExit.hardSlPct!);
          r.label = `sig=${sigMult} win=${sigWin/60}m delay=${delay}s cd=${cd}s`;
          r.overrides = overrides;
          phase2Results.push(r);
        }
      }
    }
  }

  phase2Results.sort((a, b) => score(b) - score(a));
  console.log(`\n  Phase 2 done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log('\n  TOP 20 ENTRY CONFIGS (by composite score):');
  printTable(phase2Results, [
    ' # ', ' sigMul', ' sigWin', ' delay', '    cd', 'Trades', '  W/L   ', '  WR ', '     ROI%', '  P&L SOL', '  PF ', ' Sharpe', ' MaxDD%',
  ], (r) => {
    const o = r.overrides;
    return [
      o.signalMultiple!.toFixed(1).padStart(7),
      (o.signalWindowSeconds!/60 + 'm').padStart(7),
      (o.trailDelaySeconds + 's').padStart(6),
      (o.cooldownSeconds + 's').padStart(6),
      ...commonCols(r),
    ];
  }, 20);

  // ═══════════════════════════════════════════════════════════
  //  PHASE 3: Fine-grained regime thresholds
  // ═══════════════════════════════════════════════════════════

  const bestEntry = phase2Results[0].overrides;
  console.log('');
  console.log(`═══ PHASE 3: Fine Regime Sweep ═══`);
  console.log(`Best so far: atr=${bestEntry.atrPeriod} trail=${bestEntry.trailingAtrMultiple} sl=${bestEntry.slAtrMultiple} sig=${bestEntry.signalMultiple} win=${bestEntry.signalWindowSeconds!/60}m delay=${bestEntry.trailDelaySeconds}s cd=${bestEntry.cooldownSeconds}s`);

  // Previous winner: trend=1.5, range=0.8, regime=4h, mean=1h
  const trendThresholds  = [1.0, 1.2, 1.3, 1.5, 1.7, 2.0];
  const rangeThresholds  = [0.4, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2];
  const regimeWindows    = [2*3600, 3*3600, 3.5*3600, 4*3600, 4.5*3600, 5*3600, 6*3600];
  const meanWindows      = [30*60, 45*60, 60*60, 75*60, 90*60, 120*60];

  const totalP3 = trendThresholds.length * rangeThresholds.length * regimeWindows.length * meanWindows.length;
  console.log(`Sweep: ${totalP3} combos\n`);

  const phase3Results: RunResult[] = [];
  count = 0;
  const t2 = Date.now();

  for (const trendThr of trendThresholds) {
    for (const rangeThr of rangeThresholds) {
      for (const regWin of regimeWindows) {
        for (const meanWin of meanWindows) {
          count++;
          if (count % 100 === 0) process.stdout.write(`  ${count}/${totalP3}...\r`);
          const overrides: GridOverrides = {
            ...bestEntry,
            trendThreshold: trendThr,
            rangeThreshold: rangeThr,
            regimeWindowSeconds: regWin,
            meanWindowSeconds: meanWin,
          };
          const r = runVariant(overrides, ticks180, bestEntry.hardSlPct!);
          r.label = `trend=${trendThr} range=${rangeThr} regime=${regWin/3600}h mean=${meanWin/60}m`;
          r.overrides = overrides;
          phase3Results.push(r);
        }
      }
    }
  }

  phase3Results.sort((a, b) => score(b) - score(a));
  console.log(`\n  Phase 3 done in ${((Date.now() - t2) / 1000).toFixed(1)}s`);
  console.log('\n  TOP 20 REGIME CONFIGS (by composite score):');
  printTable(phase3Results, [
    ' # ', 'trendTh', 'rangeTh', 'regWin', 'meanWin', 'Trades', '  W/L   ', '  WR ', '     ROI%', '  P&L SOL', '  PF ', ' Sharpe', ' MaxDD%',
  ], (r) => {
    const o = r.overrides;
    return [
      o.trendThreshold!.toFixed(1).padStart(7),
      o.rangeThreshold!.toFixed(1).padStart(7),
      (o.regimeWindowSeconds!/3600 + 'h').padStart(6),
      (o.meanWindowSeconds!/60 + 'm').padStart(7),
      ...commonCols(r),
    ];
  }, 20);

  // ═══════════════════════════════════════════════════════════
  //  PHASE 4: Fine-grained reversion parameters
  // ═══════════════════════════════════════════════════════════

  const bestRegime = phase3Results[0].overrides;
  console.log('');
  console.log(`═══ PHASE 4: Fine Reversion Sweep ═══`);

  // Previous winner: band=2.5, revSl=4.0
  const entryBands = [1.5, 2.0, 2.25, 2.5, 2.75, 3.0, 3.5, 4.0];
  const revSls     = [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0];

  const totalP4 = entryBands.length * revSls.length;
  console.log(`Sweep: ${totalP4} combos\n`);

  const phase4Results: RunResult[] = [];
  count = 0;
  const t3 = Date.now();

  for (const band of entryBands) {
    for (const revSl of revSls) {
      count++;
      const overrides: GridOverrides = {
        ...bestRegime,
        entryBandMultiple: band,
        reversionSlMultiple: revSl,
      };
      const r = runVariant(overrides, ticks180, bestRegime.hardSlPct!);
      r.label = `band=${band} revSl=${revSl}`;
      r.overrides = overrides;
      phase4Results.push(r);
    }
  }

  phase4Results.sort((a, b) => score(b) - score(a));
  console.log(`  Phase 4 done in ${((Date.now() - t3) / 1000).toFixed(1)}s`);
  console.log('\n  TOP 15 REVERSION CONFIGS (by composite score):');
  printTable(phase4Results, [
    ' # ', ' band', 'revSl', 'Trades', '  W/L   ', '  WR ', '     ROI%', '  P&L SOL', '  PF ', ' Sharpe', ' MaxDD%',
  ], (r) => {
    const o = r.overrides;
    return [
      o.entryBandMultiple!.toFixed(2).padStart(5),
      o.reversionSlMultiple!.toFixed(1).padStart(5),
      ...commonCols(r),
    ];
  }, 15);

  // ═══════════════════════════════════════════════════════════
  //  PHASE 5: Combined cross-parameter search
  //  Take top-3 unique values per parameter from each phase,
  //  then search across all combinations
  // ═══════════════════════════════════════════════════════════

  const bestSeq = phase4Results[0].overrides;
  console.log('');
  console.log(`═══ PHASE 5: Combined Cross-Parameter Search ═══`);
  console.log('Taking top unique values per param, testing ALL combos together\n');

  // Extract top unique values for each parameter from phase results
  function topUnique<T>(results: RunResult[], key: keyof GridOverrides, n: number): T[] {
    const seen = new Set<T>();
    const values: T[] = [];
    for (const r of results) {
      const v = r.overrides[key] as T;
      if (v !== undefined && !seen.has(v)) {
        seen.add(v);
        values.push(v);
        if (values.length >= n) break;
      }
    }
    return values;
  }

  // Only cross the SENSITIVE parameters — from phase analysis:
  // - slATR: insensitive (hard SL triggers first) → fix at sequential best
  // - cooldown: insensitive (cd=60..300 identical) → fix at 120
  // - regimeWindow: 4h dominates → fix at 4h
  // - meanWindow: 60m dominates → fix at 60m
  // - band/revSl: already optimized → fix from Phase 4
  //
  // Sensitive params: atrPeriod, trail, hardSl, signal, sigWin, delay, trendThr, rangeThr

  const topAtr = topUnique<number>(phase1Results, 'atrPeriod', 3);
  const topTrail = topUnique<number>(phase1Results, 'trailingAtrMultiple', 3);
  const topHardSl = topUnique<number>(phase1Results, 'hardSlPct', 2);
  const topSig = topUnique<number>(phase2Results, 'signalMultiple', 3);
  const topSigWin = topUnique<number>(phase2Results, 'signalWindowSeconds', 3);
  const topDelay = topUnique<number>(phase2Results, 'trailDelaySeconds', 3);
  const topTrend = topUnique<number>(phase3Results, 'trendThreshold', 3);
  const topRange = topUnique<number>(phase3Results, 'rangeThreshold', 3);

  // Fixed insensitive params
  const fixedSl = bestSeq.slAtrMultiple ?? 1.5;
  const fixedCd = 120;
  const fixedRegWin = 4 * 3600;
  const fixedMeanWin = 60 * 60;
  const fixedBand = bestSeq.entryBandMultiple!;
  const fixedRevSl = bestSeq.reversionSlMultiple!;

  const totalP5 = topAtr.length * topTrail.length * topHardSl.length *
    topSig.length * topSigWin.length * topDelay.length *
    topTrend.length * topRange.length;

  console.log(`  SENSITIVE (crossed):`);
  console.log(`    atrPeriods:  [${topAtr.join(', ')}]`);
  console.log(`    trails:      [${topTrail.join(', ')}]`);
  console.log(`    hardSls:     [${topHardSl.join(', ')}]`);
  console.log(`    signals:     [${topSig.join(', ')}]`);
  console.log(`    sigWindows:  [${topSigWin.map(w => w/60 + 'm').join(', ')}]`);
  console.log(`    delays:      [${topDelay.join(', ')}]`);
  console.log(`    trendThrs:   [${topTrend.join(', ')}]`);
  console.log(`    rangeThrs:   [${topRange.join(', ')}]`);
  console.log(`  FIXED (insensitive):`);
  console.log(`    sl=${fixedSl} cd=${fixedCd} regWin=${fixedRegWin/3600}h meanWin=${fixedMeanWin/60}m band=${fixedBand} revSl=${fixedRevSl}`);
  console.log(`\n  Total combos: ${totalP5.toLocaleString()}\n`);

  const phase5Results: RunResult[] = [];
  count = 0;
  const t4 = Date.now();

  for (const atr of topAtr) {
    for (const trail of topTrail) {
      for (const hardSl of topHardSl) {
        for (const sig of topSig) {
          for (const sigWin of topSigWin) {
            for (const delay of topDelay) {
              for (const trendThr of topTrend) {
                for (const rangeThr of topRange) {
                  count++;
                  if (count % 500 === 0) process.stdout.write(`  ${count}/${totalP5}...\r`);
                  const overrides: GridOverrides = {
                    atrPeriod: atr,
                    trailingAtrMultiple: trail,
                    slAtrMultiple: fixedSl,
                    hardSlPct: hardSl,
                    signalMultiple: sig,
                    signalWindowSeconds: sigWin,
                    trailDelaySeconds: delay,
                    cooldownSeconds: fixedCd,
                    trendThreshold: trendThr,
                    rangeThreshold: rangeThr,
                    regimeWindowSeconds: fixedRegWin,
                    meanWindowSeconds: fixedMeanWin,
                    entryBandMultiple: fixedBand,
                    reversionSlMultiple: fixedRevSl,
                  };
                  const r = runVariant(overrides, ticks180, hardSl);
                  r.overrides = overrides;
                  phase5Results.push(r);
                }
              }
            }
          }
        }
      }
    }
  }

  phase5Results.sort((a, b) => score(b) - score(a));
  console.log(`\n  Phase 5 done in ${((Date.now() - t4) / 1000).toFixed(1)}s (${totalP5.toLocaleString()} combos)`);
  console.log('\n  TOP 25 COMBINED CONFIGS (by composite score):');
  printTable(phase5Results, [
    ' # ', ' atr', 'trail', '  sl', ' hSL', ' sig', ' sWin', ' dly', '  cd', 'tThr', 'rThr', 'rWin', 'mWin', 'Trades', '  W/L   ', '  WR ', '     ROI%', '  P&L SOL', '  PF ', ' Sharpe', ' MaxDD%',
  ], (r) => {
    const o = r.overrides;
    return [
      String(o.atrPeriod).padStart(4),
      o.trailingAtrMultiple!.toFixed(1).padStart(5),
      o.slAtrMultiple!.toFixed(1).padStart(4),
      o.hardSlPct!.toFixed(1).padStart(4),
      o.signalMultiple!.toFixed(1).padStart(4),
      (o.signalWindowSeconds!/60 + 'm').padStart(5),
      (o.trailDelaySeconds + '').padStart(4),
      (o.cooldownSeconds + '').padStart(4),
      o.trendThreshold!.toFixed(1).padStart(4),
      o.rangeThreshold!.toFixed(1).padStart(4),
      (o.regimeWindowSeconds!/3600 + 'h').padStart(4),
      (o.meanWindowSeconds!/60 + 'm').padStart(4),
      ...commonCols(r),
    ];
  }, 25);

  // ═══════════════════════════════════════════════════════════
  //  PHASE 6: Multi-period validation of top 5 configs
  // ═══════════════════════════════════════════════════════════

  console.log('');
  console.log(`═══ PHASE 6: Multi-Period Validation ═══`);
  console.log('Testing top 5 configs across 30/60/90/120/150/180 day windows\n');

  const periods = [30, 60, 90, 120, 150, 180];
  const top5 = phase5Results.slice(0, 5);

  // Also include the sequential winner and current R-base for comparison
  const configsToValidate = [
    ...top5.map((r, i) => ({ label: `Combined #${i+1}`, overrides: r.overrides })),
    { label: 'Sequential best', overrides: bestSeq },
    { label: 'Current R-base', overrides: {} as GridOverrides },
  ];

  const validationResults: { label: string; overrides: GridOverrides; periods: { days: number; roi: number; trades: number; sharpe: number; maxDd: number; pf: number }[] }[] = [];

  const t5 = Date.now();
  for (const cfg of configsToValidate) {
    const periodResults: { days: number; roi: number; trades: number; sharpe: number; maxDd: number; pf: number }[] = [];
    for (const days of periods) {
      const startTs = lastTs - (days * 24 * 3600);
      const periodTicks = allTicks.filter(t => t.publishTime >= startTs);
      const hardSl = cfg.overrides.hardSlPct ?? 2.0;
      const r = runVariant(cfg.overrides, periodTicks, hardSl);
      periodResults.push({
        days,
        roi: r.roi,
        trades: r.trades,
        sharpe: r.sharpe,
        maxDd: r.maxDd,
        pf: r.pf,
      });
    }
    validationResults.push({ label: cfg.label, overrides: cfg.overrides, periods: periodResults });
  }

  console.log(`  Validation done in ${((Date.now() - t5) / 1000).toFixed(1)}s\n`);

  // Print validation table
  for (const v of validationResults) {
    console.log(`  ${v.label}:`);
    const o = v.overrides;
    if (Object.keys(o).length > 0) {
      console.log(`    atr=${o.atrPeriod ?? 90} trail=${o.trailingAtrMultiple ?? 0.8} sl=${o.slAtrMultiple ?? 1.5} hSL=${o.hardSlPct ?? 2.0} sig=${o.signalMultiple ?? 4.0} win=${(o.signalWindowSeconds ?? 1800)/60}m dly=${o.trailDelaySeconds ?? 300} cd=${o.cooldownSeconds ?? 120} trend=${o.trendThreshold ?? 1.5} range=${o.rangeThreshold ?? 0.8} regime=${(o.regimeWindowSeconds ?? 14400)/3600}h mean=${(o.meanWindowSeconds ?? 3600)/60}m`);
    }
    console.log('    Days   ROI%    Trades  Sharpe   PF    MaxDD%');
    console.log('    ─────────────────────────────────────────────');
    let allPositive = true;
    for (const p of v.periods) {
      const sign = p.roi >= 0 ? '+' : '';
      console.log(`    ${String(p.days).padStart(4)}d  ${(sign + p.roi.toFixed(1) + '%').padStart(8)}  ${String(p.trades).padStart(6)}  ${p.sharpe.toFixed(3).padStart(6)}  ${(p.pf === Infinity ? 'Inf' : p.pf.toFixed(2)).padStart(5)}  ${(p.maxDd.toFixed(1) + '%').padStart(7)}`);
      if (p.roi < 0) allPositive = false;
    }
    const avgRoi = v.periods.reduce((s, p) => s + p.roi, 0) / v.periods.length;
    const avgSharpe = v.periods.reduce((s, p) => s + p.sharpe, 0) / v.periods.length;
    console.log(`    ─────────────────────────────────────────────`);
    console.log(`    AVG:   ${(avgRoi >= 0 ? '+' : '') + avgRoi.toFixed(1) + '%'}          ${avgSharpe.toFixed(3)}       ${allPositive ? 'ALL POSITIVE' : 'HAS NEGATIVE'}`);
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════
  //  FINAL: Pick the best config (highest avg ROI across all periods, all positive)
  // ═══════════════════════════════════════════════════════════

  // Score: prefer all-positive periods, then by avg ROI
  const ranked = validationResults.map(v => {
    const allPos = v.periods.every(p => p.roi > 0);
    const avgRoi = v.periods.reduce((s, p) => s + p.roi, 0) / v.periods.length;
    const avgSharpe = v.periods.reduce((s, p) => s + p.sharpe, 0) / v.periods.length;
    const worstDd = Math.max(...v.periods.map(p => p.maxDd));
    return { ...v, allPos, avgRoi, avgSharpe, worstDd };
  }).sort((a, b) => {
    if (a.allPos !== b.allPos) return a.allPos ? -1 : 1;
    return b.avgRoi - a.avgRoi;
  });

  const winner = ranked[0];
  const wo = winner.overrides;

  console.log('═'.repeat(110));
  console.log('  OPTIMAL CONFIG:');
  console.log('═'.repeat(110));
  console.log(`  Label: ${winner.label}`);
  console.log('');
  console.log(`  atrPeriod:            ${wo.atrPeriod ?? 90}`);
  console.log(`  trailingAtrMultiple:  ${wo.trailingAtrMultiple ?? 0.8}`);
  console.log(`  slAtrMultiple:        ${wo.slAtrMultiple ?? 1.5}`);
  console.log(`  hardSlPct:            ${wo.hardSlPct ?? 2.0}%`);
  console.log(`  signalMultiple:       ${wo.signalMultiple ?? 4.0}`);
  console.log(`  signalWindowSeconds:  ${wo.signalWindowSeconds ?? 1800} (${(wo.signalWindowSeconds ?? 1800)/60}m)`);
  console.log(`  trailDelaySeconds:    ${wo.trailDelaySeconds ?? 300}`);
  console.log(`  cooldownSeconds:      ${wo.cooldownSeconds ?? 120}`);
  console.log(`  trendThreshold:       ${wo.trendThreshold ?? 1.5}`);
  console.log(`  rangeThreshold:       ${wo.rangeThreshold ?? 0.8}`);
  console.log(`  regimeWindowSeconds:  ${wo.regimeWindowSeconds ?? 14400} (${(wo.regimeWindowSeconds ?? 14400)/3600}h)`);
  console.log(`  meanWindowSeconds:    ${wo.meanWindowSeconds ?? 3600} (${(wo.meanWindowSeconds ?? 3600)/60}m)`);
  console.log(`  entryBandMultiple:    ${wo.entryBandMultiple ?? fixedBand}`);
  console.log(`  reversionSlMultiple:  ${wo.reversionSlMultiple ?? fixedRevSl}`);
  console.log('');
  console.log(`  Avg ROI across periods: ${winner.avgRoi >= 0 ? '+' : ''}${winner.avgRoi.toFixed(1)}%`);
  console.log(`  Avg Sharpe:             ${winner.avgSharpe.toFixed(3)}`);
  console.log(`  Worst MaxDD:            ${winner.worstDd.toFixed(1)}%`);
  console.log(`  All periods positive:   ${winner.allPos ? 'YES' : 'NO'}`);
  console.log('═'.repeat(110));

  // Save full results
  const output = {
    meta: {
      optimizationDays: LAST_N_DAYS,
      solStart, solEnd,
      balance: BALANCE_USDC,
      leverage: LEVERAGE,
      kelly: KELLY,
      timestamp: new Date().toISOString(),
    },
    phase1Top20: phase1Results.slice(0, 20).map(r => ({ ...r.overrides, roi: r.roi, trades: r.trades, winRate: r.winRate, pf: r.pf, sharpe: r.sharpe, maxDd: r.maxDd, score: score(r) })),
    phase2Top20: phase2Results.slice(0, 20).map(r => ({ ...r.overrides, roi: r.roi, trades: r.trades, winRate: r.winRate, pf: r.pf, sharpe: r.sharpe, maxDd: r.maxDd, score: score(r) })),
    phase3Top20: phase3Results.slice(0, 20).map(r => ({ ...r.overrides, roi: r.roi, trades: r.trades, winRate: r.winRate, pf: r.pf, sharpe: r.sharpe, maxDd: r.maxDd, score: score(r) })),
    phase4Top15: phase4Results.slice(0, 15).map(r => ({ ...r.overrides, roi: r.roi, trades: r.trades, winRate: r.winRate, pf: r.pf, sharpe: r.sharpe, maxDd: r.maxDd, score: score(r) })),
    phase5Top25: phase5Results.slice(0, 25).map(r => ({ ...r.overrides, roi: r.roi, trades: r.trades, winRate: r.winRate, pf: r.pf, sharpe: r.sharpe, maxDd: r.maxDd, score: score(r) })),
    validation: validationResults.map(v => ({
      label: v.label,
      overrides: v.overrides,
      periods: v.periods,
      avgRoi: v.periods.reduce((s, p) => s + p.roi, 0) / v.periods.length,
    })),
    bestConfig: wo,
  };

  writeFileSync(resolve('../output/grid-fine-results.json'), JSON.stringify(output, null, 2));
  console.log(`\nFull results saved to output/grid-fine-results.json`);
  console.log(`Total time: ${((Date.now() - globalT0) / 1000).toFixed(1)}s`);
}

main();
