/**
 * Grid search over ATR-related parameters with 10x leverage.
 * Phase 1: Sweep exit params (trail, SL, ATR period, hard SL) — pure ATR trail
 * Phase 2: With best exit params, sweep entry params (signal, delay, cooldown)
 * Phase 3: With best exit+entry, sweep regime thresholds
 *
 * Usage: npx tsx src/backtest-grid.ts
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
const LAST_N_DAYS = 90;
const BALANCE_USDC = 27.51;
const SOL_PRICE_APPROX = 86;
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

  // Build modified config
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

  // Patch checkTrendExit for pure ATR trail (no profit locking) + custom hard SL
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

function fmtRow(rank: number, cols: string[]): string {
  return `  ${String(rank).padStart(3)}  ${cols.join('  ')}`;
}

/* ─── Main ───────────────────────────────────────────────── */

function main(): void {
  console.log('Loading data...');
  const allTicks = loadTicks(DATA_PATH);
  const lastTs = allTicks[allTicks.length - 1].publishTime;
  const startTs = lastTs - (LAST_N_DAYS * 24 * 3600);
  const ticks = allTicks.filter(t => t.publishTime >= startTs);
  const solTicks = ticks.filter(t => t.feedId === SOL_FEED_ID);
  const solStart = solTicks[0]?.price ?? 0;
  const solEnd = solTicks[solTicks.length - 1]?.price ?? 0;

  console.log(`${ticks.length.toLocaleString()} ticks, ${LAST_N_DAYS} days, SOL $${solStart.toFixed(2)} → $${solEnd.toFixed(2)} (${(((solEnd/solStart)-1)*100).toFixed(1)}%)`);
  console.log(`Starting: ${BALANCE_SOL.toFixed(4)} SOL ($${BALANCE_USDC}) | ${LEVERAGE}x leverage | ${(KELLY*100).toFixed(0)}% Kelly`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  //  PHASE 1: Sweep exit parameters (pure ATR trail)
  // ═══════════════════════════════════════════════════════════

  const atrPeriods = [30, 45, 60, 90];
  const trailMults = [0.8, 1.0, 1.5, 2.0, 2.5, 3.0];
  const slMults    = [1.5, 2.0, 2.5, 3.0, 4.0, 5.0];
  const hardSls    = [2.0, 3.0, 5.0];

  const totalP1 = atrPeriods.length * trailMults.length * slMults.length * hardSls.length;
  console.log(`═══ PHASE 1: Exit Parameter Sweep (${totalP1} combos) ═══`);
  console.log('Pure ATR trail — no profit locking. Finding best exit settings.\n');

  const phase1Results: RunResult[] = [];
  let count = 0;
  const t0 = Date.now();

  for (const atr of atrPeriods) {
    for (const trail of trailMults) {
      for (const sl of slMults) {
        for (const hardSl of hardSls) {
          count++;
          if (count % 50 === 0) process.stdout.write(`  ${count}/${totalP1}...\r`);

          const overrides: GridOverrides = {
            atrPeriod: atr,
            trailingAtrMultiple: trail,
            slAtrMultiple: sl,
            hardSlPct: hardSl,
          };

          const r = runVariant(overrides, ticks, hardSl);
          r.label = `atr=${atr} trail=${trail} sl=${sl} hardSl=${hardSl}`;
          r.overrides = overrides;
          phase1Results.push(r);
        }
      }
    }
  }

  const p1Elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  phase1Results.sort((a, b) => b.roi - a.roi);

  console.log(`\n  Phase 1 done in ${p1Elapsed}s`);
  console.log('\n  TOP 25 EXIT CONFIGS (by ROI):');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────────');
  console.log('   #   atrPer  trail  slATR  hardSL  Trades  W/L       WR      ROI%      P&L SOL  PF     Sharpe  MaxDD%');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────────');

  for (let i = 0; i < Math.min(25, phase1Results.length); i++) {
    const r = phase1Results[i];
    const o = r.overrides;
    console.log(
      `  ${String(i+1).padStart(3)}  ` +
      `${String(o.atrPeriod).padStart(6)}  ` +
      `${o.trailingAtrMultiple!.toFixed(1).padStart(5)}  ` +
      `${o.slAtrMultiple!.toFixed(1).padStart(5)}  ` +
      `${o.hardSlPct!.toFixed(1).padStart(6)}  ` +
      `${String(r.trades).padStart(6)}  ` +
      `${(r.wins + '/' + r.losses).padStart(8)}  ` +
      `${(r.winRate.toFixed(1) + '%').padStart(6)}  ` +
      `${((r.roi >= 0 ? '+' : '') + r.roi.toFixed(1) + '%').padStart(8)}  ` +
      `${((r.netPnl >= 0 ? '+' : '') + r.netPnl.toFixed(4)).padStart(8)}  ` +
      `${(r.pf === Infinity ? 'Inf' : r.pf.toFixed(2)).padStart(5)}  ` +
      `${r.sharpe.toFixed(3).padStart(6)}  ` +
      `${(r.maxDd.toFixed(1) + '%').padStart(6)}`
    );
  }

  // ═══════════════════════════════════════════════════════════
  //  PHASE 2: With best exit params, sweep entry parameters
  // ═══════════════════════════════════════════════════════════

  const bestExit = phase1Results[0].overrides;
  console.log('');
  console.log(`═══ PHASE 2: Entry Parameter Sweep ═══`);
  console.log(`Best exit from Phase 1: atr=${bestExit.atrPeriod} trail=${bestExit.trailingAtrMultiple} sl=${bestExit.slAtrMultiple} hardSl=${bestExit.hardSlPct}`);
  console.log('');

  const signalMults   = [2.0, 3.0, 4.0, 5.0, 6.0];
  const signalWindows = [15 * 60, 30 * 60, 45 * 60];
  const trailDelays   = [120, 300, 480, 900];
  const cooldowns     = [120, 300, 600];

  const totalP2 = signalMults.length * signalWindows.length * trailDelays.length * cooldowns.length;
  console.log(`Sweep: signal × window × trailDelay × cooldown = ${totalP2} combos\n`);

  const phase2Results: RunResult[] = [];
  count = 0;
  const t1 = Date.now();

  for (const sigMult of signalMults) {
    for (const sigWin of signalWindows) {
      for (const delay of trailDelays) {
        for (const cd of cooldowns) {
          count++;
          if (count % 30 === 0) process.stdout.write(`  ${count}/${totalP2}...\r`);

          const overrides: GridOverrides = {
            ...bestExit,
            signalMultiple: sigMult,
            signalWindowSeconds: sigWin,
            trailDelaySeconds: delay,
            cooldownSeconds: cd,
          };

          const r = runVariant(overrides, ticks, bestExit.hardSlPct!);
          r.label = `sig=${sigMult} win=${sigWin/60}m delay=${delay}s cd=${cd}s`;
          r.overrides = overrides;
          phase2Results.push(r);
        }
      }
    }
  }

  const p2Elapsed = ((Date.now() - t1) / 1000).toFixed(1);
  phase2Results.sort((a, b) => b.roi - a.roi);

  console.log(`\n  Phase 2 done in ${p2Elapsed}s`);
  console.log('\n  TOP 25 ENTRY CONFIGS (by ROI):');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────────');
  console.log('   #   sigMult  sigWin  delay    cd   Trades  W/L       WR      ROI%      P&L SOL  PF     Sharpe  MaxDD%');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────────');

  for (let i = 0; i < Math.min(25, phase2Results.length); i++) {
    const r = phase2Results[i];
    const o = r.overrides;
    console.log(
      `  ${String(i+1).padStart(3)}  ` +
      `${o.signalMultiple!.toFixed(1).padStart(7)}  ` +
      `${(o.signalWindowSeconds! / 60 + 'm').padStart(6)}  ` +
      `${(o.trailDelaySeconds + 's').padStart(5)}  ` +
      `${(o.cooldownSeconds + 's').padStart(5)}  ` +
      `${String(r.trades).padStart(6)}  ` +
      `${(r.wins + '/' + r.losses).padStart(8)}  ` +
      `${(r.winRate.toFixed(1) + '%').padStart(6)}  ` +
      `${((r.roi >= 0 ? '+' : '') + r.roi.toFixed(1) + '%').padStart(8)}  ` +
      `${((r.netPnl >= 0 ? '+' : '') + r.netPnl.toFixed(4)).padStart(8)}  ` +
      `${(r.pf === Infinity ? 'Inf' : r.pf.toFixed(2)).padStart(5)}  ` +
      `${r.sharpe.toFixed(3).padStart(6)}  ` +
      `${(r.maxDd.toFixed(1) + '%').padStart(6)}`
    );
  }

  // ═══════════════════════════════════════════════════════════
  //  PHASE 3: With best exit+entry, sweep regime thresholds
  // ═══════════════════════════════════════════════════════════

  const bestEntry = phase2Results[0].overrides;
  console.log('');
  console.log(`═══ PHASE 3: Regime Threshold Sweep ═══`);
  console.log(`Best so far: atr=${bestEntry.atrPeriod} trail=${bestEntry.trailingAtrMultiple} sl=${bestEntry.slAtrMultiple} hardSl=${bestEntry.hardSlPct} sig=${bestEntry.signalMultiple} win=${bestEntry.signalWindowSeconds!/60}m delay=${bestEntry.trailDelaySeconds}s cd=${bestEntry.cooldownSeconds}s`);
  console.log('');

  const trendThresholds  = [1.0, 1.5, 2.0];
  const rangeThresholds  = [0.3, 0.5, 0.8];
  const regimeWindows    = [2 * 3600, 4 * 3600, 6 * 3600];
  const meanWindows      = [1 * 3600, 2 * 3600, 4 * 3600];
  const entryBands       = [1.5, 2.0, 2.5, 3.5];
  const revSls           = [2.5, 4.0, 5.0];

  const totalP3 = trendThresholds.length * rangeThresholds.length * regimeWindows.length * meanWindows.length;
  console.log(`Sweep: trend × range × regimeWin × meanWin = ${totalP3} combos\n`);

  const phase3Results: RunResult[] = [];
  count = 0;
  const t2 = Date.now();

  for (const trendThr of trendThresholds) {
    for (const rangeThr of rangeThresholds) {
      for (const regWin of regimeWindows) {
        for (const meanWin of meanWindows) {
          count++;
          if (count % 20 === 0) process.stdout.write(`  ${count}/${totalP3}...\r`);

          const overrides: GridOverrides = {
            ...bestEntry,
            trendThreshold: trendThr,
            rangeThreshold: rangeThr,
            regimeWindowSeconds: regWin,
            meanWindowSeconds: meanWin,
          };

          const r = runVariant(overrides, ticks, bestEntry.hardSlPct!);
          r.label = `trend=${trendThr} range=${rangeThr} regime=${regWin/3600}h mean=${meanWin/3600}h`;
          r.overrides = overrides;
          phase3Results.push(r);
        }
      }
    }
  }

  const p3Elapsed = ((Date.now() - t2) / 1000).toFixed(1);
  phase3Results.sort((a, b) => b.roi - a.roi);

  console.log(`\n  Phase 3 done in ${p3Elapsed}s`);
  console.log('\n  TOP 20 REGIME CONFIGS (by ROI):');
  console.log('  ────────────────────────────────────────────────────────────────────────────────────────────────────────────');
  console.log('   #   trendTh  rangeTh  regWin  meanWin  Trades  W/L       WR      ROI%      P&L SOL  PF     Sharpe  MaxDD%');
  console.log('  ────────────────────────────────────────────────────────────────────────────────────────────────────────────');

  for (let i = 0; i < Math.min(20, phase3Results.length); i++) {
    const r = phase3Results[i];
    const o = r.overrides;
    console.log(
      `  ${String(i+1).padStart(3)}  ` +
      `${o.trendThreshold!.toFixed(1).padStart(7)}  ` +
      `${o.rangeThreshold!.toFixed(1).padStart(7)}  ` +
      `${(o.regimeWindowSeconds! / 3600 + 'h').padStart(6)}  ` +
      `${(o.meanWindowSeconds! / 3600 + 'h').padStart(7)}  ` +
      `${String(r.trades).padStart(6)}  ` +
      `${(r.wins + '/' + r.losses).padStart(8)}  ` +
      `${(r.winRate.toFixed(1) + '%').padStart(6)}  ` +
      `${((r.roi >= 0 ? '+' : '') + r.roi.toFixed(1) + '%').padStart(8)}  ` +
      `${((r.netPnl >= 0 ? '+' : '') + r.netPnl.toFixed(4)).padStart(8)}  ` +
      `${(r.pf === Infinity ? 'Inf' : r.pf.toFixed(2)).padStart(5)}  ` +
      `${r.sharpe.toFixed(3).padStart(6)}  ` +
      `${(r.maxDd.toFixed(1) + '%').padStart(6)}`
    );
  }

  // ═══════════════════════════════════════════════════════════
  //  PHASE 4: Fine-tune with best regime — sweep reversion params
  // ═══════════════════════════════════════════════════════════

  const bestRegime = phase3Results[0].overrides;
  console.log('');
  console.log(`═══ PHASE 4: Reversion Parameter Sweep ═══`);
  console.log('');

  const totalP4 = entryBands.length * revSls.length;
  console.log(`Sweep: entryBand × revSl = ${totalP4} combos\n`);

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

      const r = runVariant(overrides, ticks, bestRegime.hardSlPct!);
      r.label = `band=${band} revSl=${revSl}`;
      r.overrides = overrides;
      phase4Results.push(r);
    }
  }

  const p4Elapsed = ((Date.now() - t3) / 1000).toFixed(1);
  phase4Results.sort((a, b) => b.roi - a.roi);

  console.log(`  Phase 4 done in ${p4Elapsed}s`);
  console.log('\n  TOP 12 REVERSION CONFIGS (by ROI):');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────────');
  console.log('   #   band   revSl  Trades  W/L       WR      ROI%      P&L SOL  PF     Sharpe  MaxDD%');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────────');

  for (let i = 0; i < Math.min(12, phase4Results.length); i++) {
    const r = phase4Results[i];
    const o = r.overrides;
    console.log(
      `  ${String(i+1).padStart(3)}  ` +
      `${o.entryBandMultiple!.toFixed(1).padStart(5)}  ` +
      `${o.reversionSlMultiple!.toFixed(1).padStart(5)}  ` +
      `${String(r.trades).padStart(6)}  ` +
      `${(r.wins + '/' + r.losses).padStart(8)}  ` +
      `${(r.winRate.toFixed(1) + '%').padStart(6)}  ` +
      `${((r.roi >= 0 ? '+' : '') + r.roi.toFixed(1) + '%').padStart(8)}  ` +
      `${((r.netPnl >= 0 ? '+' : '') + r.netPnl.toFixed(4)).padStart(8)}  ` +
      `${(r.pf === Infinity ? 'Inf' : r.pf.toFixed(2)).padStart(5)}  ` +
      `${r.sharpe.toFixed(3).padStart(6)}  ` +
      `${(r.maxDd.toFixed(1) + '%').padStart(6)}`
    );
  }

  // ═══════════════════════════════════════════════════════════
  //  FINAL: Summary of best config
  // ═══════════════════════════════════════════════════════════

  const best = phase4Results[0];
  const bo = best.overrides;
  console.log('');
  console.log('═'.repeat(100));
  console.log('  OPTIMAL CONFIG FOUND:');
  console.log('═'.repeat(100));
  console.log(`  atrPeriod:            ${bo.atrPeriod}`);
  console.log(`  trailingAtrMultiple:  ${bo.trailingAtrMultiple}`);
  console.log(`  slAtrMultiple:        ${bo.slAtrMultiple}`);
  console.log(`  hardSlPct:            ${bo.hardSlPct}%`);
  console.log(`  signalMultiple:       ${bo.signalMultiple}`);
  console.log(`  signalWindowSeconds:  ${bo.signalWindowSeconds} (${bo.signalWindowSeconds!/60}m)`);
  console.log(`  trailDelaySeconds:    ${bo.trailDelaySeconds}`);
  console.log(`  cooldownSeconds:      ${bo.cooldownSeconds}`);
  console.log(`  trendThreshold:       ${bo.trendThreshold}`);
  console.log(`  rangeThreshold:       ${bo.rangeThreshold}`);
  console.log(`  regimeWindowSeconds:  ${bo.regimeWindowSeconds} (${bo.regimeWindowSeconds!/3600}h)`);
  console.log(`  meanWindowSeconds:    ${bo.meanWindowSeconds} (${bo.meanWindowSeconds!/3600}h)`);
  console.log(`  entryBandMultiple:    ${bo.entryBandMultiple}`);
  console.log(`  reversionSlMultiple:  ${bo.reversionSlMultiple}`);
  console.log('');
  console.log(`  ROI:     ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(1)}%`);
  console.log(`  Trades:  ${best.trades} (${best.wins}W/${best.losses}L, ${best.winRate.toFixed(1)}% WR)`);
  console.log(`  P&L:     ${best.netPnl >= 0 ? '+' : ''}${best.netPnl.toFixed(4)} SOL ($${(best.netPnl * solEnd).toFixed(2)})`);
  console.log(`  PF:      ${best.pf === Infinity ? 'Inf' : best.pf.toFixed(2)}`);
  console.log(`  Sharpe:  ${best.sharpe.toFixed(3)}`);
  console.log(`  MaxDD:   ${best.maxDd.toFixed(1)}%`);
  console.log(`  Final:   $${(best.finalEquity * solEnd).toFixed(2)}`);
  console.log('');

  // Compare to current R-base (with profit locking disabled via pure ATR trail)
  const current = runVariant({}, ticks, 3.0);
  console.log(`  vs Current R-base (pure trail): ROI ${current.roi >= 0 ? '+' : ''}${current.roi.toFixed(1)}% | ${current.trades} trades | ${current.winRate.toFixed(1)}% WR | MaxDD ${current.maxDd.toFixed(1)}%`);
  console.log('═'.repeat(100));

  // Save results to JSON
  const output = {
    meta: { days: LAST_N_DAYS, solStart, solEnd, balance: BALANCE_USDC, leverage: LEVERAGE, kelly: KELLY },
    phase1Top25: phase1Results.slice(0, 25).map(r => ({ ...r.overrides, roi: r.roi, trades: r.trades, winRate: r.winRate, pf: r.pf, sharpe: r.sharpe, maxDd: r.maxDd, netPnl: r.netPnl })),
    phase2Top25: phase2Results.slice(0, 25).map(r => ({ ...r.overrides, roi: r.roi, trades: r.trades, winRate: r.winRate, pf: r.pf, sharpe: r.sharpe, maxDd: r.maxDd, netPnl: r.netPnl })),
    phase3Top20: phase3Results.slice(0, 20).map(r => ({ ...r.overrides, roi: r.roi, trades: r.trades, winRate: r.winRate, pf: r.pf, sharpe: r.sharpe, maxDd: r.maxDd, netPnl: r.netPnl })),
    phase4Top12: phase4Results.slice(0, 12).map(r => ({ ...r.overrides, roi: r.roi, trades: r.trades, winRate: r.winRate, pf: r.pf, sharpe: r.sharpe, maxDd: r.maxDd, netPnl: r.netPnl })),
    bestConfig: bo,
  };
  writeFileSync(resolve('../output/grid-search-results.json'), JSON.stringify(output, null, 2));
  console.log('\nFull results saved to output/grid-search-results.json');
  console.log(`Total time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
