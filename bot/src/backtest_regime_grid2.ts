/**
 * Grid search #2: Vary both strategy params AND Kelly fraction.
 * Target: 30%+ ROI over 2Y.
 *
 * Usage: npx tsx src/backtest_regime_grid2.ts --data data/history-2y.jsonl
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
}

function runOne(config: RegimeConfig, ticks: Tick[], equity: number, kelly: number): GridResult {
  const bankroll = new BankrollManager({
    mode: 'paper',
    initialEquitySol: equity,
    kellyOverride: kelly,
    maxBetOverride: 0.30, // raise cap to 30%
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
    name: config.name,
    config,
    kelly,
    roi: ((finalEq / equity) - 1) * 100,
    trades: m.totalTrades,
    winRate: m.winRate,
    sharpe: m.sharpe,
    profitFactor: m.profitFactor,
    maxDdPct: maxDd,
    finalEquity: finalEq,
  };
}

/* ─── Grid Generation ────────────────────────────────────── */

function generateGrid(): { config: RegimeConfig; kelly: number }[] {
  const grid: { config: RegimeConfig; kelly: number }[] = [];
  let idx = 0;

  // Signal combos: (signalMultiple, signalWindowSeconds)
  const signals = [
    { m: 2.5, w: 15*60 },
    { m: 3.0, w: 15*60 },
    { m: 4.0, w: 15*60 },
    { m: 5.0, w: 15*60 },
    { m: 3.0, w: 30*60 },
    { m: 4.0, w: 30*60 },
    { m: 5.0, w: 30*60 },
    { m: 2.5, w: 60*60 },
    { m: 3.0, w: 60*60 },
  ];

  // Stop combos: (sl, trail, delay)
  const stops = [
    { sl: 7.0, tr: 5.0, delay: 480 },
    { sl: 5.0, tr: 3.5, delay: 480 },
    { sl: 10.0, tr: 7.0, delay: 480 },
    { sl: 7.0, tr: 5.0, delay: 240 },
  ];

  // Regime combos: (trendThreshold, rangeThreshold)
  const regimes = [
    { trd: 1.5, rng: 0.5 },
    { trd: 1.0, rng: 0.2 },
  ];

  // Kelly fractions
  const kellys = [0.08, 0.12, 0.18, 0.25];

  // Cooldowns
  const cooldowns = [300, 120];

  // ATR periods
  const atrPeriods = [60, 30];

  // Core grid: signals × stops × regimes × kellys (fixed cd=300, atr=60)
  for (const sig of signals) {
    for (const stp of stops) {
      for (const reg of regimes) {
        for (const kelly of kellys) {
          const config: RegimeConfig = {
            type: 'regime',
            name: `G${idx++}`,
            atrPeriod: 60,
            regimeWindowSeconds: 4 * 3600,
            trendThreshold: reg.trd,
            rangeThreshold: reg.rng,
            signalWindowSeconds: sig.w,
            signalMultiple: sig.m,
            trailingAtrMultiple: stp.tr,
            slAtrMultiple: stp.sl,
            trailDelaySeconds: stp.delay,
            meanWindowSeconds: 2 * 3600,
            entryBandMultiple: 2.5,
            reversionSlMultiple: 4.0,
            cooldownSeconds: 300,
            betSizeSol: 1.0,
          };
          grid.push({ config, kelly });
        }
      }
    }
  }

  // Wildcards: fast ATR + winning signal combos + high kelly
  for (const kelly of [0.15, 0.20, 0.25]) {
    grid.push({
      config: {
        type: 'regime', name: `Gf-${idx++}`, atrPeriod: 30,
        regimeWindowSeconds: 4*3600, trendThreshold: 1.5, rangeThreshold: 0.5,
        signalWindowSeconds: 15*60, signalMultiple: 4.0,
        trailingAtrMultiple: 3.5, slAtrMultiple: 5.0, trailDelaySeconds: 480,
        meanWindowSeconds: 2*3600, entryBandMultiple: 2.5, reversionSlMultiple: 4.0,
        cooldownSeconds: 300, betSizeSol: 1.0,
      },
      kelly,
    });
    grid.push({
      config: {
        type: 'regime', name: `Gf-${idx++}`, atrPeriod: 30,
        regimeWindowSeconds: 4*3600, trendThreshold: 1.0, rangeThreshold: 0.2,
        signalWindowSeconds: 30*60, signalMultiple: 5.0,
        trailingAtrMultiple: 5.0, slAtrMultiple: 7.0, trailDelaySeconds: 480,
        meanWindowSeconds: 2*3600, entryBandMultiple: 2.5, reversionSlMultiple: 4.0,
        cooldownSeconds: 300, betSizeSol: 1.0,
      },
      kelly,
    });
  }

  // Wildcards: short cooldown + high kelly
  for (const kelly of [0.15, 0.20, 0.25]) {
    for (const sig of [{ m: 4.0, w: 15*60 }, { m: 5.0, w: 30*60 }, { m: 3.0, w: 15*60 }]) {
      grid.push({
        config: {
          type: 'regime', name: `Gc-${idx++}`, atrPeriod: 60,
          regimeWindowSeconds: 4*3600, trendThreshold: 1.5, rangeThreshold: 0.5,
          signalWindowSeconds: sig.w, signalMultiple: sig.m,
          trailingAtrMultiple: 5.0, slAtrMultiple: 7.0, trailDelaySeconds: 480,
          meanWindowSeconds: 2*3600, entryBandMultiple: 2.5, reversionSlMultiple: 4.0,
          cooldownSeconds: 120, betSizeSol: 1.0,
        },
        kelly,
      });
    }
  }

  // Wildcards: wider stops + very high kelly
  for (const kelly of [0.20, 0.25, 0.30]) {
    grid.push({
      config: {
        type: 'regime', name: `Gw-${idx++}`, atrPeriod: 60,
        regimeWindowSeconds: 4*3600, trendThreshold: 1.5, rangeThreshold: 0.5,
        signalWindowSeconds: 30*60, signalMultiple: 4.0,
        trailingAtrMultiple: 7.0, slAtrMultiple: 10.0, trailDelaySeconds: 480,
        meanWindowSeconds: 2*3600, entryBandMultiple: 2.5, reversionSlMultiple: 4.0,
        cooldownSeconds: 300, betSizeSol: 1.0,
      },
      kelly,
    });
    grid.push({
      config: {
        type: 'regime', name: `Gw-${idx++}`, atrPeriod: 60,
        regimeWindowSeconds: 4*3600, trendThreshold: 1.0, rangeThreshold: 0.2,
        signalWindowSeconds: 15*60, signalMultiple: 5.0,
        trailingAtrMultiple: 7.0, slAtrMultiple: 10.0, trailDelaySeconds: 480,
        meanWindowSeconds: 2*3600, entryBandMultiple: 2.5, reversionSlMultiple: 4.0,
        cooldownSeconds: 300, betSizeSol: 1.0,
      },
      kelly,
    });
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
    console.error('Usage: npx tsx src/backtest_regime_grid2.ts --data <path>');
    process.exit(1);
  }

  const ticks = loadTicks(resolve(dataPath));
  console.log(`[grid2] ${ticks.length.toLocaleString()} ticks loaded`);

  const equity = 3.0; // 3 SOL per account as user specified
  const grid = generateGrid();
  console.log(`[grid2] ${grid.length} combos to test, ${equity} SOL each\n`);

  const results: GridResult[] = [];
  const t0 = Date.now();

  for (let i = 0; i < grid.length; i++) {
    const { config, kelly } = grid[i];
    const r = runOne(config, ticks, equity, kelly);
    results.push(r);
    if ((i + 1) % 20 === 0 || i === grid.length - 1) {
      const elapsed = (Date.now() - t0) / 1000;
      const eta = elapsed / (i + 1) * (grid.length - i - 1);
      process.stderr.write(`\r[grid2] ${i + 1}/${grid.length} done (${elapsed.toFixed(0)}s, ETA ${eta.toFixed(0)}s)  `);
    }
  }
  console.log('');

  console.log(`\n[grid2] Complete in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Sort by ROI
  results.sort((a, b) => b.roi - a.roi);

  // Count 30%+ results
  const over30 = results.filter(r => r.roi >= 30).length;
  const over20 = results.filter(r => r.roi >= 20).length;
  const over10 = results.filter(r => r.roi >= 10).length;

  console.log(`  ═══ RESULTS (${equity} SOL per account) ═══`);
  console.log(`  30%+ ROI: ${over30}/${results.length}`);
  console.log(`  20%+ ROI: ${over20}/${results.length}`);
  console.log(`  10%+ ROI: ${over10}/${results.length}`);
  console.log('');

  // Top 40
  console.log('  ═══ TOP 40 ═══');
  console.log('  Rank  Name       ROI%    3SOL→    Trades  WR%    Sharpe    PF   MaxDD%  | Kelly  sigM  sigW  trdThr rngThr  slM   trM  delay  atr   cd');
  console.log('  ' + '─'.repeat(145));

  for (let i = 0; i < Math.min(40, results.length); i++) {
    const r = results[i];
    const c = r.config;
    const rank = `#${i + 1}`.padStart(4);
    const name = r.name.padEnd(9);
    const roi = fmtRoi(r.roi).padStart(7);
    const final3 = r.finalEquity.toFixed(3).padStart(7);
    const trades = String(r.trades).padStart(6);
    const wr = `${r.winRate.toFixed(1)}%`.padStart(6);
    const sharpe = r.sharpe.toFixed(3).padStart(7);
    const pf = r.profitFactor === Infinity ? '   Inf' : r.profitFactor.toFixed(2).padStart(6);
    const dd = `${r.maxDdPct.toFixed(1)}%`.padStart(6);
    const kelly = `${(r.kelly * 100).toFixed(0)}%`.padStart(5);
    const sigM = String(c.signalMultiple).padStart(4);
    const sigW = `${c.signalWindowSeconds / 60}m`.padStart(4);
    const trd = String(c.trendThreshold).padStart(5);
    const rng = String(c.rangeThreshold).padStart(5);
    const sl = String(c.slAtrMultiple).padStart(5);
    const tr = String(c.trailingAtrMultiple).padStart(5);
    const delay = String(c.trailDelaySeconds).padStart(5);
    const atr = String(c.atrPeriod).padStart(4);
    const cd = String(c.cooldownSeconds).padStart(4);

    console.log(`  ${rank}  ${name}  ${roi}  ${final3}  ${trades}  ${wr}  ${sharpe}  ${pf}  ${dd}  | ${kelly}  ${sigM}  ${sigW}  ${trd}  ${rng}  ${sl}  ${tr}  ${delay}  ${atr}  ${cd}`);
  }

  // Summary stats
  const positive = results.filter(r => r.roi > 0).length;
  const median = results[Math.floor(results.length / 2)].roi;
  console.log('');
  console.log(`  ═══ SUMMARY ═══`);
  console.log(`  Tested: ${results.length} | Positive: ${positive} | Best: ${fmtRoi(results[0].roi)} | Median: ${fmtRoi(median)} | Worst: ${fmtRoi(results[results.length - 1].roi)}`);

  // Best configs for each Kelly level
  console.log('');
  console.log('  ═══ BEST PER KELLY LEVEL ═══');
  const kellyLevels = [...new Set(results.map(r => r.kelly))].sort();
  for (const k of kellyLevels) {
    const best = results.filter(r => r.kelly === k).sort((a, b) => b.roi - a.roi)[0];
    if (best) {
      console.log(`  Kelly ${(k*100).toFixed(0)}%: ${fmtRoi(best.roi).padStart(7)} ROI (${best.trades} trades, ${best.winRate.toFixed(1)}% WR, ${best.maxDdPct.toFixed(1)}% DD) — sigM=${best.config.signalMultiple} sigW=${best.config.signalWindowSeconds/60}m sl=${best.config.slAtrMultiple} tr=${best.config.trailingAtrMultiple}`);
    }
  }

  // Print top 5 configs with strategy.ts format
  console.log('');
  console.log('  ═══ TOP 5 FOR strategies.ts ═══');
  for (let i = 0; i < Math.min(5, results.length); i++) {
    const r = results[i];
    const c = r.config;
    console.log(`  // #${i+1}: ${fmtRoi(r.roi)} ROI (3→${r.finalEquity.toFixed(3)}), ${r.trades} trades, ${r.winRate.toFixed(1)}% WR, Sharpe ${r.sharpe.toFixed(3)}, MaxDD ${r.maxDdPct.toFixed(1)}%, Kelly ${(r.kelly*100).toFixed(0)}%`);
    console.log(`  { type: 'regime', name: '${c.name}', atrPeriod: ${c.atrPeriod}, regimeWindowSeconds: ${c.regimeWindowSeconds}, trendThreshold: ${c.trendThreshold}, rangeThreshold: ${c.rangeThreshold}, signalWindowSeconds: ${c.signalWindowSeconds}, signalMultiple: ${c.signalMultiple}, trailingAtrMultiple: ${c.trailingAtrMultiple}, slAtrMultiple: ${c.slAtrMultiple}, trailDelaySeconds: ${c.trailDelaySeconds}, meanWindowSeconds: ${c.meanWindowSeconds}, entryBandMultiple: ${c.entryBandMultiple}, reversionSlMultiple: ${c.reversionSlMultiple}, cooldownSeconds: ${c.cooldownSeconds}, betSizeSol: 1.0 },`);
    console.log(`  // Kelly: ${(r.kelly*100).toFixed(0)}% | bankroll config: kellyOverride: ${r.kelly}, maxBetOverride: 0.30`);
  }
}

main();
