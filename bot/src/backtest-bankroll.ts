/**
 * 365-day backtest with dynamic bankroll sizing.
 *
 * Starts with a configurable bankroll (default 1 SOL) and runs all
 * 12 strategies with half-Kelly bet sizing. Bets scale with equity:
 * as you win → bets grow, as you lose → bets shrink.
 *
 * Tracks:
 * - Dynamic equity curve (bankroll grows/shrinks)
 * - Concurrent positions + deployed capital
 * - Per-strategy performance with dynamic sizing
 * - Monthly equity snapshots
 * - Margin/leverage analysis
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import type { StrategyConfig } from './strategies.js';
import { STRATEGIES } from './strategies.js';
import { MomentumStrategy } from './momentum.js';
import { TrendStrategy } from './trend.js';
import { LevelStrategy } from './level.js';
import type { BaseStrategy } from './base-strategy.js';
import { BankrollManager } from './bankroll.js';

const SOL_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

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

interface TradeRecord {
  time: number;
  strategy: string;
  type: string;
  pnl: number;
  betSize: number;
  equityAfter: number;
}

interface EquitySnapshot {
  time: number;
  equity: number;
  deployed: number;
  concurrent: number;
}

function main(): void {
  const args = process.argv.slice(2);
  let dataPath = '';
  let startingBankroll = 1.0;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data' && args[i + 1]) { dataPath = args[i + 1]; i++; }
    if (args[i] === '--bankroll' && args[i + 1]) { startingBankroll = parseFloat(args[i + 1]); i++; }
  }

  if (!dataPath) {
    console.error('Usage: npx tsx src/backtest-bankroll.ts --data <path> [--bankroll 1.0]');
    process.exit(1);
  }

  console.log(`[backtest] Loading ticks...`);
  const ticks = loadTicks(resolve(dataPath));
  const totalDays = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 86400;
  console.log(`[backtest] ${ticks.length.toLocaleString()} ticks (${totalDays.toFixed(0)}d)`);
  console.log(`[backtest] Starting bankroll: ${startingBankroll} SOL\n`);

  // Create bankroll manager
  const bankroll = new BankrollManager({
    mode: 'paper',
    initialEquitySol: startingBankroll,
  });

  // Create strategies and wire bankroll
  const strategies = STRATEGIES.map(c => {
    const instance = createStrategy(c);
    if (instance.setBankroll) instance.setBankroll(bankroll);
    return { instance, config: c };
  });

  // Capture trades by intercepting console output
  const trades: TradeRecord[] = [];
  let currentTickTime = 0;

  const origLog = console.log;
  console.log = (...args: any[]) => {
    const msg = args.join(' ');
    const exitMatch = msg.match(/\[(.+?)\] EXIT .+? \| .+? \| net ([+-]?\d+\.?\d+) SOL/);
    if (exitMatch) {
      const [, name, pnlStr] = exitMatch;
      const config = STRATEGIES.find(s => s.name === name);
      trades.push({
        time: currentTickTime,
        strategy: name,
        type: config?.type || '?',
        pnl: parseFloat(pnlStr),
        betSize: 0, // filled below
        equityAfter: bankroll.getEquity(),
      });
    }
  };

  // Track equity + exposure over time
  const equitySnapshots: EquitySnapshot[] = [];
  const monthlyEquity: { month: string; equity: number; trades: number; pnl: number }[] = [];
  let lastSnapTime = 0;
  let lastMonthKey = '';
  let monthTradeCount = 0;
  let monthStartEquity = startingBankroll;

  // Track concurrent positions
  let maxConcurrent = 0;
  let maxDeployed = 0;
  let peakEquity = startingBankroll;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let skippedTrades = 0;

  // Count skipped trades by intercepting "betSize <= 0" (getBetSize returns 0)
  // We already handle this in strategy code — we'll count via equity snapshots

  const runStart = Date.now();

  for (const tick of ticks) {
    currentTickTime = tick.publishTime;
    if (tick.feedId === SOL_FEED) {
      bankroll.updateSolPrice(tick.price);
    }

    for (const { instance } of strategies) {
      instance.onTick(tick);
    }

    // Snapshot every 60s
    if (tick.publishTime - lastSnapTime >= 60) {
      const equity = bankroll.getEquity();
      const deployed = bankroll.getDeployed();
      let concurrent = 0;

      for (const { instance } of strategies) {
        if ((instance as any).paper?.inPosition) concurrent++;
      }

      equitySnapshots.push({ time: tick.publishTime, equity, deployed, concurrent });
      lastSnapTime = tick.publishTime;

      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
      if (deployed > maxDeployed) maxDeployed = deployed;

      // Track drawdown
      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity - equity;
      if (dd > maxDrawdown) maxDrawdown = dd;
      const ddPct = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

      // Monthly tracking
      const date = new Date(tick.publishTime * 1000);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (monthKey !== lastMonthKey) {
        if (lastMonthKey) {
          monthlyEquity.push({
            month: lastMonthKey,
            equity: monthStartEquity,
            trades: monthTradeCount,
            pnl: equity - monthStartEquity,
          });
        }
        lastMonthKey = monthKey;
        monthStartEquity = equity;
        monthTradeCount = 0;
      }
      monthTradeCount = trades.length; // approximate
    }
  }

  // Final month
  if (lastMonthKey) {
    monthlyEquity.push({
      month: lastMonthKey,
      equity: bankroll.getEquity(),
      trades: trades.length,
      pnl: bankroll.getEquity() - monthStartEquity,
    });
  }

  console.log = origLog;
  const runMs = Date.now() - runStart;

  // ── RESULTS ──
  const finalEquity = bankroll.getEquity();
  const totalPnl = finalEquity - startingBankroll;
  const roi = ((finalEquity / startingBankroll) - 1) * 100;

  console.log(`${'═'.repeat(110)}`);
  console.log(`  DYNAMIC BANKROLL BACKTEST — 365 DAYS`);
  console.log(`${'═'.repeat(110)}`);
  console.log(`  Starting bankroll: ${startingBankroll.toFixed(4)} SOL`);
  console.log(`  Final equity:      ${finalEquity.toFixed(4)} SOL`);
  console.log(`  Net P&L:           ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL (${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI)`);
  console.log(`  Total trades:      ${trades.length}`);
  console.log(`  Peak equity:       ${peakEquity.toFixed(4)} SOL`);
  console.log(`  Max drawdown:      ${maxDrawdown.toFixed(4)} SOL (${maxDrawdownPct.toFixed(1)}% from peak)`);
  console.log(`  Max concurrent:    ${maxConcurrent} positions`);
  console.log(`  Max deployed:      ${maxDeployed.toFixed(4)} SOL (${(maxDeployed / startingBankroll * 100).toFixed(1)}% of starting)`);
  console.log(`  Run time:          ${(runMs / 1000).toFixed(1)}s`);

  // ── Per-strategy breakdown ──
  console.log(`\n${'─'.repeat(110)}`);
  console.log(`  PER-STRATEGY RESULTS`);
  console.log(`${'─'.repeat(110)}`);

  // Collect per-strategy metrics
  const stratResults: { name: string; type: string; trades: number; pnl: number; wr: number; sharpe: number; pf: number; avgBet: number }[] = [];

  for (const { instance } of strategies) {
    const m = instance.getMetrics();
    const stratTrades = trades.filter(t => t.strategy === instance.name);
    stratResults.push({
      name: instance.name,
      type: instance.type,
      trades: m.totalTrades,
      pnl: m.netPnlSol,
      wr: m.winRate,
      sharpe: m.sharpe,
      pf: m.profitFactor,
      avgBet: stratTrades.length > 0 ? stratTrades.reduce((s, t) => s + Math.abs(t.pnl), 0) / stratTrades.length : 0,
    });
  }

  // Sort by PnL
  stratResults.sort((a, b) => b.pnl - a.pnl);

  console.log(`  ${'Rank'.padEnd(5)}  ${'Name'.padEnd(15)}  ${'Type'.padEnd(10)}  ${'Trades'.padStart(7)}  ${'WR'.padStart(7)}  ${'Net PnL'.padStart(12)}  ${'Sharpe'.padStart(7)}  ${'PF'.padStart(7)}`);
  console.log(`  ${'─'.repeat(5)}  ${'─'.repeat(15)}  ${'─'.repeat(10)}  ${'─'.repeat(7)}  ${'─'.repeat(7)}  ${'─'.repeat(12)}  ${'─'.repeat(7)}  ${'─'.repeat(7)}`);

  for (let i = 0; i < stratResults.length; i++) {
    const s = stratResults[i];
    const pnlStr = `${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(6)}`;
    const pfStr = s.pf === Infinity ? 'Inf' : s.pf.toFixed(2);
    console.log(
      `  ${`#${i + 1}`.padEnd(5)}  ${s.name.padEnd(15)}  ${s.type.padEnd(10)}  ${String(s.trades).padStart(7)}  ` +
      `${s.trades > 0 ? `${s.wr.toFixed(1)}%` : '--'}`.padStart(7) + `  ${pnlStr.padStart(12)}  ` +
      `${s.sharpe.toFixed(3).padStart(7)}  ${pfStr.padStart(7)}`
    );
  }

  const profitable = stratResults.filter(s => s.pnl > 0).length;
  console.log(`\n  ${profitable}/${stratResults.length} profitable`);

  // ── Monthly equity curve ──
  console.log(`\n${'─'.repeat(110)}`);
  console.log(`  MONTHLY EQUITY CURVE`);
  console.log(`${'─'.repeat(110)}`);

  // Build monthly snapshots from equity snapshots
  const monthMap = new Map<string, { endEquity: number; minEquity: number; maxEquity: number }>();
  for (const snap of equitySnapshots) {
    const date = new Date(snap.time * 1000);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const existing = monthMap.get(key);
    if (!existing) {
      monthMap.set(key, { endEquity: snap.equity, minEquity: snap.equity, maxEquity: snap.equity });
    } else {
      existing.endEquity = snap.equity;
      if (snap.equity < existing.minEquity) existing.minEquity = snap.equity;
      if (snap.equity > existing.maxEquity) existing.maxEquity = snap.equity;
    }
  }

  console.log(`  ${'Month'.padEnd(8)}  ${'Equity'.padStart(10)}  ${'Min'.padStart(10)}  ${'Max'.padStart(10)}  ${'Change'.padStart(10)}  ${'Graph'}`);
  console.log(`  ${'─'.repeat(8)}  ${'─'.repeat(10)}  ${'─'.repeat(10)}  ${'─'.repeat(10)}  ${'─'.repeat(10)}  ${'─'.repeat(40)}`);

  let prevEquity = startingBankroll;
  for (const [month, data] of monthMap) {
    const change = data.endEquity - prevEquity;
    const changeStr = `${change >= 0 ? '+' : ''}${change.toFixed(4)}`;

    // Simple bar chart
    const barWidth = Math.max(0, Math.min(40, Math.round((data.endEquity / (peakEquity * 1.1)) * 40)));
    const bar = '#'.repeat(barWidth);

    console.log(
      `  ${month.padEnd(8)}  ${data.endEquity.toFixed(4).padStart(10)}  ` +
      `${data.minEquity.toFixed(4).padStart(10)}  ${data.maxEquity.toFixed(4).padStart(10)}  ` +
      `${changeStr.padStart(10)}  ${bar}`
    );

    prevEquity = data.endEquity;
  }

  // ── Concurrent position analysis ──
  console.log(`\n${'─'.repeat(110)}`);
  console.log(`  CONCURRENT POSITION ANALYSIS`);
  console.log(`${'─'.repeat(110)}`);

  // Distribution of concurrent positions
  const concurrentDist: Record<number, number> = {};
  for (const snap of equitySnapshots) {
    concurrentDist[snap.concurrent] = (concurrentDist[snap.concurrent] || 0) + 1;
  }

  const totalSnaps = equitySnapshots.length;
  console.log(`\n  Positions open   % of time`);
  console.log(`  ──────────────   ─────────`);
  for (const count of Object.keys(concurrentDist).map(Number).sort((a, b) => a - b)) {
    const pct = (concurrentDist[count] / totalSnaps) * 100;
    const bar = '#'.repeat(Math.round(pct / 2));
    console.log(`  ${String(count).padStart(14)}   ${pct.toFixed(1).padStart(5)}%  ${bar}`);
  }

  // Deployed capital analysis
  const deployedValues = equitySnapshots.map(s => s.deployed).sort((a, b) => a - b);
  const avgDeployed = deployedValues.reduce((s, v) => s + v, 0) / deployedValues.length;
  const p50Deployed = deployedValues[Math.floor(deployedValues.length * 0.50)];
  const p95Deployed = deployedValues[Math.floor(deployedValues.length * 0.95)];
  const p99Deployed = deployedValues[Math.floor(deployedValues.length * 0.99)];

  console.log(`\n  Deployed capital stats:`);
  console.log(`    Average:  ${avgDeployed.toFixed(4)} SOL (${(avgDeployed / startingBankroll * 100).toFixed(1)}% of starting)`);
  console.log(`    p50:      ${p50Deployed.toFixed(4)} SOL`);
  console.log(`    p95:      ${p95Deployed.toFixed(4)} SOL`);
  console.log(`    p99:      ${p99Deployed.toFixed(4)} SOL`);
  console.log(`    Max:      ${maxDeployed.toFixed(4)} SOL`);

  // ── Drift leverage analysis ──
  console.log(`\n${'─'.repeat(110)}`);
  console.log(`  DRIFT LEVERAGE ANALYSIS (starting ${startingBankroll} SOL)`);
  console.log(`${'─'.repeat(110)}`);

  for (const leverage of [2, 3, 5]) {
    const maxNotional = startingBankroll * leverage;
    const peakDeployedFits = maxDeployed <= maxNotional;
    const marginUsed = maxDeployed / leverage;
    const marginPct = (marginUsed / startingBankroll) * 100;

    // Liquidation: happens when equity < maintenance margin on total position
    // maintenance margin = 5% of notional
    const maintMargin = maxDeployed * 0.05;
    // Worst case: all positions in max drawdown simultaneously
    const worstEquity = startingBankroll - maxDrawdown;
    const survives = worstEquity > maintMargin;

    console.log(`\n  ${leverage}x leverage:`);
    console.log(`    Max notional: ${maxNotional.toFixed(4)} SOL | Peak deployed: ${maxDeployed.toFixed(4)} SOL → ${peakDeployedFits ? 'FITS' : 'OVER MARGIN'}`);
    console.log(`    Margin used:  ${marginUsed.toFixed(4)} SOL (${marginPct.toFixed(1)}% of bankroll)`);
    console.log(`    Worst equity: ${worstEquity.toFixed(4)} SOL | Maint margin: ${maintMargin.toFixed(4)} SOL → ${survives ? 'SURVIVES' : 'LIQUIDATION RISK'}`);
  }

  // ── Bet size evolution ──
  console.log(`\n${'─'.repeat(110)}`);
  console.log(`  BET SIZE EVOLUTION`);
  console.log(`${'─'.repeat(110)}`);

  // Sample bet sizes at different equity levels
  const equityLevels = [
    { label: 'Start', equity: startingBankroll },
    { label: 'Min equity', equity: equitySnapshots.reduce((min, s) => s.equity < min ? s.equity : min, startingBankroll) },
    { label: 'Final', equity: finalEquity },
    { label: 'Peak', equity: peakEquity },
  ];

  console.log(`  ${'Point'.padEnd(14)}  ${'Equity'.padStart(10)}  ${'Trend bet'.padStart(10)}  ${'Mom bet'.padStart(10)}  ${'Level bet'.padStart(10)}  ${'All 12 max'.padStart(12)}`);
  console.log(`  ${'─'.repeat(14)}  ${'─'.repeat(10)}  ${'─'.repeat(10)}  ${'─'.repeat(10)}  ${'─'.repeat(10)}  ${'─'.repeat(12)}`);

  for (const { label, equity } of equityLevels) {
    // Simulate what getBetSize would return at this equity
    const trendFrac = Math.min(0.060, 0.10);
    const momFrac = Math.min(0.018, 0.10);
    const lvlFrac = Math.min(0.010, 0.10);

    const tBet = Math.floor(equity * trendFrac * 100) / 100;
    const mBet = Math.floor(equity * momFrac * 100) / 100;
    const lBet = Math.floor(equity * lvlFrac * 100) / 100;
    const maxTotal = tBet * 5 + mBet * 3 + lBet * 4; // 5 trend + 3 mom + 4 level

    console.log(
      `  ${label.padEnd(14)}  ${equity.toFixed(4).padStart(10)}  ` +
      `${tBet.toFixed(4).padStart(10)}  ${mBet.toFixed(4).padStart(10)}  ` +
      `${lBet.toFixed(4).padStart(10)}  ${maxTotal.toFixed(4).padStart(12)}`
    );
  }

  // ── Final summary ──
  console.log(`\n${'═'.repeat(110)}`);
  console.log(`  SUMMARY`);
  console.log(`${'═'.repeat(110)}`);
  console.log(`\n  Starting with ${startingBankroll} SOL, after 365 days:`);
  console.log(`    Final equity: ${finalEquity.toFixed(4)} SOL (${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI)`);
  console.log(`    Total trades: ${trades.length} | ${profitable}/${stratResults.length} strategies profitable`);
  console.log(`    Max drawdown: ${maxDrawdown.toFixed(4)} SOL (${maxDrawdownPct.toFixed(1)}% from peak)`);
  console.log(`    Max concurrent: ${maxConcurrent} positions | Max deployed: ${maxDeployed.toFixed(4)} SOL`);
  console.log(`\n  Concurrent bet handling:`);
  console.log(`    - Available equity = total equity - deployed capital`);
  console.log(`    - New bets sized from available equity only (not total)`);
  console.log(`    - 80% deployment cap prevents over-allocation`);
  console.log(`    - Capital released back to pool when positions close`);
  console.log(`    - Result: bets auto-shrink as more positions open simultaneously`);

  if (startingBankroll <= 2) {
    console.log(`\n  NOTE: With ${startingBankroll} SOL bankroll, individual bets are tiny:`);
    console.log(`    Trend: ~${(startingBankroll * 0.06).toFixed(3)} SOL/trade | Momentum: ~${(startingBankroll * 0.018).toFixed(3)} SOL | Level: ~${(startingBankroll * 0.01).toFixed(3)} SOL`);
    console.log(`    Drift min order size may be a constraint — verify minimum notional.`);
  }

  console.log('\n');
}

main();
