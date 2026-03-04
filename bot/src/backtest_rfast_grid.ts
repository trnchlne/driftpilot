/**
 * Grid search for R-fast: optimise the fast-ATR regime strategy.
 *
 * R-fast's edge = faster ATR adaptation (30 vs 90) + shorter signal window (15m vs 25m).
 * This grid explores the parameter space around those axes.
 *
 * Usage: npx tsx src/backtest_rfast_grid.ts --data data/history-2y.jsonl
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import { RegimeStrategy } from './regime.js';
import type { RegimeConfig } from './regime.js';
import { BankrollManager } from './bankroll.js';

/* ─── Data Loading ───────────────────────────────────────── */

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

/* ─── Runner ─────────────────────────────────────────────── */

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
  // Multi-period ROIs
  roi1y: number;
  roi6m: number;
  roi3m: number;
  roi1m: number;
  periodsPositive: number;
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

function runOne(config: RegimeConfig, allTicks: Tick[], equity: number, kelly: number, periodSlices: Map<string, Tick[]>): GridResult {
  const full = runPeriod(config, allTicks, equity, kelly);

  // Multi-period check
  const r1y = periodSlices.has('1y') ? runPeriod(config, periodSlices.get('1y')!, equity, kelly) : { roi: 0 };
  const r6m = periodSlices.has('6m') ? runPeriod(config, periodSlices.get('6m')!, equity, kelly) : { roi: 0 };
  const r3m = periodSlices.has('3m') ? runPeriod(config, periodSlices.get('3m')!, equity, kelly) : { roi: 0 };
  const r1m = periodSlices.has('1m') ? runPeriod(config, periodSlices.get('1m')!, equity, kelly) : { roi: 0 };

  let periodsPositive = 0;
  if (full.roi > 0) periodsPositive++;
  if (r1y.roi > 0) periodsPositive++;
  if (r6m.roi > 0) periodsPositive++;
  if (r3m.roi > 0) periodsPositive++;
  if (r1m.roi > 0) periodsPositive++;

  return {
    name: config.name,
    config,
    kelly,
    roi: full.roi,
    trades: full.trades,
    winRate: full.winRate,
    sharpe: full.sharpe,
    profitFactor: full.profitFactor,
    maxDdPct: full.maxDdPct,
    finalEquity: full.finalEquity,
    roi1y: r1y.roi,
    roi6m: r6m.roi,
    roi3m: r3m.roi,
    roi1m: r1m.roi,
    periodsPositive,
  };
}

/* ─── Grid Generation ────────────────────────────────────── */

function generateGrid(): { config: RegimeConfig; kelly: number }[] {
  const grid: { config: RegimeConfig; kelly: number }[] = [];
  let idx = 0;

  // R-fast's key axes: fast ATR, short signal window, moderate stops
  const atrPeriods = [20, 30, 45, 60];
  const signalWindows = [10*60, 15*60, 20*60, 25*60];
  const signalMultiples = [3.0, 3.5, 4.0, 4.5, 5.0];
  const trails = [0.5, 0.8, 1.0, 1.5, 2.0];
  const trailDelays = [180, 300, 480];
  const regimes = [
    { trd: 1.2, rng: 0.8 },
    { trd: 1.2, rng: 1.0 },
    { trd: 1.5, rng: 0.5 },
    { trd: 1.5, rng: 1.0 },
    { trd: 2.0, rng: 0.5 },
  ];
  const kellys = [0.20, 0.25, 0.30];
  const cooldowns = [60, 120, 300];
  const meanWindows = [1*3600, 2*3600];
  const minAtrs = [0, 0.035];

  // Phase 1: Core grid — ATR × signal × trail (fixed regime, kelly, cd, mean)
  // This is the biggest sweep: 4 × 4 × 5 × 5 × 3 = 1200 combos
  for (const atr of atrPeriods) {
    for (const sigW of signalWindows) {
      for (const sigM of signalMultiples) {
        for (const tr of trails) {
          for (const delay of trailDelays) {
            grid.push({
              config: {
                type: 'regime', name: `F${idx++}`,
                atrPeriod: atr, regimeWindowSeconds: 4*3600,
                trendThreshold: 1.5, rangeThreshold: 0.5,
                signalWindowSeconds: sigW, signalMultiple: sigM,
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
  }

  // Phase 2: Regime combos on top performers' signal/trail ranges
  // 5 regimes × 3 best ATRs × 3 best signal combos × 3 trails = 135 × 3 kelly = 405
  const bestAtrs = [20, 30, 45];
  const bestSignals = [
    { m: 3.5, w: 15*60 },
    { m: 4.0, w: 15*60 },
    { m: 4.0, w: 20*60 },
  ];
  const bestTrails = [
    { tr: 0.8, delay: 300 },
    { tr: 1.0, delay: 300 },
    { tr: 1.5, delay: 480 },
  ];

  for (const reg of regimes) {
    for (const atr of bestAtrs) {
      for (const sig of bestSignals) {
        for (const trl of bestTrails) {
          for (const kelly of kellys) {
            grid.push({
              config: {
                type: 'regime', name: `FR${idx++}`,
                atrPeriod: atr, regimeWindowSeconds: 4*3600,
                trendThreshold: reg.trd, rangeThreshold: reg.rng,
                signalWindowSeconds: sig.w, signalMultiple: sig.m,
                trailingAtrMultiple: trl.tr, slAtrMultiple: 2.5,
                trailDelaySeconds: trl.delay,
                meanWindowSeconds: 2*3600, entryBandMultiple: 2.5,
                reversionSlMultiple: 4.0, cooldownSeconds: 120,
                betSizeSol: 1.0, minAtrPct: 0.035,
              },
              kelly,
            });
          }
        }
      }
    }
  }

  // Phase 3: Cooldown × mean window × minAtr on promising combos
  // 3 cd × 2 mean × 2 minAtr × 4 combos × 2 kelly = 96
  const promCombos = [
    { atr: 30, sigM: 4.0, sigW: 15*60, tr: 1.5, delay: 480, trd: 1.5, rng: 0.5 },
    { atr: 30, sigM: 3.5, sigW: 15*60, tr: 1.0, delay: 300, trd: 1.5, rng: 0.5 },
    { atr: 20, sigM: 4.0, sigW: 15*60, tr: 0.8, delay: 300, trd: 1.2, rng: 1.0 },
    { atr: 45, sigM: 4.0, sigW: 20*60, tr: 1.0, delay: 300, trd: 1.5, rng: 0.5 },
  ];

  for (const p of promCombos) {
    for (const cd of cooldowns) {
      for (const mw of meanWindows) {
        for (const ma of minAtrs) {
          for (const kelly of [0.25, 0.30]) {
            grid.push({
              config: {
                type: 'regime', name: `FX${idx++}`,
                atrPeriod: p.atr, regimeWindowSeconds: 4*3600,
                trendThreshold: p.trd, rangeThreshold: p.rng,
                signalWindowSeconds: p.sigW, signalMultiple: p.sigM,
                trailingAtrMultiple: p.tr, slAtrMultiple: 2.5,
                trailDelaySeconds: p.delay,
                meanWindowSeconds: mw, entryBandMultiple: 2.5,
                reversionSlMultiple: 4.0, cooldownSeconds: cd,
                betSizeSol: 1.0, minAtrPct: ma || undefined,
              },
              kelly,
            });
          }
        }
      }
    }
  }

  return grid;
}

/* ─── Formatting ─────────────────────────────────────────── */

function fmtRoi(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/* ─── Main ───────────────────────────────────────────────── */

function main(): void {
  let dataPath = '';
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--data' && process.argv[i + 1]) {
      dataPath = process.argv[i + 1]; i++;
    }
  }
  if (!dataPath) {
    console.error('Usage: npx tsx src/backtest_rfast_grid.ts --data <path>');
    process.exit(1);
  }

  const ticks = loadTicks(resolve(dataPath));
  const totalHours = ticks.length > 1 ? (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 3600 : 0;
  console.log(`[rfast-grid] ${ticks.length.toLocaleString()} ticks loaded (${(totalHours / 24).toFixed(0)} days)`);
  console.log(`[rfast-grid] SOL: $${ticks[0].price.toFixed(2)} → $${ticks[ticks.length - 1].price.toFixed(2)}`);

  // Build period slices
  const lastTime = ticks[ticks.length - 1].publishTime;
  const periodSlices = new Map<string, Tick[]>();
  const periods = [
    { key: '1y', seconds: 365 * 24 * 3600 },
    { key: '6m', seconds: 180 * 24 * 3600 },
    { key: '3m', seconds: 90 * 24 * 3600 },
    { key: '1m', seconds: 30 * 24 * 3600 },
  ];
  for (const p of periods) {
    const cutoff = lastTime - p.seconds;
    const slice = ticks.filter(t => t.publishTime >= cutoff);
    if (slice.length > 100) {
      periodSlices.set(p.key, slice);
    }
  }
  console.log(`[rfast-grid] Period slices: ${[...periodSlices.keys()].join(', ')}`);

  const equity = 3.0;
  const grid = generateGrid();
  console.log(`[rfast-grid] ${grid.length} combos to test, ${equity} SOL each\n`);

  // Phase 1: run core grid (fast, single-period only)
  const phase1Count = grid.filter(g => g.config.name.startsWith('F') && !g.config.name.startsWith('FR') && !g.config.name.startsWith('FX')).length;
  console.log(`[rfast-grid] Phase 1: ${phase1Count} core combos (full period only)...`);

  const results: GridResult[] = [];
  const t0 = Date.now();

  for (let i = 0; i < grid.length; i++) {
    const { config, kelly } = grid[i];

    // Phase 1 configs: only run full period first (fast screening)
    if (config.name.startsWith('F') && !config.name.startsWith('FR') && !config.name.startsWith('FX')) {
      const full = runPeriod(config, ticks, equity, kelly);
      results.push({
        name: config.name, config, kelly,
        roi: full.roi, trades: full.trades, winRate: full.winRate,
        sharpe: full.sharpe, profitFactor: full.profitFactor,
        maxDdPct: full.maxDdPct, finalEquity: full.finalEquity,
        roi1y: 0, roi6m: 0, roi3m: 0, roi1m: 0, periodsPositive: full.roi > 0 ? 1 : 0,
      });
    } else {
      // Phase 2 & 3: run all periods
      const r = runOne(config, ticks, equity, kelly, periodSlices);
      results.push(r);
    }

    if ((i + 1) % 50 === 0 || i === grid.length - 1) {
      const elapsed = (Date.now() - t0) / 1000;
      const eta = elapsed / (i + 1) * (grid.length - i - 1);
      process.stderr.write(`\r[rfast-grid] ${i + 1}/${grid.length} done (${elapsed.toFixed(0)}s, ETA ${eta.toFixed(0)}s)  `);
    }
  }

  // Phase 1 rerun: top 100 core configs get multi-period analysis
  console.log('\n[rfast-grid] Phase 1 rerun: multi-period analysis on top 100 core configs...');
  const coreResults = results.filter(r => r.name.startsWith('F') && !r.name.startsWith('FR') && !r.name.startsWith('FX'));
  coreResults.sort((a, b) => b.roi - a.roi);
  const top100 = coreResults.slice(0, 100);

  for (let i = 0; i < top100.length; i++) {
    const r = top100[i];
    const full = runOne(r.config, ticks, equity, r.kelly, periodSlices);
    // Update in place
    const idx2 = results.indexOf(r);
    if (idx2 >= 0) results[idx2] = full;
    if ((i + 1) % 20 === 0) {
      process.stderr.write(`\r[rfast-grid] Rerun ${i + 1}/100  `);
    }
  }

  console.log('');
  console.log(`\n[rfast-grid] Complete in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Sort by ROI
  results.sort((a, b) => b.roi - a.roi);

  // Also run current R-fast for comparison
  const currentRfast: RegimeConfig = {
    type: 'regime', name: 'R-fast-current',
    atrPeriod: 30, regimeWindowSeconds: 4*3600,
    trendThreshold: 1.5, rangeThreshold: 0.5,
    signalWindowSeconds: 15*60, signalMultiple: 4.0,
    trailingAtrMultiple: 1.5, slAtrMultiple: 2.5,
    trailDelaySeconds: 480,
    meanWindowSeconds: 2*3600, entryBandMultiple: 2.5,
    reversionSlMultiple: 4.0, cooldownSeconds: 300,
    betSizeSol: 1.0,
  };
  const currentResult = runOne(currentRfast, ticks, equity, 0.30, periodSlices);
  console.log(`  ═══ CURRENT R-FAST BASELINE ═══`);
  console.log(`  ROI: ${fmtRoi(currentResult.roi)} | Trades: ${currentResult.trades} | WR: ${currentResult.winRate.toFixed(1)}% | Sharpe: ${currentResult.sharpe.toFixed(3)} | MaxDD: ${currentResult.maxDdPct.toFixed(1)}% | PF: ${currentResult.profitFactor.toFixed(2)}`);
  console.log(`  1Y: ${fmtRoi(currentResult.roi1y)} | 6M: ${fmtRoi(currentResult.roi6m)} | 3M: ${fmtRoi(currentResult.roi3m)} | 1M: ${fmtRoi(currentResult.roi1m)} | Periods+: ${currentResult.periodsPositive}/5`);
  console.log('');

  // Summary counts
  const over50 = results.filter(r => r.roi >= 50).length;
  const over30 = results.filter(r => r.roi >= 30).length;
  const over10 = results.filter(r => r.roi >= 10).length;
  const allPositive = results.filter(r => r.periodsPositive >= 5).length;

  console.log(`  ═══ RESULTS (${equity} SOL, ${results.length} combos) ═══`);
  console.log(`  50%+ ROI: ${over50} | 30%+ ROI: ${over30} | 10%+ ROI: ${over10}`);
  console.log(`  All 5 periods positive: ${allPositive}`);
  console.log('');

  // Top 50 — sorted by ROI
  console.log('  ═══ TOP 50 BY ROI ═══');
  console.log('  Rank  Name       ROI%    Eq     Trades  WR%    Sharpe   PF    MaxDD%  Per+  1Y       6M       3M       1M     | Kelly  atr  sigM  sigW  tr    delay  trd   rng   cd    mean  minAtr');
  console.log('  ' + '─'.repeat(175));

  for (let i = 0; i < Math.min(50, results.length); i++) {
    const r = results[i];
    const c = r.config;
    console.log(
      `  ${`#${i+1}`.padStart(4)}  ${r.name.padEnd(9)}  ${fmtRoi(r.roi).padStart(7)}  ${r.finalEquity.toFixed(2).padStart(5)}  ${String(r.trades).padStart(6)}  ${`${r.winRate.toFixed(1)}%`.padStart(6)}  ${r.sharpe.toFixed(3).padStart(7)}  ${(r.profitFactor === Infinity ? 'Inf' : r.profitFactor.toFixed(2)).padStart(5)}  ${`${r.maxDdPct.toFixed(1)}%`.padStart(6)}  ${`${r.periodsPositive}/5`.padStart(4)}  ${fmtRoi(r.roi1y).padStart(7)}  ${fmtRoi(r.roi6m).padStart(7)}  ${fmtRoi(r.roi3m).padStart(7)}  ${fmtRoi(r.roi1m).padStart(7)}  | ${`${(r.kelly*100).toFixed(0)}%`.padStart(4)}  ${String(c.atrPeriod).padStart(3)}  ${String(c.signalMultiple).padStart(4)}  ${`${c.signalWindowSeconds/60}m`.padStart(4)}  ${String(c.trailingAtrMultiple).padStart(4)}  ${String(c.trailDelaySeconds).padStart(5)}  ${String(c.trendThreshold).padStart(4)}  ${String(c.rangeThreshold).padStart(4)}  ${String(c.cooldownSeconds).padStart(4)}  ${`${c.meanWindowSeconds/3600}h`.padStart(4)}  ${String(c.minAtrPct ?? 0).padStart(5)}`
    );
  }

  // Top 20 with ALL periods positive
  const allPosResults = results.filter(r => r.periodsPositive >= 5).sort((a, b) => b.roi - a.roi);
  if (allPosResults.length > 0) {
    console.log('');
    console.log(`  ═══ TOP 20 WITH ALL 5 PERIODS POSITIVE ═══`);
    console.log('  Rank  Name       ROI%    Trades  WR%    Sharpe   PF    MaxDD%  1Y       6M       3M       1M     | atr  sigM  sigW  tr    delay  trd   rng   cd    minAtr');
    console.log('  ' + '─'.repeat(155));
    for (let i = 0; i < Math.min(20, allPosResults.length); i++) {
      const r = allPosResults[i];
      const c = r.config;
      console.log(
        `  ${`#${i+1}`.padStart(4)}  ${r.name.padEnd(9)}  ${fmtRoi(r.roi).padStart(7)}  ${String(r.trades).padStart(6)}  ${`${r.winRate.toFixed(1)}%`.padStart(6)}  ${r.sharpe.toFixed(3).padStart(7)}  ${(r.profitFactor === Infinity ? 'Inf' : r.profitFactor.toFixed(2)).padStart(5)}  ${`${r.maxDdPct.toFixed(1)}%`.padStart(6)}  ${fmtRoi(r.roi1y).padStart(7)}  ${fmtRoi(r.roi6m).padStart(7)}  ${fmtRoi(r.roi3m).padStart(7)}  ${fmtRoi(r.roi1m).padStart(7)}  | ${String(c.atrPeriod).padStart(3)}  ${String(c.signalMultiple).padStart(4)}  ${`${c.signalWindowSeconds/60}m`.padStart(4)}  ${String(c.trailingAtrMultiple).padStart(4)}  ${String(c.trailDelaySeconds).padStart(5)}  ${String(c.trendThreshold).padStart(4)}  ${String(c.rangeThreshold).padStart(4)}  ${String(c.cooldownSeconds).padStart(4)}  ${String(c.minAtrPct ?? 0).padStart(5)}`
      );
    }
  }

  // Parameter frequency analysis for top 50
  console.log('');
  console.log('  ═══ PARAMETER FREQUENCY IN TOP 50 ═══');
  const top50 = results.slice(0, 50);
  const freq = (key: string, extract: (c: RegimeConfig) => number | string) => {
    const counts = new Map<string, number>();
    for (const r of top50) {
      const v = String(extract(r.config));
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`  ${key.padEnd(12)} ${sorted.map(([v, c]) => `${v}(${c})`).join('  ')}`);
  };

  freq('atrPeriod', c => c.atrPeriod);
  freq('signalMult', c => c.signalMultiple);
  freq('signalWin', c => `${c.signalWindowSeconds/60}m`);
  freq('trail', c => c.trailingAtrMultiple);
  freq('trailDelay', c => c.trailDelaySeconds);
  freq('trendThr', c => c.trendThreshold);
  freq('rangeThr', c => c.rangeThreshold);
  freq('cooldown', c => c.cooldownSeconds);
  freq('meanWin', c => `${c.meanWindowSeconds/3600}h`);
  freq('minAtr', c => c.minAtrPct ?? 0);

  // Print top 5 configs in strategies.ts format
  console.log('');
  console.log('  ═══ TOP 5 FOR strategies.ts ═══');
  // Prefer configs that are positive in all periods
  const bestConfigs = allPosResults.length >= 5 ? allPosResults : results;
  for (let i = 0; i < Math.min(5, bestConfigs.length); i++) {
    const r = bestConfigs[i];
    const c = r.config;
    console.log(`  // #${i+1}: ${fmtRoi(r.roi)} ROI, ${r.trades} trades, ${r.winRate.toFixed(1)}% WR, Sharpe ${r.sharpe.toFixed(3)}, MaxDD ${r.maxDdPct.toFixed(1)}%, ${r.periodsPositive}/5 periods+`);
    console.log(`  //      1Y ${fmtRoi(r.roi1y)} | 6M ${fmtRoi(r.roi6m)} | 3M ${fmtRoi(r.roi3m)} | 1M ${fmtRoi(r.roi1m)}`);
    console.log(`  { type: 'regime', name: 'R-fast', atrPeriod: ${c.atrPeriod}, regimeWindowSeconds: ${c.regimeWindowSeconds}, trendThreshold: ${c.trendThreshold}, rangeThreshold: ${c.rangeThreshold}, signalWindowSeconds: ${c.signalWindowSeconds}, signalMultiple: ${c.signalMultiple}, trailingAtrMultiple: ${c.trailingAtrMultiple}, slAtrMultiple: ${c.slAtrMultiple}, trailDelaySeconds: ${c.trailDelaySeconds}, meanWindowSeconds: ${c.meanWindowSeconds}, entryBandMultiple: ${c.entryBandMultiple}, reversionSlMultiple: ${c.reversionSlMultiple}, cooldownSeconds: ${c.cooldownSeconds}, betSizeSol: 1.0${c.minAtrPct ? `, minAtrPct: ${c.minAtrPct}` : ''} },`);
    console.log(`  // Kelly: ${(r.kelly*100).toFixed(0)}%`);
  }
}

main();
