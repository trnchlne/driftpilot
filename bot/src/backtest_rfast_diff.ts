/**
 * R-fast grid search #2: find configs maximally DIFFERENT from R-base.
 *
 * R-base uses: atr=90, signal=25m/4.5, trail=0.8, trd=1.2, rng=1.0, mean=1h, cd=120
 * This grid EXCLUDES R-base's signal params (25m/4.5) and explores
 * short signal windows (10-20m), different multiples (3.0-5.0), and
 * varied regime thresholds.
 *
 * Usage: npx tsx src/backtest_rfast_diff.ts --data data/history-2y.jsonl
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import { RegimeStrategy } from './regime.js';
import type { RegimeConfig } from './regime.js';
import { BankrollManager } from './bankroll.js';

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

interface GridResult {
  name: string;
  config: RegimeConfig;
  kelly: number;
  roi: number;
  trades: number;
  winRate: number;
  sharpe: number;
  profitFactor: number;
  maxDdPct: number;
  finalEquity: number;
  roi1y: number;
  roi6m: number;
  roi3m: number;
  roi1m: number;
  periodsPositive: number;
  // Differentiation score from R-base
  diffScore: number;
}

function runPeriod(config: RegimeConfig, ticks: Tick[], equity: number, kelly: number): {
  roi: number; trades: number; winRate: number; sharpe: number; profitFactor: number; maxDdPct: number; finalEquity: number;
} {
  const bankroll = new BankrollManager({
    mode: 'paper',
    initialEquitySol: equity,
    kellyOverride: kelly,
    maxBetOverride: 0.30,
  });
  const strat = new RegimeStrategy(config);
  strat.setBankroll(bankroll);

  const origLog = console.log;
  console.log = () => {};

  let peak = equity;
  let maxDd = 0;
  let lastSnap = 0;

  for (const tick of ticks) {
    bankroll.updateSolPrice(tick.price);
    strat.onTick(tick);

    if (tick.publishTime - lastSnap >= 60) {
      const eq = bankroll.getEquity();
      if (eq > peak) peak = eq;
      const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
      if (dd > maxDd) maxDd = dd;
      lastSnap = tick.publishTime;
    }
  }

  console.log = origLog;
  strat.stop();

  const m = strat.getMetrics();
  const finalEq = bankroll.getEquity();

  return {
    roi: ((finalEq / equity) - 1) * 100,
    trades: m.totalTrades,
    winRate: m.winRate,
    sharpe: m.sharpe,
    profitFactor: m.profitFactor,
    maxDdPct: maxDd,
    finalEquity: finalEq,
  };
}

/**
 * How different is this config from R-base?
 * Higher = more differentiated.
 * R-base: atr=90, signal=25m/4.5, trail=0.8, trd=1.2, rng=1.0, mean=1h
 */
function diffFromRbase(c: RegimeConfig): number {
  let score = 0;

  // Signal window difference (25m = 1500s baseline)
  score += Math.abs(c.signalWindowSeconds - 1500) / 300; // each 5m diff = +1

  // Signal multiple difference (4.5 baseline)
  score += Math.abs(c.signalMultiple - 4.5) * 2;

  // ATR period (90 baseline)
  score += Math.abs(c.atrPeriod - 90) / 15;

  // Trail (0.8 baseline)
  score += Math.abs(c.trailingAtrMultiple - 0.8) * 1.5;

  // Regime thresholds (1.2/1.0 baseline)
  score += Math.abs(c.trendThreshold - 1.2) * 2;
  score += Math.abs(c.rangeThreshold - 1.0) * 2;

  // Mean window (1h baseline)
  score += Math.abs(c.meanWindowSeconds - 3600) / 1800;

  return score;
}

function generateGrid(): { config: RegimeConfig; kelly: number }[] {
  const grid: { config: RegimeConfig; kelly: number }[] = [];
  let idx = 0;

  // ── Signal params: EXCLUDE R-base's 25m/4.5 ──
  const signals = [
    // Short windows (very different from R-base's 25m)
    { m: 3.0, w: 10*60 },
    { m: 3.5, w: 10*60 },
    { m: 4.0, w: 10*60 },
    { m: 5.0, w: 10*60 },
    // Medium windows
    { m: 3.0, w: 15*60 },
    { m: 3.5, w: 15*60 },
    { m: 4.0, w: 15*60 },
    { m: 5.0, w: 15*60 },
    // 20m with non-4.5 multiples
    { m: 3.0, w: 20*60 },
    { m: 3.5, w: 20*60 },
    { m: 5.0, w: 20*60 },
    // 25m with non-4.5 multiples only
    { m: 3.0, w: 25*60 },
    { m: 3.5, w: 25*60 },
    { m: 5.0, w: 25*60 },
  ];

  const atrPeriods = [15, 20, 30, 45];
  const trails = [0.5, 1.0, 1.5, 2.0, 2.5];
  const trailDelays = [120, 300, 480];
  const regimes = [
    { trd: 1.5, rng: 0.3 },
    { trd: 1.5, rng: 0.5 },
    { trd: 2.0, rng: 0.3 },
    { trd: 2.0, rng: 0.5 },
    { trd: 2.0, rng: 0.8 },
    { trd: 1.0, rng: 0.3 },
  ];
  const cooldowns = [60, 120, 300];
  const meanWindows = [30*60, 1*3600, 2*3600];
  const entryBands = [1.5, 2.5, 3.5];

  // Phase 1: Core sweep — signals × ATR × trails (fixed regime/cd/mean)
  // 14 signals × 4 atr × 5 trails × 3 delays = 840
  for (const sig of signals) {
    for (const atr of atrPeriods) {
      for (const tr of trails) {
        for (const delay of trailDelays) {
          grid.push({
            config: {
              type: 'regime', name: `D${idx++}`,
              atrPeriod: atr, regimeWindowSeconds: 4*3600,
              trendThreshold: 1.5, rangeThreshold: 0.5,
              signalWindowSeconds: sig.w, signalMultiple: sig.m,
              trailingAtrMultiple: tr, slAtrMultiple: 2.5,
              trailDelaySeconds: delay,
              meanWindowSeconds: 2*3600, entryBandMultiple: 2.5,
              reversionSlMultiple: 4.0, cooldownSeconds: 120,
              betSizeSol: 1.0, minAtrPct: 0.035,
            },
            kelly: 0.30,
          });
        }
      }
    }
  }

  // Phase 2: Regime × cooldown × mean on differentiated signal combos
  // 6 regimes × 3 cd × 3 mean × 6 signal combos = 324
  const diffSignals = [
    { m: 3.5, w: 10*60 },
    { m: 5.0, w: 10*60 },
    { m: 3.5, w: 15*60 },
    { m: 5.0, w: 15*60 },
    { m: 3.0, w: 20*60 },
    { m: 5.0, w: 20*60 },
  ];
  const bestTrails2 = [1.0, 1.5, 2.0];

  for (const reg of regimes) {
    for (const cd of cooldowns) {
      for (const mw of meanWindows) {
        for (const sig of diffSignals) {
          for (const tr of bestTrails2) {
            grid.push({
              config: {
                type: 'regime', name: `DR${idx++}`,
                atrPeriod: 30, regimeWindowSeconds: 4*3600,
                trendThreshold: reg.trd, rangeThreshold: reg.rng,
                signalWindowSeconds: sig.w, signalMultiple: sig.m,
                trailingAtrMultiple: tr, slAtrMultiple: 2.5,
                trailDelaySeconds: 300,
                meanWindowSeconds: mw, entryBandMultiple: 2.5,
                reversionSlMultiple: 4.0, cooldownSeconds: cd,
                betSizeSol: 1.0, minAtrPct: 0.035,
              },
              kelly: 0.30,
            });
          }
        }
      }
    }
  }

  // Phase 3: Entry band + reversion SL variations
  // 3 bands × 6 signal combos × 3 trails × 2 revSL = 108
  const revSLs = [3.0, 5.0];
  for (const band of entryBands) {
    for (const sig of diffSignals) {
      for (const tr of bestTrails2) {
        for (const revSL of revSLs) {
          grid.push({
            config: {
              type: 'regime', name: `DB${idx++}`,
              atrPeriod: 30, regimeWindowSeconds: 4*3600,
              trendThreshold: 1.5, rangeThreshold: 0.5,
              signalWindowSeconds: sig.w, signalMultiple: sig.m,
              trailingAtrMultiple: tr, slAtrMultiple: 2.5,
              trailDelaySeconds: 300,
              meanWindowSeconds: 2*3600, entryBandMultiple: band,
              reversionSlMultiple: revSL, cooldownSeconds: 120,
              betSizeSol: 1.0, minAtrPct: 0.035,
            },
            kelly: 0.30,
          });
        }
      }
    }
  }

  return grid;
}

function fmtRoi(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function main(): void {
  let dataPath = '';
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--data' && process.argv[i + 1]) {
      dataPath = process.argv[i + 1]; i++;
    }
  }
  if (!dataPath) {
    console.error('Usage: npx tsx src/backtest_rfast_diff.ts --data <path>');
    process.exit(1);
  }

  const ticks = loadTicks(resolve(dataPath));
  const totalHours = ticks.length > 1 ? (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 3600 : 0;
  console.log(`[diff-grid] ${ticks.length.toLocaleString()} ticks loaded (${(totalHours / 24).toFixed(0)} days)`);
  console.log(`[diff-grid] SOL: $${ticks[0].price.toFixed(2)} → $${ticks[ticks.length - 1].price.toFixed(2)}`);

  // Period slices
  const lastTime = ticks[ticks.length - 1].publishTime;
  const periodSlices = new Map<string, Tick[]>();
  for (const { key, seconds } of [
    { key: '1y', seconds: 365*24*3600 },
    { key: '6m', seconds: 180*24*3600 },
    { key: '3m', seconds: 90*24*3600 },
    { key: '1m', seconds: 30*24*3600 },
  ]) {
    const cutoff = lastTime - seconds;
    const slice = ticks.filter(t => t.publishTime >= cutoff);
    if (slice.length > 100) periodSlices.set(key, slice);
  }

  const equity = 3.0;
  const grid = generateGrid();
  console.log(`[diff-grid] ${grid.length} combos to test\n`);

  // Phase 1: single-period screening for core grid
  const results: GridResult[] = [];
  const t0 = Date.now();

  for (let i = 0; i < grid.length; i++) {
    const { config, kelly } = grid[i];

    if (config.name.startsWith('D') && !config.name.startsWith('DR') && !config.name.startsWith('DB')) {
      // Phase 1: fast single-period screening
      const full = runPeriod(config, ticks, equity, kelly);
      results.push({
        name: config.name, config, kelly,
        roi: full.roi, trades: full.trades, winRate: full.winRate,
        sharpe: full.sharpe, profitFactor: full.profitFactor,
        maxDdPct: full.maxDdPct, finalEquity: full.finalEquity,
        roi1y: 0, roi6m: 0, roi3m: 0, roi1m: 0,
        periodsPositive: full.roi > 0 ? 1 : 0,
        diffScore: diffFromRbase(config),
      });
    } else {
      // Phase 2 & 3: multi-period
      const full = runPeriod(config, ticks, equity, kelly);
      const r1y = periodSlices.has('1y') ? runPeriod(config, periodSlices.get('1y')!, equity, kelly) : { roi: 0 };
      const r6m = periodSlices.has('6m') ? runPeriod(config, periodSlices.get('6m')!, equity, kelly) : { roi: 0 };
      const r3m = periodSlices.has('3m') ? runPeriod(config, periodSlices.get('3m')!, equity, kelly) : { roi: 0 };
      const r1m = periodSlices.has('1m') ? runPeriod(config, periodSlices.get('1m')!, equity, kelly) : { roi: 0 };

      let pp = 0;
      if (full.roi > 0) pp++;
      if (r1y.roi > 0) pp++;
      if (r6m.roi > 0) pp++;
      if (r3m.roi > 0) pp++;
      if (r1m.roi > 0) pp++;

      results.push({
        name: config.name, config, kelly,
        roi: full.roi, trades: full.trades, winRate: full.winRate,
        sharpe: full.sharpe, profitFactor: full.profitFactor,
        maxDdPct: full.maxDdPct, finalEquity: full.finalEquity,
        roi1y: r1y.roi, roi6m: r6m.roi, roi3m: r3m.roi, roi1m: r1m.roi,
        periodsPositive: pp,
        diffScore: diffFromRbase(config),
      });
    }

    if ((i + 1) % 50 === 0 || i === grid.length - 1) {
      const elapsed = (Date.now() - t0) / 1000;
      const eta = elapsed / (i + 1) * (grid.length - i - 1);
      process.stderr.write(`\r[diff-grid] ${i + 1}/${grid.length} done (${elapsed.toFixed(0)}s, ETA ${eta.toFixed(0)}s)  `);
    }
  }

  // Rerun top 150 core configs with multi-period
  console.log('\n[diff-grid] Rerunning top 150 core configs with multi-period...');
  const coreResults = results.filter(r => r.name.startsWith('D') && !r.name.startsWith('DR') && !r.name.startsWith('DB'));
  coreResults.sort((a, b) => b.roi - a.roi);
  const topN = coreResults.slice(0, 150);

  for (let i = 0; i < topN.length; i++) {
    const r = topN[i];
    const c = r.config;
    const full = runPeriod(c, ticks, equity, r.kelly);
    const r1y = periodSlices.has('1y') ? runPeriod(c, periodSlices.get('1y')!, equity, r.kelly) : { roi: 0 };
    const r6m = periodSlices.has('6m') ? runPeriod(c, periodSlices.get('6m')!, equity, r.kelly) : { roi: 0 };
    const r3m = periodSlices.has('3m') ? runPeriod(c, periodSlices.get('3m')!, equity, r.kelly) : { roi: 0 };
    const r1m = periodSlices.has('1m') ? runPeriod(c, periodSlices.get('1m')!, equity, r.kelly) : { roi: 0 };

    let pp = 0;
    if (full.roi > 0) pp++;
    if (r1y.roi > 0) pp++;
    if (r6m.roi > 0) pp++;
    if (r3m.roi > 0) pp++;
    if (r1m.roi > 0) pp++;

    const idx2 = results.indexOf(r);
    if (idx2 >= 0) {
      results[idx2] = { ...r, roi1y: r1y.roi, roi6m: r6m.roi, roi3m: r3m.roi, roi1m: r1m.roi, periodsPositive: pp };
    }

    if ((i + 1) % 30 === 0) process.stderr.write(`\r[diff-grid] Rerun ${i + 1}/150  `);
  }

  console.log('');
  console.log(`\n[diff-grid] Complete in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // ═══ RESULTS ═══

  // Current R-base for comparison
  const rbaseConfig: RegimeConfig = {
    type: 'regime', name: 'R-base',
    atrPeriod: 90, regimeWindowSeconds: 4*3600,
    trendThreshold: 1.2, rangeThreshold: 1.0,
    signalWindowSeconds: 25*60, signalMultiple: 4.5,
    trailingAtrMultiple: 0.8, slAtrMultiple: 1.0,
    trailDelaySeconds: 300,
    meanWindowSeconds: 1*3600, entryBandMultiple: 2.5,
    reversionSlMultiple: 4.0, cooldownSeconds: 120,
    betSizeSol: 1.0, minAtrPct: 0.035, uncertainMultiple: 1.0,
  };
  const rbaseResult = runPeriod(rbaseConfig, ticks, equity, 0.30);
  const rb1y = periodSlices.has('1y') ? runPeriod(rbaseConfig, periodSlices.get('1y')!, equity, 0.30) : { roi: 0 };
  const rb6m = periodSlices.has('6m') ? runPeriod(rbaseConfig, periodSlices.get('6m')!, equity, 0.30) : { roi: 0 };
  const rb3m = periodSlices.has('3m') ? runPeriod(rbaseConfig, periodSlices.get('3m')!, equity, 0.30) : { roi: 0 };
  const rb1m = periodSlices.has('1m') ? runPeriod(rbaseConfig, periodSlices.get('1m')!, equity, 0.30) : { roi: 0 };

  console.log(`  ═══ R-BASE BASELINE ═══`);
  console.log(`  ROI: ${fmtRoi(rbaseResult.roi)} | Trades: ${rbaseResult.trades} | WR: ${rbaseResult.winRate.toFixed(1)}% | Sharpe: ${rbaseResult.sharpe.toFixed(3)} | MaxDD: ${rbaseResult.maxDdPct.toFixed(1)}%`);
  console.log(`  1Y: ${fmtRoi(rb1y.roi)} | 6M: ${fmtRoi(rb6m.roi)} | 3M: ${fmtRoi(rb3m.roi)} | 1M: ${fmtRoi(rb1m.roi)}`);
  console.log('');

  // Sort by ROI
  results.sort((a, b) => b.roi - a.roi);

  // Top 30 by ROI
  console.log('  ═══ TOP 30 BY ROI (all differentiated from R-base) ═══');
  console.log('  Rank  Name       ROI%    Trades  WR%    Sharpe   PF    MaxDD%  Per+  Diff  1Y       6M       3M       1M     | atr  sigM  sigW  tr    delay  trd   rng   cd    mean  band');
  console.log('  ' + '─'.repeat(175));

  for (let i = 0; i < Math.min(30, results.length); i++) {
    const r = results[i];
    const c = r.config;
    console.log(
      `  ${`#${i+1}`.padStart(4)}  ${r.name.padEnd(9)}  ${fmtRoi(r.roi).padStart(7)}  ${String(r.trades).padStart(6)}  ${`${r.winRate.toFixed(1)}%`.padStart(6)}  ${r.sharpe.toFixed(3).padStart(7)}  ${(r.profitFactor === Infinity ? 'Inf' : r.profitFactor.toFixed(2)).padStart(5)}  ${`${r.maxDdPct.toFixed(1)}%`.padStart(6)}  ${`${r.periodsPositive}/5`.padStart(4)}  ${r.diffScore.toFixed(1).padStart(4)}  ${fmtRoi(r.roi1y).padStart(7)}  ${fmtRoi(r.roi6m).padStart(7)}  ${fmtRoi(r.roi3m).padStart(7)}  ${fmtRoi(r.roi1m).padStart(7)}  | ${String(c.atrPeriod).padStart(3)}  ${String(c.signalMultiple).padStart(4)}  ${`${c.signalWindowSeconds/60}m`.padStart(4)}  ${String(c.trailingAtrMultiple).padStart(4)}  ${String(c.trailDelaySeconds).padStart(5)}  ${String(c.trendThreshold).padStart(4)}  ${String(c.rangeThreshold).padStart(4)}  ${String(c.cooldownSeconds).padStart(4)}  ${`${c.meanWindowSeconds/3600}h`.padStart(4)}  ${String(c.entryBandMultiple).padStart(4)}`
    );
  }

  // Top 20 ALL periods positive, sorted by combo of ROI and diff score
  const allPos = results.filter(r => r.periodsPositive >= 5).sort((a, b) => {
    // Rank by ROI but boost high-diff configs
    const scoreA = a.roi * (1 + a.diffScore / 20);
    const scoreB = b.roi * (1 + b.diffScore / 20);
    return scoreB - scoreA;
  });

  if (allPos.length > 0) {
    console.log('');
    console.log(`  ═══ TOP 20 — ALL 5 PERIODS POSITIVE (sorted by ROI × differentiation) ═══`);
    console.log('  Rank  Name       ROI%    Trades  WR%    Sharpe   PF    MaxDD%  Diff  1Y       6M       3M       1M     | atr  sigM  sigW  tr    delay  trd   rng   cd    mean  band');
    console.log('  ' + '─'.repeat(165));

    for (let i = 0; i < Math.min(20, allPos.length); i++) {
      const r = allPos[i];
      const c = r.config;
      console.log(
        `  ${`#${i+1}`.padStart(4)}  ${r.name.padEnd(9)}  ${fmtRoi(r.roi).padStart(7)}  ${String(r.trades).padStart(6)}  ${`${r.winRate.toFixed(1)}%`.padStart(6)}  ${r.sharpe.toFixed(3).padStart(7)}  ${(r.profitFactor === Infinity ? 'Inf' : r.profitFactor.toFixed(2)).padStart(5)}  ${`${r.maxDdPct.toFixed(1)}%`.padStart(6)}  ${r.diffScore.toFixed(1).padStart(4)}  ${fmtRoi(r.roi1y).padStart(7)}  ${fmtRoi(r.roi6m).padStart(7)}  ${fmtRoi(r.roi3m).padStart(7)}  ${fmtRoi(r.roi1m).padStart(7)}  | ${String(c.atrPeriod).padStart(3)}  ${String(c.signalMultiple).padStart(4)}  ${`${c.signalWindowSeconds/60}m`.padStart(4)}  ${String(c.trailingAtrMultiple).padStart(4)}  ${String(c.trailDelaySeconds).padStart(5)}  ${String(c.trendThreshold).padStart(4)}  ${String(c.rangeThreshold).padStart(4)}  ${String(c.cooldownSeconds).padStart(4)}  ${`${c.meanWindowSeconds/3600}h`.padStart(4)}  ${String(c.entryBandMultiple).padStart(4)}`
      );
    }
  }

  // Minimum diff score 8+ AND all periods positive
  const highDiffPos = results.filter(r => r.periodsPositive >= 5 && r.diffScore >= 8).sort((a, b) => b.roi - a.roi);
  if (highDiffPos.length > 0) {
    console.log('');
    console.log(`  ═══ HIGH DIFFERENTIATION (diff≥8) + ALL PERIODS POSITIVE (${highDiffPos.length} found) ═══`);
    console.log('  Rank  Name       ROI%    Trades  WR%    Sharpe   PF    MaxDD%  Diff  1Y       6M       3M       1M     | atr  sigM  sigW  tr    delay  trd   rng   cd    mean  band');
    console.log('  ' + '─'.repeat(165));
    for (let i = 0; i < Math.min(20, highDiffPos.length); i++) {
      const r = highDiffPos[i];
      const c = r.config;
      console.log(
        `  ${`#${i+1}`.padStart(4)}  ${r.name.padEnd(9)}  ${fmtRoi(r.roi).padStart(7)}  ${String(r.trades).padStart(6)}  ${`${r.winRate.toFixed(1)}%`.padStart(6)}  ${r.sharpe.toFixed(3).padStart(7)}  ${(r.profitFactor === Infinity ? 'Inf' : r.profitFactor.toFixed(2)).padStart(5)}  ${`${r.maxDdPct.toFixed(1)}%`.padStart(6)}  ${r.diffScore.toFixed(1).padStart(4)}  ${fmtRoi(r.roi1y).padStart(7)}  ${fmtRoi(r.roi6m).padStart(7)}  ${fmtRoi(r.roi3m).padStart(7)}  ${fmtRoi(r.roi1m).padStart(7)}  | ${String(c.atrPeriod).padStart(3)}  ${String(c.signalMultiple).padStart(4)}  ${`${c.signalWindowSeconds/60}m`.padStart(4)}  ${String(c.trailingAtrMultiple).padStart(4)}  ${String(c.trailDelaySeconds).padStart(5)}  ${String(c.trendThreshold).padStart(4)}  ${String(c.rangeThreshold).padStart(4)}  ${String(c.cooldownSeconds).padStart(4)}  ${`${c.meanWindowSeconds/3600}h`.padStart(4)}  ${String(c.entryBandMultiple).padStart(4)}`
      );
    }
  }

  // Parameter frequency in top 50 all-positive
  const top50pos = allPos.slice(0, 50);
  if (top50pos.length > 0) {
    console.log('');
    console.log(`  ═══ PARAM FREQUENCY — TOP 50 ALL-PERIODS-POSITIVE ═══`);
    const freq = (key: string, extract: (c: RegimeConfig) => number | string) => {
      const counts = new Map<string, number>();
      for (const r of top50pos) {
        const v = String(extract(r.config));
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      console.log(`  ${key.padEnd(12)} ${sorted.map(([v, c]) => `${v}(${c})`).join('  ')}`);
    };
    freq('atrPeriod', c => c.atrPeriod);
    freq('signalMult', c => c.signalMultiple);
    freq('signalWin', c => `${c.signalWindowSeconds / 60}m`);
    freq('trail', c => c.trailingAtrMultiple);
    freq('trailDelay', c => c.trailDelaySeconds);
    freq('trendThr', c => c.trendThreshold);
    freq('rangeThr', c => c.rangeThreshold);
    freq('cooldown', c => c.cooldownSeconds);
    freq('meanWin', c => `${c.meanWindowSeconds / 3600}h`);
    freq('entryBand', c => c.entryBandMultiple);
  }

  // strategies.ts output for top 3 high-diff all-positive
  const bestPicks = highDiffPos.length >= 3 ? highDiffPos : allPos;
  console.log('');
  console.log('  ═══ TOP 3 DIFFERENTIATED CONFIGS FOR strategies.ts ═══');
  for (let i = 0; i < Math.min(3, bestPicks.length); i++) {
    const r = bestPicks[i];
    const c = r.config;
    console.log(`  // #${i + 1}: ${fmtRoi(r.roi)} ROI, ${r.trades} trades, ${r.winRate.toFixed(1)}% WR, Sharpe ${r.sharpe.toFixed(3)}, MaxDD ${r.maxDdPct.toFixed(1)}%, ${r.periodsPositive}/5 periods+, diff=${r.diffScore.toFixed(1)}`);
    console.log(`  //      1Y ${fmtRoi(r.roi1y)} | 6M ${fmtRoi(r.roi6m)} | 3M ${fmtRoi(r.roi3m)} | 1M ${fmtRoi(r.roi1m)}`);
    console.log(`  //      vs R-base: atr ${c.atrPeriod} vs 90, signal ${c.signalWindowSeconds/60}m/${c.signalMultiple} vs 25m/4.5, trail ${c.trailingAtrMultiple} vs 0.8, regime ${c.trendThreshold}/${c.rangeThreshold} vs 1.2/1.0`);
    console.log(`  { type: 'regime', name: 'R-fast', atrPeriod: ${c.atrPeriod}, regimeWindowSeconds: ${c.regimeWindowSeconds}, trendThreshold: ${c.trendThreshold}, rangeThreshold: ${c.rangeThreshold}, signalWindowSeconds: ${c.signalWindowSeconds}, signalMultiple: ${c.signalMultiple}, trailingAtrMultiple: ${c.trailingAtrMultiple}, slAtrMultiple: ${c.slAtrMultiple}, trailDelaySeconds: ${c.trailDelaySeconds}, meanWindowSeconds: ${c.meanWindowSeconds}, entryBandMultiple: ${c.entryBandMultiple}, reversionSlMultiple: ${c.reversionSlMultiple}, cooldownSeconds: ${c.cooldownSeconds}, betSizeSol: 1.0, minAtrPct: ${c.minAtrPct ?? 0.035} },`);
  }
}

main();
