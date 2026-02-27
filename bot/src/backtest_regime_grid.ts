/**
 * Brute-force grid search over RegimeStrategy parameters.
 * Tests ~100 parameter combos on full 2Y data and ranks by ROI%.
 *
 * Usage: npx tsx src/backtest_regime_grid.ts --data data/history-2y.jsonl
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import { RegimeStrategy } from './regime.js';
import type { RegimeConfig } from './regime.js';
import { BankrollManager } from './bankroll.js';

/* ─── Data Loading (from backtest.ts) ────────────────────── */

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

/* ─── Single Config Runner ───────────────────────────────── */

interface GridResult {
  name: string;
  config: RegimeConfig;
  roi: number;
  trades: number;
  winRate: number;
  sharpe: number;
  profitFactor: number;
  maxDdPct: number;
}

function runOne(config: RegimeConfig, ticks: Tick[], equity: number): GridResult {
  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: equity });
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
    name: config.name,
    config,
    roi: ((finalEq / equity) - 1) * 100,
    trades: m.totalTrades,
    winRate: m.winRate,
    sharpe: m.sharpe,
    profitFactor: m.profitFactor,
    maxDdPct: maxDd,
  };
}

/* ─── Grid Generation ────────────────────────────────────── */

function generateGrid(): RegimeConfig[] {
  const configs: RegimeConfig[] = [];
  let idx = 0;

  // Signal dimension: (signalMultiple, signalWindowSeconds)
  const signals = [
    { m: 3.0, w: 15*60 }, { m: 4.0, w: 15*60 }, { m: 5.0, w: 15*60 },
    { m: 6.0, w: 15*60 }, { m: 8.0, w: 15*60 },
    { m: 2.5, w: 30*60 }, { m: 3.0, w: 30*60 }, { m: 4.0, w: 30*60 },
    { m: 5.0, w: 30*60 },
    { m: 2.0, w: 60*60 }, { m: 2.5, w: 60*60 }, { m: 3.0, w: 60*60 },
    { m: 4.0, w: 60*60 },
  ];

  // Stop dimension: (slAtrMultiple, trailingAtrMultiple, trailDelaySeconds)
  const stops = [
    { sl: 3.0, tr: 2.0, delay: 480 },
    { sl: 5.0, tr: 3.5, delay: 480 },
    { sl: 7.0, tr: 5.0, delay: 480 },
    { sl: 5.0, tr: 3.5, delay: 900 },
  ];

  // Regime dimension: (trendThreshold, rangeThreshold)
  const regimes = [
    { trd: 1.5, rng: 0.5 },
    { trd: 1.0, rng: 0.2 },
  ];

  // Core grid: 13 × 4 × 2 = 104
  for (const sig of signals) {
    for (const stp of stops) {
      for (const reg of regimes) {
        configs.push(makeConfig(`R-${idx++}`, {
          signalMultiple: sig.m,
          signalWindowSeconds: sig.w,
          slAtrMultiple: stp.sl,
          trailingAtrMultiple: stp.tr,
          trailDelaySeconds: stp.delay,
          trendThreshold: reg.trd,
          rangeThreshold: reg.rng,
        }));
      }
    }
  }

  // Wildcards
  // Ultra-conservative
  configs.push(makeConfig(`R-ultra-con`, {
    signalMultiple: 10.0, signalWindowSeconds: 60*60,
    slAtrMultiple: 8.0, trailingAtrMultiple: 6.0, trailDelaySeconds: 900,
    trendThreshold: 2.5, rangeThreshold: 0.5,
  }));

  // Reversion-only (almost always RANGING)
  configs.push(makeConfig(`R-rev-only`, {
    signalMultiple: 3.0, signalWindowSeconds: 15*60,
    slAtrMultiple: 5.0, trailingAtrMultiple: 3.5, trailDelaySeconds: 480,
    trendThreshold: 5.0, rangeThreshold: 3.0,
    entryBandMultiple: 3.0, reversionSlMultiple: 5.0,
  }));

  // T-ultra-wide clone (match its effective thresholds)
  configs.push(makeConfig(`R-tw-clone`, {
    signalMultiple: 2.2, signalWindowSeconds: 15*60,
    slAtrMultiple: 3.5, trailingAtrMultiple: 3.5, trailDelaySeconds: 480,
    trendThreshold: 1.5, rangeThreshold: 0.5,
  }));

  // Short ATR period (faster adaptation)
  configs.push(makeConfig(`R-fast-atr`, {
    signalMultiple: 4.0, signalWindowSeconds: 15*60,
    slAtrMultiple: 5.0, trailingAtrMultiple: 3.5, trailDelaySeconds: 480,
    trendThreshold: 1.5, rangeThreshold: 0.5,
    atrPeriod: 30,
  }));

  // Trend-only with very wide stops
  configs.push(makeConfig(`R-trd-wide`, {
    signalMultiple: 3.0, signalWindowSeconds: 30*60,
    slAtrMultiple: 8.0, trailingAtrMultiple: 5.0, trailDelaySeconds: 900,
    trendThreshold: 0.8, rangeThreshold: 0.1,
  }));

  // High cooldown
  configs.push(makeConfig(`R-high-cd`, {
    signalMultiple: 3.0, signalWindowSeconds: 15*60,
    slAtrMultiple: 5.0, trailingAtrMultiple: 3.5, trailDelaySeconds: 480,
    trendThreshold: 1.5, rangeThreshold: 0.5,
    cooldownSeconds: 900,
  }));

  // Very wide stops + long signal
  configs.push(makeConfig(`R-patient`, {
    signalMultiple: 3.0, signalWindowSeconds: 60*60,
    slAtrMultiple: 7.0, trailingAtrMultiple: 5.0, trailDelaySeconds: 900,
    trendThreshold: 1.5, rangeThreshold: 0.5,
    cooldownSeconds: 600,
  }));

  // Tight reversion band
  configs.push(makeConfig(`R-rev-tgt`, {
    signalMultiple: 4.0, signalWindowSeconds: 15*60,
    slAtrMultiple: 5.0, trailingAtrMultiple: 3.5, trailDelaySeconds: 480,
    trendThreshold: 2.0, rangeThreshold: 1.0,
    entryBandMultiple: 1.5, reversionSlMultiple: 2.5, meanWindowSeconds: 3600,
  }));

  return configs;
}

function makeConfig(name: string, overrides: Partial<RegimeConfig> & {
  signalMultiple: number;
  signalWindowSeconds: number;
  slAtrMultiple: number;
  trailingAtrMultiple: number;
  trailDelaySeconds: number;
  trendThreshold: number;
  rangeThreshold: number;
}): RegimeConfig {
  return {
    type: 'regime',
    name,
    atrPeriod: overrides.atrPeriod ?? 60,
    regimeWindowSeconds: overrides.regimeWindowSeconds ?? 4 * 3600,
    trendThreshold: overrides.trendThreshold,
    rangeThreshold: overrides.rangeThreshold,
    signalWindowSeconds: overrides.signalWindowSeconds,
    signalMultiple: overrides.signalMultiple,
    trailingAtrMultiple: overrides.trailingAtrMultiple,
    slAtrMultiple: overrides.slAtrMultiple,
    trailDelaySeconds: overrides.trailDelaySeconds,
    meanWindowSeconds: overrides.meanWindowSeconds ?? 2 * 3600,
    entryBandMultiple: overrides.entryBandMultiple ?? 2.5,
    reversionSlMultiple: overrides.reversionSlMultiple ?? 4.0,
    cooldownSeconds: overrides.cooldownSeconds ?? 300,
    betSizeSol: 1.0,
  };
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
      dataPath = process.argv[i + 1];
      i++;
    }
  }
  if (!dataPath) {
    console.error('Usage: npx tsx src/backtest_regime_grid.ts --data <path-to-jsonl>');
    process.exit(1);
  }

  const resolvedPath = resolve(dataPath);
  console.log(`[grid] Loading ticks from ${resolvedPath}...`);
  const ticks = loadTicks(resolvedPath);
  if (ticks.length === 0) { console.error('[grid] No ticks'); process.exit(1); }

  const firstTs = ticks[0].publishTime;
  const lastTs = ticks[ticks.length - 1].publishTime;
  const totalHours = (lastTs - firstTs) / 3600;
  console.log(`[grid] ${ticks.length.toLocaleString()} ticks (${totalHours.toFixed(0)}h)`);
  console.log(`[grid] SOL: $${ticks[0].price.toFixed(2)} → $${ticks[ticks.length - 1].price.toFixed(2)}`);

  const configs = generateGrid();
  const equity = 6.6667;
  console.log(`[grid] ${configs.length} configs to test, ${equity.toFixed(4)} SOL each\n`);

  const results: GridResult[] = [];
  const t0 = Date.now();

  for (let i = 0; i < configs.length; i++) {
    const r = runOne(configs[i], ticks, equity);
    results.push(r);
    if ((i + 1) % 10 === 0 || i === configs.length - 1) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = (i + 1) / elapsed;
      const eta = (configs.length - i - 1) / rate;
      process.stderr.write(`\r[grid] ${i + 1}/${configs.length} done (${elapsed.toFixed(0)}s, ETA ${eta.toFixed(0)}s)  `);
    }
  }
  console.log('');

  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[grid] Complete in ${totalElapsed}s\n`);

  // Sort by ROI
  results.sort((a, b) => b.roi - a.roi);

  // Reference benchmarks (from previous full backtest)
  console.log('  ═══ REFERENCE BENCHMARKS ═══');
  console.log('  T-ultra-wide   2Y: +2.3% ROI  1301 trades  37.9% WR  Sharpe 0.006');
  console.log('  L3-nofund      2Y: +0.7% ROI  4974 trades  39.5% WR  Sharpe 0.006');
  console.log('');

  // Top 30
  console.log('  ═══ TOP 30 REGIME CONFIGS ═══');
  console.log('  Rank  Name           ROI%     Trades   WR%   Sharpe    PF   MaxDD%  | sigM  sigW  trdThr rngThr  slM   trM  delay   cd');
  console.log('  ' + '─'.repeat(130));

  for (let i = 0; i < Math.min(30, results.length); i++) {
    const r = results[i];
    const c = r.config;
    const rank = `#${i + 1}`.padStart(4);
    const name = r.name.padEnd(13);
    const roi = fmtRoi(r.roi).padStart(7);
    const trades = String(r.trades).padStart(7);
    const wr = `${r.winRate.toFixed(1)}%`.padStart(6);
    const sharpe = r.sharpe.toFixed(3).padStart(7);
    const pf = r.profitFactor === Infinity ? '   Inf' : r.profitFactor.toFixed(2).padStart(6);
    const dd = `${r.maxDdPct.toFixed(1)}%`.padStart(6);
    const sigM = String(c.signalMultiple).padStart(5);
    const sigW = `${c.signalWindowSeconds / 60}m`.padStart(5);
    const trd = String(c.trendThreshold).padStart(5);
    const rng = String(c.rangeThreshold).padStart(5);
    const sl = String(c.slAtrMultiple).padStart(5);
    const tr = String(c.trailingAtrMultiple).padStart(5);
    const delay = String(c.trailDelaySeconds).padStart(5);
    const cd = String(c.cooldownSeconds).padStart(5);

    console.log(`  ${rank}  ${name}  ${roi}  ${trades}  ${wr}  ${sharpe}  ${pf}  ${dd}  | ${sigM}  ${sigW}  ${trd}  ${rng}  ${sl}  ${tr}  ${delay}  ${cd}`);
  }

  // Bottom 5
  console.log('');
  console.log('  ═══ BOTTOM 5 ═══');
  for (let i = Math.max(0, results.length - 5); i < results.length; i++) {
    const r = results[i];
    const c = r.config;
    console.log(`  #${i + 1}  ${r.name.padEnd(13)}  ${fmtRoi(r.roi).padStart(7)}  ${String(r.trades).padStart(7)} trades  ${r.winRate.toFixed(1)}% WR  | sigM=${c.signalMultiple} sigW=${c.signalWindowSeconds/60}m sl=${c.slAtrMultiple} tr=${c.trailingAtrMultiple}`);
  }

  // Summary statistics
  const positive = results.filter(r => r.roi > 0).length;
  const median = results[Math.floor(results.length / 2)].roi;
  console.log('');
  console.log(`  ═══ SUMMARY ═══`);
  console.log(`  Configs tested: ${results.length}`);
  console.log(`  Positive ROI:   ${positive}/${results.length} (${(positive/results.length*100).toFixed(0)}%)`);
  console.log(`  Best ROI:       ${fmtRoi(results[0].roi)}`);
  console.log(`  Median ROI:     ${fmtRoi(median)}`);
  console.log(`  Worst ROI:      ${fmtRoi(results[results.length - 1].roi)}`);

  // Print top 5 full configs for copy-paste into strategies.ts
  console.log('');
  console.log('  ═══ TOP 5 CONFIGS FOR strategies.ts ═══');
  for (let i = 0; i < Math.min(5, results.length); i++) {
    const c = results[i].config;
    console.log(`  // #${i+1}: ${fmtRoi(results[i].roi)} ROI, ${results[i].trades} trades, ${results[i].winRate.toFixed(1)}% WR, Sharpe ${results[i].sharpe.toFixed(3)}, MaxDD ${results[i].maxDdPct.toFixed(1)}%`);
    console.log(`  { type: 'regime', name: '${c.name}', atrPeriod: ${c.atrPeriod}, regimeWindowSeconds: ${c.regimeWindowSeconds}, trendThreshold: ${c.trendThreshold}, rangeThreshold: ${c.rangeThreshold}, signalWindowSeconds: ${c.signalWindowSeconds}, signalMultiple: ${c.signalMultiple}, trailingAtrMultiple: ${c.trailingAtrMultiple}, slAtrMultiple: ${c.slAtrMultiple}, trailDelaySeconds: ${c.trailDelaySeconds}, meanWindowSeconds: ${c.meanWindowSeconds}, entryBandMultiple: ${c.entryBandMultiple}, reversionSlMultiple: ${c.reversionSlMultiple}, cooldownSeconds: ${c.cooldownSeconds}, betSizeSol: 1.0 },`);
  }
}

main();
