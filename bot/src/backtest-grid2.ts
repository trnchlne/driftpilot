/**
 * Round 2: Combine winning parameters from round 1 at 1 SOL max bets.
 * Focus on the sweet spots discovered:
 *   - Level: 3h lookback, tight tolerance, wider SL, longer cooldown
 *   - Momentum: 0.50-0.55 threshold, TP=0.9%, SL=0.5%, no timeout
 *   - Trend: 2.0-2.5% trail, 180-480s delay, 0.50 threshold
 *
 * Also tests a "portfolio" combination and stability across sub-periods.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import type { BaseStrategy, PerformanceMetrics } from './base-strategy.js';
import type { StrategyConfig } from './strategies.js';
import { MomentumStrategy } from './momentum.js';
import { TrendStrategy } from './trend.js';
import { LevelStrategy } from './level.js';

function generateRound2(): StrategyConfig[] {
  const configs: StrategyConfig[] = [];

  // ── LEVEL: combine 3h lookback + tight tolerance + wider SL + longer cooldown ──
  const levelBase = {
    type: 'level' as const,
    supportPct: 10,
    resistancePct: 90,
    recalcIntervalSeconds: 120,
    fundingLookbackSeconds: 5400,
    fundingBiasMinPct: 0.3,
    minSamplesForLevel: 100,
    regimeFilterPct: 1.5,
    regimeFilterSeconds: 7200,
  };

  // R1 winners: 3h lookback, tol=0.03, SL=0.80, cooldown=1200
  // Now sweep bet sizes and combine winning parameters
  for (const bet of [0.5, 0.75, 1.0]) {
    // Core winner: 3h + tight tol + wide SL
    configs.push({ ...levelBase, name: `L2-3h-03-080-b${bet}`, lookbackSeconds: 3*3600, touchTolerancePct: 0.03, stopLossPct: 0.80, cooldownSeconds: 300, betSizeSol: bet });
    // Add longer cooldown (R1 winner)
    configs.push({ ...levelBase, name: `L2-3h-03-080-cd12-b${bet}`, lookbackSeconds: 3*3600, touchTolerancePct: 0.03, stopLossPct: 0.80, cooldownSeconds: 1200, betSizeSol: bet });
    // Tighter SL variant
    configs.push({ ...levelBase, name: `L2-3h-03-065-cd12-b${bet}`, lookbackSeconds: 3*3600, touchTolerancePct: 0.03, stopLossPct: 0.65, cooldownSeconds: 1200, betSizeSol: bet });
    // Very tight SL (R1 L-sl0.35 was #2)
    configs.push({ ...levelBase, name: `L2-3h-03-035-b${bet}`, lookbackSeconds: 3*3600, touchTolerancePct: 0.03, stopLossPct: 0.35, cooldownSeconds: 300, betSizeSol: bet });
    configs.push({ ...levelBase, name: `L2-3h-03-035-cd12-b${bet}`, lookbackSeconds: 3*3600, touchTolerancePct: 0.03, stopLossPct: 0.35, cooldownSeconds: 1200, betSizeSol: bet });
    // 3h + wider SL + strict regime
    configs.push({ ...levelBase, name: `L2-3h-03-080-rgm1-b${bet}`, lookbackSeconds: 3*3600, touchTolerancePct: 0.03, stopLossPct: 0.80, cooldownSeconds: 300, regimeFilterPct: 1.0, betSizeSol: bet });
    // 3h + tol 0.04 (R1 #8)
    configs.push({ ...levelBase, name: `L2-3h-04-080-b${bet}`, lookbackSeconds: 3*3600, touchTolerancePct: 0.04, stopLossPct: 0.80, cooldownSeconds: 300, betSizeSol: bet });
    // 2h lookback (R1 L-lb2h was good)
    configs.push({ ...levelBase, name: `L2-2h-03-080-b${bet}`, lookbackSeconds: 2*3600, touchTolerancePct: 0.03, stopLossPct: 0.80, cooldownSeconds: 300, betSizeSol: bet });
    // Percentile variations
    configs.push({ ...levelBase, name: `L2-3h-03-080-p5/95-b${bet}`, lookbackSeconds: 3*3600, touchTolerancePct: 0.03, stopLossPct: 0.80, cooldownSeconds: 300, supportPct: 5, resistancePct: 95, betSizeSol: bet });
    configs.push({ ...levelBase, name: `L2-3h-03-080-p15/85-b${bet}`, lookbackSeconds: 3*3600, touchTolerancePct: 0.03, stopLossPct: 0.80, cooldownSeconds: 300, supportPct: 15, resistancePct: 85, betSizeSol: bet });
    // Funding off
    configs.push({ ...levelBase, name: `L2-3h-03-080-nofund-b${bet}`, lookbackSeconds: 3*3600, touchTolerancePct: 0.03, stopLossPct: 0.80, cooldownSeconds: 300, fundingBiasMinPct: 999, betSizeSol: bet });
  }

  // ── TREND: combine 2.0-2.5% trail + wider hard SL ──
  const trendBase = {
    type: 'trend' as const,
    threshold: 0.50,
    window: 180,
  };

  for (const bet of [0.5, 0.75, 1.0]) {
    // R1 winner: trail 2.5%
    configs.push({ ...trendBase, name: `T2-tr25-d180-b${bet}`, trailingStopPct: 2.5, trailDelaySeconds: 180, stopLossPct: 2.5, betSizeSol: bet });
    configs.push({ ...trendBase, name: `T2-tr25-d480-b${bet}`, trailingStopPct: 2.5, trailDelaySeconds: 480, stopLossPct: 2.5, betSizeSol: bet });
    // R1 runner-up: trail 2.0% + SL 1.5-2.0%
    configs.push({ ...trendBase, name: `T2-tr20-d480-s15-b${bet}`, trailingStopPct: 2.0, trailDelaySeconds: 480, stopLossPct: 1.5, betSizeSol: bet });
    configs.push({ ...trendBase, name: `T2-tr20-d480-s20-b${bet}`, trailingStopPct: 2.0, trailDelaySeconds: 480, stopLossPct: 2.0, betSizeSol: bet });
    configs.push({ ...trendBase, name: `T2-tr20-d240-s20-b${bet}`, trailingStopPct: 2.0, trailDelaySeconds: 240, stopLossPct: 2.0, betSizeSol: bet });
    // Trail 3.0% (R1 #12 overall)
    configs.push({ ...trendBase, name: `T2-tr30-d480-b${bet}`, trailingStopPct: 3.0, trailDelaySeconds: 480, stopLossPct: 3.0, betSizeSol: bet });
    configs.push({ ...trendBase, name: `T2-tr30-d180-b${bet}`, trailingStopPct: 3.0, trailDelaySeconds: 180, stopLossPct: 3.0, betSizeSol: bet });
    // Long delay (R1 T-delay900 was good)
    configs.push({ ...trendBase, name: `T2-tr25-d900-b${bet}`, trailingStopPct: 2.5, trailDelaySeconds: 900, stopLossPct: 2.5, betSizeSol: bet });
    // Threshold 0.55 / 0.65
    configs.push({ ...trendBase, name: `T2-tr25-d480-thr55-b${bet}`, threshold: 0.55, trailingStopPct: 2.5, trailDelaySeconds: 480, stopLossPct: 2.5, betSizeSol: bet });
    configs.push({ ...trendBase, name: `T2-tr25-d480-thr65-b${bet}`, threshold: 0.65, trailingStopPct: 2.5, trailDelaySeconds: 480, stopLossPct: 2.5, betSizeSol: bet });
  }

  // ── MOMENTUM: fine-tune around the winner ──
  for (const bet of [0.5, 0.75, 1.0]) {
    // Base winner
    configs.push({ ...{type: 'momentum' as const}, name: `M2-base-b${bet}`, threshold: 0.55, window: 180, holdSeconds: 0, takeProfitPct: 0.90, stopLossPct: 0.50, betSizeSol: bet });
    // Threshold 0.50 (slightly more trades, similar quality)
    configs.push({ ...{type: 'momentum' as const}, name: `M2-thr50-b${bet}`, threshold: 0.50, window: 180, holdSeconds: 0, takeProfitPct: 0.90, stopLossPct: 0.50, betSizeSol: bet });
    // Higher TP
    configs.push({ ...{type: 'momentum' as const}, name: `M2-tp12-b${bet}`, threshold: 0.55, window: 180, holdSeconds: 0, takeProfitPct: 1.20, stopLossPct: 0.60, betSizeSol: bet });
    // TP 3.0 (R1 best Sharpe for momentum)
    configs.push({ ...{type: 'momentum' as const}, name: `M2-tp30-b${bet}`, threshold: 0.55, window: 180, holdSeconds: 0, takeProfitPct: 3.00, stopLossPct: 0.50, betSizeSol: bet });
    // Lower threshold for more trades
    configs.push({ ...{type: 'momentum' as const}, name: `M2-thr45-b${bet}`, threshold: 0.45, window: 180, holdSeconds: 0, takeProfitPct: 0.90, stopLossPct: 0.50, betSizeSol: bet });
    // Wider window
    configs.push({ ...{type: 'momentum' as const}, name: `M2-w240-b${bet}`, threshold: 0.55, window: 240, holdSeconds: 0, takeProfitPct: 0.90, stopLossPct: 0.50, betSizeSol: bet });
  }

  return configs;
}

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

function createStrategy(config: StrategyConfig): BaseStrategy {
  switch (config.type) {
    case 'momentum': return new MomentumStrategy(config);
    case 'trend': return new TrendStrategy(config);
    case 'level': return new LevelStrategy(config);
    default: throw new Error(`Unsupported: ${(config as any).type}`);
  }
}

interface Result { name: string; type: string; metrics: PerformanceMetrics; config: StrategyConfig; }

function runOnTicks(configs: StrategyConfig[], ticks: Tick[], silent = true): Result[] {
  const strategies = configs.map(c => ({ strategy: createStrategy(c), config: c }));
  const origLog = console.log;
  if (silent) console.log = () => {};
  for (const tick of ticks) {
    for (const { strategy } of strategies) strategy.onTick(tick);
  }
  if (silent) console.log = origLog;
  return strategies.map(({ strategy, config }) => ({
    name: strategy.name, type: strategy.type, metrics: strategy.getMetrics(), config,
  }));
}

function main(): void {
  const dataPath = process.argv.find((_, i, a) => a[i - 1] === '--data') || '';
  if (!dataPath) { console.error('Usage: npx tsx src/backtest-grid2.ts --data <path>'); process.exit(1); }

  console.log(`[grid2] Loading ticks...`);
  const ticks = loadTicks(resolve(dataPath));
  const totalDays = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 86400;
  console.log(`[grid2] ${ticks.length.toLocaleString()} ticks (${totalDays.toFixed(0)}d)\n`);

  const configs = generateRound2();
  console.log(`[grid2] Round 2: ${configs.length} configs\n`);

  // ── Full-period backtest ──
  const t0 = Date.now();
  const results = runOnTicks(configs, ticks);
  console.log(`[grid2] Full period done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const sorted = results.filter(r => r.metrics.totalTrades > 0).sort((a, b) => b.metrics.netPnlSol - a.metrics.netPnlSol);

  console.log(`${'═'.repeat(110)}`);
  console.log(`  ROUND 2: FULL PERIOD (${totalDays.toFixed(0)} days) — ${sorted.filter(r => r.metrics.netPnlSol > 0).length}/${sorted.length} profitable`);
  console.log(`${'═'.repeat(110)}`);
  console.log(`  ${'Rank'.padStart(4)}  ${'Name'.padEnd(32)}  ${'Type'.padEnd(9)}  ${'Trades'.padStart(6)}  ${'WR'.padStart(6)}  ${'Net PnL SOL'.padStart(14)}  ${'Sharpe'.padStart(7)}  ${'PF'.padStart(7)}  ${'PnL/Day'.padStart(10)}`);
  console.log(`  ${'────'.padStart(4)}  ${'─'.repeat(32)}  ${'─'.repeat(9)}  ${'──────'.padStart(6)}  ${'──────'.padStart(6)}  ${'──────────────'.padStart(14)}  ${'───────'.padStart(7)}  ${'───────'.padStart(7)}  ${'──────────'.padStart(10)}`);

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const m = r.metrics;
    const pnlDay = (m.netPnlSol / totalDays).toFixed(6);
    console.log(
      `  ${`#${i+1}`.padStart(4)}  ${r.name.padEnd(32)}  ${r.type.padEnd(9)}  ${String(m.totalTrades).padStart(6)}  ` +
      `${`${m.winRate.toFixed(1)}%`.padStart(6)}  ${`${m.netPnlSol >= 0 ? '+' : ''}${m.netPnlSol.toFixed(6)}`.padStart(14)}  ` +
      `${m.sharpe.toFixed(3).padStart(7)}  ${(m.profitFactor === Infinity ? '    Inf' : m.profitFactor.toFixed(2).padStart(7))}  ` +
      `${`${m.netPnlSol >= 0 ? '+' : ''}${pnlDay}`.padStart(10)}`
    );
  }

  // ── Stability test: split into 4 quarters ──
  console.log(`\n\n${'═'.repeat(110)}`);
  console.log(`  STABILITY TEST: 4 QUARTERS`);
  console.log(`${'═'.repeat(110)}`);

  const quarterLen = Math.floor(ticks.length / 4);
  const quarters = [
    ticks.slice(0, quarterLen),
    ticks.slice(quarterLen, quarterLen * 2),
    ticks.slice(quarterLen * 2, quarterLen * 3),
    ticks.slice(quarterLen * 3),
  ];

  // Test top 15 configs across quarters
  const top15 = sorted.slice(0, 15);
  console.log(`\n  Testing top 15 configs across quarters:\n`);
  console.log(`  ${'Name'.padEnd(32)}  ${'Q1 PnL'.padStart(10)}  ${'Q2 PnL'.padStart(10)}  ${'Q3 PnL'.padStart(10)}  ${'Q4 PnL'.padStart(10)}  ${'Quarters+'.padStart(10)}  ${'Consistency'.padStart(12)}`);
  console.log(`  ${'─'.repeat(32)}  ${'──────────'.padStart(10)}  ${'──────────'.padStart(10)}  ${'──────────'.padStart(10)}  ${'──────────'.padStart(10)}  ${'──────────'.padStart(10)}  ${'────────────'.padStart(12)}`);

  for (const s of top15) {
    const qResults: number[] = [];
    for (const q of quarters) {
      const qr = runOnTicks([s.config], q);
      qResults.push(qr[0]?.metrics.netPnlSol || 0);
    }
    const quartersPositive = qResults.filter(p => p > 0).length;
    const consistency = quartersPositive === 4 ? 'EXCELLENT' : quartersPositive === 3 ? 'GOOD' : quartersPositive === 2 ? 'MIXED' : 'POOR';
    console.log(
      `  ${s.name.padEnd(32)}  ${qResults.map(p => `${p >= 0 ? '+' : ''}${p.toFixed(4)}`.padStart(10)).join('  ')}  ${`${quartersPositive}/4`.padStart(10)}  ${consistency.padStart(12)}`
    );
  }

  // ── Best portfolio: one of each type ──
  console.log(`\n\n${'═'.repeat(110)}`);
  console.log(`  OPTIMAL PORTFOLIO (best config per type, all at 1 SOL)`);
  console.log(`${'═'.repeat(110)}`);

  const bestByType: Record<string, Result> = {};
  for (const r of sorted) {
    if (!bestByType[r.type] && (r.config as any).betSizeSol === 1.0) {
      bestByType[r.type] = r;
    }
  }

  let portfolioTotal = 0;
  for (const [type, r] of Object.entries(bestByType)) {
    const m = r.metrics;
    portfolioTotal += m.netPnlSol;
    console.log(`  ${type.padEnd(10)}  ${r.name.padEnd(32)}  PnL=${m.netPnlSol >= 0 ? '+' : ''}${m.netPnlSol.toFixed(6)} SOL  ${m.totalTrades} trades  WR=${m.winRate.toFixed(1)}%  Sharpe=${m.sharpe.toFixed(3)}`);
  }
  console.log(`  ${'─'.repeat(80)}`);
  console.log(`  PORTFOLIO TOTAL: ${portfolioTotal >= 0 ? '+' : ''}${portfolioTotal.toFixed(6)} SOL / ${totalDays.toFixed(0)} days = ${(portfolioTotal / totalDays).toFixed(6)} SOL/day`);
  console.log(`  ANNUALIZED: ${(portfolioTotal / totalDays * 365).toFixed(4)} SOL/year`);

  // ── Print best config ──
  console.log(`\n\n${'═'.repeat(110)}`);
  console.log(`  BEST SINGLE STRATEGY CONFIG`);
  console.log(`${'═'.repeat(110)}`);
  if (sorted.length > 0) {
    const best = sorted[0];
    console.log(`  ${JSON.stringify(best.config, null, 2)}`);
    console.log(`  PnL: ${best.metrics.netPnlSol.toFixed(6)} SOL | Trades: ${best.metrics.totalTrades} | WR: ${best.metrics.winRate.toFixed(1)}% | Sharpe: ${best.metrics.sharpe.toFixed(3)}`);
  }

  console.log(`\n[grid2] Done.\n`);
}

main();
