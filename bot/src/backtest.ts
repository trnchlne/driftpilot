import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import type { BaseStrategy, PerformanceMetrics } from './base-strategy.js';
import type { StrategyConfig } from './strategies.js';
import { STRATEGIES } from './strategies.js';
import { MomentumStrategy } from './momentum.js';
import { RangeStrategy } from './range.js';
import { GridStrategy } from './grid.js';
import { FadeStrategy } from './fade.js';
import { SpreadStrategy } from './spread.js';
import { BreakoutStrategy } from './breakout.js';
import { TrendStrategy } from './trend.js';
import { LevelStrategy } from './level.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';

/* ─── Types ──────────────────────────────────────────────── */

interface StrategyResult {
  name: string;
  type: string;
  metrics: PerformanceMetrics;
  // Per-strategy bankroll tracking
  initialEquity: number;
  finalEquity: number;
  roiPct: number;
  peakEquity: number;
  maxDdPct: number;
}

interface PeriodResult {
  label: string;
  startDate: string;
  endDate: string;
  ticks: number;
  hours: number;
  strategies: StrategyResult[];
  // Portfolio totals
  totalInitialEquity: number;
  totalFinalEquity: number;
  portfolioRoiPct: number;
  portfolioPeakEquity: number;
  portfolioMaxDdPct: number;
  portfolioMaxDdSol: number;
  maxConcurrent: number;
}

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
    } catch {
      // Skip malformed lines
    }
  }
  ticks.sort((a, b) => a.publishTime - b.publishTime);
  return ticks;
}

function sliceTicks(ticks: Tick[], startTs: number, endTs: number): Tick[] {
  let lo = 0, hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ticks[mid].publishTime < startTs) lo = mid + 1;
    else hi = mid;
  }
  const startIdx = lo;
  lo = startIdx;
  hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ticks[mid].publishTime <= endTs) lo = mid + 1;
    else hi = mid;
  }
  return ticks.slice(startIdx, lo);
}

/* ─── Strategy Factory ───────────────────────────────────── */

function createStrategy(config: StrategyConfig): BaseStrategy {
  switch (config.type) {
    case 'momentum': return new MomentumStrategy(config);
    case 'range': return new RangeStrategy(config);
    case 'grid': return new GridStrategy(config);
    case 'fade': return new FadeStrategy(config);
    case 'spread': return new SpreadStrategy(config);
    case 'breakout': return new BreakoutStrategy(config);
    case 'trend': return new TrendStrategy(config);
    case 'level': return new LevelStrategy(config);
    case 'regime': return new RegimeStrategy(config);
  }
}

/* ─── Period Runner (per-strategy bankrolls) ─────────────── */

function runPeriod(
  configs: StrategyConfig[],
  ticks: Tick[],
  label: string,
  equityPerStrategy: number,
): PeriodResult {
  const totalInitial = equityPerStrategy * configs.length;

  if (ticks.length === 0) {
    return {
      label, startDate: '--', endDate: '--', ticks: 0, hours: 0,
      strategies: [],
      totalInitialEquity: totalInitial, totalFinalEquity: totalInitial,
      portfolioRoiPct: 0, portfolioPeakEquity: totalInitial,
      portfolioMaxDdPct: 0, portfolioMaxDdSol: 0, maxConcurrent: 0,
    };
  }

  const startTs = ticks[0].publishTime;
  const endTs = ticks[ticks.length - 1].publishTime;
  const hours = (endTs - startTs) / 3600;

  // Per-strategy bankrolls — isolated, just like live subaccounts
  const entries = configs.map(c => {
    const bankroll = new BankrollManager({
      mode: 'paper',
      initialEquitySol: equityPerStrategy,
    });
    const instance = createStrategy(c);
    if (instance.setBankroll) instance.setBankroll(bankroll);
    return { config: c, instance, bankroll };
  });

  // Track per-strategy peak equity for drawdown
  const peaks = entries.map(() => equityPerStrategy);
  const maxDds = entries.map(() => 0);    // max DD in SOL per strategy
  const maxDdPcts = entries.map(() => 0); // max DD in % per strategy

  // Portfolio-level tracking
  let portfolioPeak = totalInitial;
  let portfolioMaxDdSol = 0;
  let portfolioMaxDdPct = 0;
  let maxConcurrent = 0;
  let lastSnapTime = 0;

  // Suppress per-trade console.log during replay
  const origLog = console.log;
  console.log = () => {};

  for (const tick of ticks) {
    for (const e of entries) {
      e.bankroll.updateSolPrice(tick.price);
      e.instance.onTick(tick);
    }

    // Snapshot every 60s
    if (tick.publishTime - lastSnapTime >= 60) {
      let portfolioEquity = 0;
      let concurrent = 0;

      for (let i = 0; i < entries.length; i++) {
        const eq = entries[i].bankroll.getEquity();
        portfolioEquity += eq;

        if (eq > peaks[i]) peaks[i] = eq;
        const dd = peaks[i] - eq;
        if (dd > maxDds[i]) maxDds[i] = dd;
        const ddPct = peaks[i] > 0 ? (dd / peaks[i]) * 100 : 0;
        if (ddPct > maxDdPcts[i]) maxDdPcts[i] = ddPct;

        if ((entries[i].instance as any).paper?.inPosition) concurrent++;
      }

      if (portfolioEquity > portfolioPeak) portfolioPeak = portfolioEquity;
      const pdd = portfolioPeak - portfolioEquity;
      if (pdd > portfolioMaxDdSol) portfolioMaxDdSol = pdd;
      const pddPct = portfolioPeak > 0 ? (pdd / portfolioPeak) * 100 : 0;
      if (pddPct > portfolioMaxDdPct) portfolioMaxDdPct = pddPct;

      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
      lastSnapTime = tick.publishTime;
    }
  }

  console.log = origLog;

  // Build results
  const results: StrategyResult[] = entries.map((e, i) => {
    const finalEq = e.bankroll.getEquity();
    const m = e.instance.getMetrics();

    // Fix tradesPerHour and score to use simulated time
    m.tradesPerHour = hours > 0 ? m.totalTrades / hours : 0;
    const pnlPerHour = hours > 0 ? m.netPnlSol / hours : 0;
    m.score = pnlPerHour / (m.maxDrawdownSol + 0.001);

    return {
      name: e.instance.name,
      type: e.instance.type,
      metrics: m,
      initialEquity: equityPerStrategy,
      finalEquity: finalEq,
      roiPct: ((finalEq / equityPerStrategy) - 1) * 100,
      peakEquity: peaks[i],
      maxDdPct: maxDdPcts[i],
    };
  });

  for (const e of entries) e.instance.stop();

  const totalFinal = entries.reduce((s, e) => s + e.bankroll.getEquity(), 0);

  return {
    label,
    startDate: fmtDate(startTs),
    endDate: fmtDate(endTs),
    ticks: ticks.length,
    hours,
    strategies: results,
    totalInitialEquity: totalInitial,
    totalFinalEquity: totalFinal,
    portfolioRoiPct: ((totalFinal / totalInitial) - 1) * 100,
    portfolioPeakEquity: portfolioPeak,
    portfolioMaxDdPct,
    portfolioMaxDdSol,
    maxConcurrent,
  };
}

/* ─── Formatting Helpers ─────────────────────────────────── */

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function fmtPnl(pnl: number, width = 10): string {
  const s = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}`;
  return s.padStart(width);
}

function fmtRoi(pct: number, width = 9): string {
  const s = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  return s.padStart(width);
}

/* ─── Printers ───────────────────────────────────────────── */

function printLeaderboard(result: PeriodResult, equityPerStrategy: number): void {
  const W = 125;
  console.log('');
  console.log(`  ${'═'.repeat(W)}`);
  console.log(`  ${result.label}`);
  console.log(`  ${result.startDate} → ${result.endDate}  |  ${result.ticks.toLocaleString()} ticks  |  ${result.hours.toFixed(0)}h`);
  console.log(`  Per-strategy bankroll: ${equityPerStrategy.toFixed(2)} SOL  |  Portfolio: ${result.totalInitialEquity.toFixed(2)} → ${result.totalFinalEquity.toFixed(4)} SOL (${fmtRoi(result.portfolioRoiPct).trim()})  |  MaxDD: ${result.portfolioMaxDdPct.toFixed(1)}%`);
  console.log(`  ${'═'.repeat(W)}`);

  if (result.strategies.length === 0) {
    console.log('  (no data for this period)');
    return;
  }

  const sorted = [...result.strategies].sort((a, b) => b.roiPct - a.roiPct);

  console.log('  Rank  Name             Type       Trades  WR       ROI%   FinalEq   Net PnL SOL  Sharpe  PF      MaxDD%');
  console.log('  ────  ───────────────  ─────────  ──────  ──────  ──────  ────────  ───────────  ──────  ──────  ──────');

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const m = s.metrics;
    const rank = `#${i + 1}`.padStart(4);
    const name = s.name.padEnd(15);
    const type = s.type.padEnd(9);
    const trades = String(m.totalTrades).padStart(6);
    const wr = m.totalTrades > 0 ? `${m.winRate.toFixed(1)}%`.padStart(6) : '    --';
    const roi = fmtRoi(s.roiPct, 6);
    const finalEq = s.finalEquity.toFixed(4).padStart(8);
    const pnl = fmtPnl(m.netPnlSol, 11);
    const sharpe = m.totalTrades > 0 ? m.sharpe.toFixed(3).padStart(6) : '    --';
    const pf = m.totalTrades > 0
      ? (m.profitFactor === Infinity ? '   Inf' : m.profitFactor.toFixed(2).padStart(6))
      : '    --';
    const dd = m.totalTrades > 0 ? `${s.maxDdPct.toFixed(1)}%`.padStart(6) : '    --';

    console.log(`  ${rank}  ${name}  ${type}  ${trades}  ${wr}  ${roi}  ${finalEq}  ${pnl}  ${sharpe}  ${pf}  ${dd}`);
  }

  const profitable = sorted.filter(s => s.roiPct > 0).length;
  const totalTrades = sorted.reduce((s, r) => s + r.metrics.totalTrades, 0);
  console.log('');
  console.log(`  Portfolio: ${result.totalFinalEquity.toFixed(4)} SOL (${fmtRoi(result.portfolioRoiPct).trim()}) | ${profitable}/${sorted.length} profitable | ${totalTrades} trades | MaxDD: ${result.portfolioMaxDdPct.toFixed(1)}%`);
}

function printPeriodComparison(periodResults: PeriodResult[], stratNames: string[]): void {
  const W = 125;
  console.log('');
  console.log(`  ${'═'.repeat(W)}`);
  console.log('  ROI% Comparison: Strategies × Time Windows (per-strategy bankrolls)');
  console.log(`  ${'═'.repeat(W)}`);

  const COL = 12;
  const NAME_COL = 16;

  let header = '  ' + 'Strategy'.padEnd(NAME_COL);
  for (const pr of periodResults) {
    header += pr.label.padStart(COL);
  }
  console.log(header);
  console.log('  ' + '─'.repeat(NAME_COL + periodResults.length * COL));

  // Sort by full-period ROI
  const fullResult = periodResults[0];
  const sortedNames = [...stratNames].sort((a, b) => {
    const aR = fullResult.strategies.find(s => s.name === a)?.roiPct ?? -Infinity;
    const bR = fullResult.strategies.find(s => s.name === b)?.roiPct ?? -Infinity;
    return bR - aR;
  });

  for (const name of sortedNames) {
    let row = '  ' + name.padEnd(NAME_COL);
    for (const pr of periodResults) {
      const strat = pr.strategies.find(s => s.name === name);
      if (strat && strat.metrics.totalTrades > 0) {
        row += fmtRoi(strat.roiPct, COL);
      } else {
        row += '--'.padStart(COL);
      }
    }
    console.log(row);
  }

  // Portfolio ROI row
  let roiRow = '  ' + 'PORTFOLIO'.padEnd(NAME_COL);
  for (const pr of periodResults) {
    roiRow += fmtRoi(pr.portfolioRoiPct, COL);
  }
  console.log('  ' + '─'.repeat(NAME_COL + periodResults.length * COL));
  console.log(roiRow);
}

function printHeatmap(
  results: PeriodResult[],
  stratNames: string[],
  title: string,
  solPriceData?: { label: string; startPrice: number; endPrice: number }[],
): void {
  const W = 125;
  console.log('');
  console.log(`  ${'═'.repeat(W)}`);
  console.log(`  ${title}`);
  console.log(`  ${'═'.repeat(W)}`);

  const COL = 12;
  const NAME_COL = 14;

  let header = '  ' + 'Period'.padEnd(NAME_COL);
  for (const name of stratNames) {
    header += name.padStart(COL);
  }
  header += '  Port ROI  SOL Chg%';
  console.log(header);
  console.log('  ' + '─'.repeat(NAME_COL + stratNames.length * COL + 20));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.ticks === 0) continue;

    let row = '  ' + r.label.padEnd(NAME_COL);
    for (const name of stratNames) {
      const strat = r.strategies.find(s => s.name === name);
      if (strat && strat.metrics.totalTrades > 0) {
        row += fmtRoi(strat.roiPct, COL);
      } else {
        row += '--'.padStart(COL);
      }
    }

    row += fmtRoi(r.portfolioRoiPct, 10);

    if (solPriceData && solPriceData[i]) {
      const d = solPriceData[i];
      const chg = ((d.endPrice / d.startPrice) - 1) * 100;
      row += `  ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%`.padStart(10);
    }

    console.log(row);
  }

  // Cumulative ROI row — compound each strategy's monthly ROIs
  let cumlRow = '  ' + 'CUMULATIVE'.padEnd(NAME_COL);
  for (const name of stratNames) {
    let cumEquity = 1.0; // normalized
    for (const r of results) {
      const strat = r.strategies.find(s => s.name === name);
      if (strat && strat.metrics.totalTrades > 0) {
        cumEquity *= (1 + strat.roiPct / 100);
      }
    }
    cumlRow += fmtRoi((cumEquity - 1) * 100, COL);
  }
  // Portfolio cumulative
  {
    let cumPort = 1.0;
    for (const r of results) {
      cumPort *= (1 + r.portfolioRoiPct / 100);
    }
    cumlRow += fmtRoi((cumPort - 1) * 100, 10);
  }
  console.log('  ' + '─'.repeat(NAME_COL + stratNames.length * COL + 20));
  console.log(cumlRow);
}

/* ─── Calendar Period Generation ─────────────────────────── */

function getMonthPeriods(startTs: number, endTs: number): { label: string; start: number; end: number }[] {
  const periods: { label: string; start: number; end: number }[] = [];
  const startDate = new Date(startTs * 1000);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let year = startDate.getUTCFullYear();
  let month = startDate.getUTCMonth();

  while (true) {
    const monthStart = Date.UTC(year, month, 1) / 1000;
    const nextMonth = month === 11 ? 0 : month + 1;
    const nextYear = month === 11 ? year + 1 : year;
    const monthEnd = Date.UTC(nextYear, nextMonth, 1) / 1000 - 1;

    if (monthStart > endTs) break;

    periods.push({
      label: `${MONTHS[month]} ${year}`,
      start: monthStart,
      end: monthEnd,
    });

    month = nextMonth;
    year = nextYear;
  }

  return periods;
}

function getQuarterPeriods(startTs: number, endTs: number): { label: string; start: number; end: number }[] {
  const periods: { label: string; start: number; end: number }[] = [];
  const startDate = new Date(startTs * 1000);

  let year = startDate.getUTCFullYear();
  let q = Math.floor(startDate.getUTCMonth() / 3) + 1;

  while (true) {
    const qStartMonth = (q - 1) * 3;
    const qStart = Date.UTC(year, qStartMonth, 1) / 1000;

    const nextQ = q === 4 ? 1 : q + 1;
    const nextYear = q === 4 ? year + 1 : year;
    const nextQStartMonth = (nextQ - 1) * 3;
    const qEnd = Date.UTC(nextYear, nextQStartMonth, 1) / 1000 - 1;

    if (qStart > endTs) break;

    periods.push({ label: `Q${q} ${year}`, start: qStart, end: qEnd });

    q = nextQ;
    year = nextYear;
  }

  return periods;
}

/* ─── Main ───────────────────────────────────────────────── */

function main(): void {
  const args = process.argv.slice(2);
  let dataPath = '';
  let totalBankroll = 10.0;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data' && args[i + 1]) {
      dataPath = args[i + 1];
      i++;
    }
    if (args[i] === '--bankroll' && args[i + 1]) {
      totalBankroll = parseFloat(args[i + 1]);
      i++;
    }
  }

  if (!dataPath) {
    console.error('Usage: npx tsx src/backtest.ts --data <path-to-jsonl> [--bankroll 10]');
    process.exit(1);
  }

  const resolvedPath = resolve(dataPath);
  console.log(`[backtest] Loading ticks from ${resolvedPath}...`);

  const ticks = loadTicks(resolvedPath);
  if (ticks.length === 0) {
    console.error('[backtest] No ticks found in file');
    process.exit(1);
  }

  const firstTs = ticks[0].publishTime;
  const lastTs = ticks[ticks.length - 1].publishTime;
  const totalHours = (lastTs - firstTs) / 3600;

  const allConfigs = [...STRATEGIES];
  const allNames = allConfigs.map(c => c.name);
  const equityPerStrategy = totalBankroll / allConfigs.length;

  console.log(`[backtest] ${ticks.length.toLocaleString()} ticks loaded (${totalHours.toFixed(0)}h, ${fmtDate(firstTs)} → ${fmtDate(lastTs)})`);
  console.log(`[backtest] SOL price: $${ticks[0].price.toFixed(2)} → $${ticks[ticks.length - 1].price.toFixed(2)}`);
  console.log(`[backtest] ${allConfigs.length} strategies loaded`);
  console.log(`[backtest] Total bankroll: ${totalBankroll} SOL | Per-strategy: ${equityPerStrategy.toFixed(4)} SOL (isolated subaccounts, 2x Kelly)`);

  const globalStart = Date.now();

  // ═══════════════════════════════════════════════════════════
  // STEP 1 & 2: Multi-period backtest — all strategies
  // ═══════════════════════════════════════════════════════════

  console.log('');
  console.log('═'.repeat(130));
  console.log('  STEP 1 & 2: MULTI-PERIOD BACKTEST — Per-strategy bankrolls (isolated, like live subaccounts)');
  console.log('═'.repeat(130));

  const periodDefs = [
    { label: 'Full 2Y', seconds: lastTs - firstTs },
    { label: 'Last 1Y', seconds: 365 * 24 * 3600 },
    { label: 'Last 6M', seconds: 182 * 24 * 3600 },
    { label: 'Last 3M', seconds: 91 * 24 * 3600 },
    { label: 'Last 1M', seconds: 30 * 24 * 3600 },
  ];

  const periodResults: PeriodResult[] = [];

  for (const pd of periodDefs) {
    const startTs_ = Math.max(firstTs, lastTs - pd.seconds);
    const periodTicks = sliceTicks(ticks, startTs_, lastTs);

    console.log(`\n[backtest] Running ${pd.label} (${periodTicks.length.toLocaleString()} ticks)...`);
    const t0 = Date.now();
    const result = runPeriod(allConfigs, periodTicks, pd.label, equityPerStrategy);
    const elapsed = Date.now() - t0;
    console.log(`[backtest] ${pd.label} complete in ${(elapsed / 1000).toFixed(1)}s`);

    printLeaderboard(result, equityPerStrategy);
    periodResults.push(result);
  }

  // Period comparison table
  printPeriodComparison(periodResults, allNames);

  // Determine top 3 strategies from full 2Y run (by ROI%)
  const fullResult = periodResults[0];
  const top3 = [...fullResult.strategies]
    .sort((a, b) => b.roiPct - a.roiPct)
    .slice(0, 3);
  const top3Names = top3.map(s => s.name);
  const top3Configs = allConfigs.filter(c => top3Names.includes(c.name));

  // For monthly/quarterly top3, give each strategy more equity (total/3)
  const equityPerTop3 = totalBankroll / top3Configs.length;

  console.log('');
  console.log(`[backtest] Top 3 strategies (by 2Y ROI): ${top3Names.map(n => {
    const s = fullResult.strategies.find(sr => sr.name === n)!;
    return `${n} (${fmtRoi(s.roiPct).trim()})`;
  }).join(', ')}`);

  // ═══════════════════════════════════════════════════════════
  // STEP 3: Monthly Breakdown (top 3 strategies)
  // ═══════════════════════════════════════════════════════════

  console.log('');
  console.log('═'.repeat(130));
  console.log('  STEP 3: MONTHLY BREAKDOWN — Top 3 strategies, per-strategy bankrolls');
  console.log('═'.repeat(130));

  const monthPeriods = getMonthPeriods(firstTs, lastTs);
  const monthResults: PeriodResult[] = [];
  const monthSolPrices: { label: string; startPrice: number; endPrice: number }[] = [];

  console.log(`[backtest] Processing ${monthPeriods.length} months...`);
  const monthT0 = Date.now();

  for (const mp of monthPeriods) {
    const monthTicks = sliceTicks(ticks, mp.start, mp.end);
    if (monthTicks.length < 10) continue;

    const result = runPeriod(top3Configs, monthTicks, mp.label, equityPerTop3);
    monthResults.push(result);
    monthSolPrices.push({
      label: mp.label,
      startPrice: monthTicks[0].price,
      endPrice: monthTicks[monthTicks.length - 1].price,
    });
  }

  console.log(`[backtest] ${monthResults.length} months processed in ${((Date.now() - monthT0) / 1000).toFixed(1)}s`);
  printHeatmap(monthResults, top3Names, 'Monthly ROI% Heatmap — Top 3 Strategies (per-strategy bankrolls)', monthSolPrices);

  // ═══════════════════════════════════════════════════════════
  // STEP 4: Quarterly Breakdown (top 3 strategies)
  // ═══════════════════════════════════════════════════════════

  console.log('');
  console.log('═'.repeat(130));
  console.log('  STEP 4: QUARTERLY BREAKDOWN — Top 3 strategies per quarter');
  console.log('═'.repeat(130));

  const quarterPeriods = getQuarterPeriods(firstTs, lastTs);
  const quarterResults: PeriodResult[] = [];
  const quarterSolPrices: { label: string; startPrice: number; endPrice: number }[] = [];

  console.log(`[backtest] Processing ${quarterPeriods.length} quarters...`);
  const qT0 = Date.now();

  for (const qp of quarterPeriods) {
    const qTicks = sliceTicks(ticks, qp.start, qp.end);
    if (qTicks.length < 10) continue;

    const result = runPeriod(top3Configs, qTicks, qp.label, equityPerTop3);
    quarterResults.push(result);
    quarterSolPrices.push({
      label: qp.label,
      startPrice: qTicks[0].price,
      endPrice: qTicks[qTicks.length - 1].price,
    });
  }

  console.log(`[backtest] ${quarterResults.length} quarters processed in ${((Date.now() - qT0) / 1000).toFixed(1)}s`);
  printHeatmap(quarterResults, top3Names, 'Quarterly ROI% Heatmap — Top 3 Strategies (per-strategy bankrolls)', quarterSolPrices);

  // ═══════════════════════════════════════════════════════════
  // STEP 5: Summary
  // ═══════════════════════════════════════════════════════════

  console.log('');
  console.log('═'.repeat(130));
  console.log('  STEP 5: SUMMARY');
  console.log('═'.repeat(130));

  // Portfolio summary
  console.log('');
  console.log(`  ┌─ PORTFOLIO (${totalBankroll} SOL total, ${equityPerStrategy.toFixed(4)} SOL/strategy, isolated bankrolls, 2x Kelly) ${'─'.repeat(50)}`);
  console.log(`  │`);
  console.log(`  │  2Y Final Equity:    ${fullResult.totalFinalEquity.toFixed(4)} SOL`);
  console.log(`  │  2Y ROI:             ${fmtRoi(fullResult.portfolioRoiPct).trim()}`);
  console.log(`  │  2Y Net PnL:         ${fmtPnl(fullResult.totalFinalEquity - fullResult.totalInitialEquity).trim()} SOL`);
  console.log(`  │  Portfolio Peak:     ${fullResult.portfolioPeakEquity.toFixed(4)} SOL`);
  console.log(`  │  Max Drawdown:       ${fullResult.portfolioMaxDdSol.toFixed(4)} SOL (${fullResult.portfolioMaxDdPct.toFixed(1)}% from peak)`);
  console.log(`  │  Max Concurrent:     ${fullResult.maxConcurrent} positions`);
  console.log(`  └${'─'.repeat(110)}`);

  // Per-strategy detail
  const sortedByRoi = [...fullResult.strategies].sort((a, b) => b.roiPct - a.roiPct);
  for (const strat of sortedByRoi.slice(0, 5)) {
    const monthlyData = monthResults
      .map(r => ({
        label: r.label,
        roi: r.strategies.find(s => s.name === strat.name)?.roiPct ?? null,
        trades: r.strategies.find(s => s.name === strat.name)?.metrics.totalTrades ?? 0,
      }))
      .filter(d => d.roi !== null && d.trades > 0);

    if (monthlyData.length === 0) continue;

    const monthlyRois = monthlyData.map(d => d.roi!);
    const profitableMonths = monthlyRois.filter(r => r > 0).length;
    const bestIdx = monthlyRois.reduce((bi, v, i) => v > monthlyRois[bi] ? i : bi, 0);
    const worstIdx = monthlyRois.reduce((wi, v, i) => v < monthlyRois[wi] ? i : wi, 0);
    const avgRoi = monthlyRois.reduce((a, b) => a + b, 0) / monthlyRois.length;

    // Compounded monthly ROI
    let compounded = 1.0;
    for (const r of monthlyRois) compounded *= (1 + r / 100);
    const compoundedRoi = (compounded - 1) * 100;

    const qData = quarterResults
      .map(r => ({
        label: r.label,
        roi: r.strategies.find(s => s.name === strat.name)?.roiPct ?? null,
        trades: r.strategies.find(s => s.name === strat.name)?.metrics.totalTrades ?? 0,
      }))
      .filter(d => d.roi !== null && d.trades > 0);
    const profitableQuarters = qData.filter(d => d.roi! > 0).length;

    console.log('');
    console.log(`  ┌─ ${strat.name} (${strat.type}) — ${equityPerStrategy.toFixed(4)} SOL/sub ${'─'.repeat(Math.max(0, 80 - strat.name.length - strat.type.length))}`);
    console.log(`  │`);
    console.log(`  │  2Y Equity:         ${equityPerStrategy.toFixed(4)} → ${strat.finalEquity.toFixed(4)} SOL (${fmtRoi(strat.roiPct).trim()})`);
    console.log(`  │  2Y Trades:         ${strat.metrics.totalTrades}  (Win Rate: ${strat.metrics.winRate.toFixed(1)}%)`);
    console.log(`  │  2Y Sharpe:         ${strat.metrics.sharpe.toFixed(3)}`);
    console.log(`  │  2Y Profit Factor:  ${strat.metrics.profitFactor === Infinity ? 'Inf' : strat.metrics.profitFactor.toFixed(2)}`);
    console.log(`  │  2Y Max Drawdown:   ${strat.maxDdPct.toFixed(1)}%`);
    console.log(`  │  2Y Peak Equity:    ${strat.peakEquity.toFixed(4)} SOL`);
    console.log(`  │`);
    console.log(`  │  Monthly:   ${profitableMonths}/${monthlyData.length} profitable (${(profitableMonths / monthlyData.length * 100).toFixed(0)}%)`);
    console.log(`  │  Quarterly: ${profitableQuarters}/${qData.length} profitable`);
    console.log(`  │  Compounded monthly ROI: ${fmtRoi(compoundedRoi).trim()}`);
    console.log(`  │`);
    console.log(`  │  Best month:  ${monthlyData[bestIdx].label} (${fmtRoi(monthlyRois[bestIdx]).trim()})`);
    console.log(`  │  Worst month: ${monthlyData[worstIdx].label} (${fmtRoi(monthlyRois[worstIdx]).trim()})`);
    console.log(`  │  Avg month:   ${fmtRoi(avgRoi).trim()}`);
    console.log(`  └${'─'.repeat(110)}`);
  }

  // Bet size info
  console.log('');
  console.log(`  ┌─ Bet Sizing (2x Kelly, per-strategy bankroll of ${equityPerStrategy.toFixed(4)} SOL) ${'─'.repeat(50)}`);
  console.log(`  │`);
  console.log(`  │  Kelly fractions:  Trend=12.0% (cap 10%)  Momentum=3.6%  Level=2.0%`);
  console.log(`  │`);
  console.log(`  │  Starting bets:    Trend=${(equityPerStrategy * 0.10).toFixed(4)} SOL  Momentum=${(equityPerStrategy * 0.036).toFixed(4)} SOL  Level=${(equityPerStrategy * 0.020).toFixed(4)} SOL`);

  // Show best-performing strategy's bet evolution
  const best = sortedByRoi[0];
  if (best) {
    console.log(`  │  ${best.name} peak:  Trend=${(best.peakEquity * 0.10).toFixed(4)} SOL  Momentum=${(best.peakEquity * 0.036).toFixed(4)} SOL  Level=${(best.peakEquity * 0.020).toFixed(4)} SOL`);
  }
  console.log(`  └${'─'.repeat(110)}`);

  // SOL price timeline
  console.log('');
  console.log('  ┌─ SOL Price Timeline ─────────────────────────────────────────────────────────────────');
  for (const mp of monthPeriods) {
    const mTicks = sliceTicks(ticks, mp.start, mp.end);
    if (mTicks.length === 0) continue;
    const startP = mTicks[0].price;
    const endP = mTicks[mTicks.length - 1].price;
    const chg = ((endP / startP) - 1) * 100;
    console.log(`  │  ${mp.label.padEnd(10)} $${startP.toFixed(2).padStart(8)} → $${endP.toFixed(2).padStart(8)}  (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%)`);
  }
  console.log(`  └${'─'.repeat(110)}`);

  const totalElapsed = ((Date.now() - globalStart) / 1000).toFixed(1);
  console.log('');
  console.log('═'.repeat(130));
  console.log(`  BACKTEST COMPLETE — ${totalElapsed}s total | ${totalBankroll} SOL → ${fullResult.totalFinalEquity.toFixed(4)} SOL (${fmtRoi(fullResult.portfolioRoiPct).trim()}) | Per-strategy isolated bankrolls`);
  console.log('═'.repeat(130));
  console.log('');
}

main();
