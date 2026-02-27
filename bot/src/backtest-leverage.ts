/**
 * Leverage & liquidation analysis: measures concurrent position exposure,
 * margin requirements, and drawdowns to determine safe bet sizes on Drift.
 *
 * Drift SOL-PERP specifics:
 *   - Max leverage: 20x (but we'll model 2x-5x)
 *   - Maintenance margin: ~5% of position notional
 *   - Liquidation when account equity < maintenance margin requirement
 *   - Fees: 0% maker (resting limit), 0.02% taker
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

const DRIFT_MAINTENANCE_MARGIN = 0.05; // 5%

interface OpenPosition {
  strategy: string;
  type: string;
  direction: 'long' | 'short';
  entryPrice: number;
  sizeSol: number;
  entryTime: number;
}

interface PositionEvent {
  time: number;
  action: 'open' | 'close';
  strategy: string;
  direction: 'long' | 'short';
  price: number;
  sizeSol: number;
  pnl?: number;
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

function main(): void {
  const dataPath = process.argv.find((_, i, a) => a[i - 1] === '--data') || '';
  if (!dataPath) { console.error('Usage: npx tsx src/backtest-leverage.ts --data <path>'); process.exit(1); }

  console.log(`[leverage] Loading ticks...`);
  const ticks = loadTicks(resolve(dataPath));
  const totalDays = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 86400;
  console.log(`[leverage] ${ticks.length.toLocaleString()} ticks (${totalDays.toFixed(0)}d)\n`);

  // Intercept trade events by wrapping strategies
  const events: PositionEvent[] = [];
  const origLog = console.log;

  // Parse console output to detect position opens/closes
  // Strategy logs: "[name] LEVEL LONG @ $X" for open, "[name] EXIT reason" for close
  // "[name] BTC PUMP/DUMP ... → LONG/SHORT X SOL @ $Y" for momentum/trend
  const openPositions = new Map<string, OpenPosition>();

  console.log = (...args: any[]) => {
    const msg = args.join(' ');

    // Detect entry
    const levelEntry = msg.match(/\[(.+?)\] LEVEL (LONG|SHORT) @ \$(\d+\.?\d*)/);
    const solEntry = msg.match(/\[(.+?)\] SOL (?:PUMP|DUMP).+?(LONG|SHORT) (\d+\.?\d*) SOL @ \$(\d+\.?\d*)/);

    if (levelEntry) {
      const [, name, dir, price] = levelEntry;
      const config = STRATEGIES.find(s => s.name === name);
      const sizeSol = config ? (config as any).betSizeSol : 1;
      openPositions.set(name, {
        strategy: name, type: 'level',
        direction: dir.toLowerCase() as 'long' | 'short',
        entryPrice: parseFloat(price), sizeSol,
        entryTime: Date.now(),
      });
      events.push({ time: Date.now(), action: 'open', strategy: name, direction: dir.toLowerCase() as any, price: parseFloat(price), sizeSol });
    } else if (solEntry) {
      const [, name, dir, size, price] = solEntry;
      openPositions.set(name, {
        strategy: name, type: 'momentum/trend',
        direction: dir.toLowerCase() as 'long' | 'short',
        entryPrice: parseFloat(price), sizeSol: parseFloat(size),
        entryTime: Date.now(),
      });
      events.push({ time: Date.now(), action: 'open', strategy: name, direction: dir.toLowerCase() as any, price: parseFloat(price), sizeSol: parseFloat(size) });
    }

    // Detect exit
    const exitMatch = msg.match(/\[(.+?)\] EXIT (.+?) \| \$(\d+\.?\d*) → \$(\d+\.?\d*) \| net ([+-]?\d+\.?\d*) SOL/);
    if (exitMatch) {
      const [, name, , , exitPrice, pnl] = exitMatch;
      const pos = openPositions.get(name);
      if (pos) {
        events.push({ time: Date.now(), action: 'close', strategy: name, direction: pos.direction, price: parseFloat(exitPrice), sizeSol: pos.sizeSol, pnl: parseFloat(pnl) });
        openPositions.delete(name);
      }
    }
  };

  // Instead of parsing logs (fragile), let's track positions directly
  // by running the backtest and sampling concurrent positions from the strategy state
  console.log = origLog;

  // Better approach: run backtest tick-by-tick and track concurrent state
  const strategies = STRATEGIES.map(c => ({ instance: createStrategy(c), config: c }));

  // Suppress strategy logging
  console.log = () => {};

  // Track stats
  let maxConcurrentPositions = 0;
  let maxConcurrentNotionalSol = 0;
  let maxConcurrentLongs = 0;
  let maxConcurrentShorts = 0;
  let maxUnrealizedLoss = 0;
  let maxAdverseMoveWhileInPosition = 0;

  // Snapshot tracking
  const snapshots: { time: number; concurrent: number; notional: number; unrealizedPnl: number }[] = [];
  let lastSnapshotTime = 0;
  let lastSolPrice = 0;

  const SOL_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

  // Track position state per strategy by checking inPosition
  interface TrackedPosition {
    direction: 'long' | 'short';
    entryPrice: number;
    sizeSol: number;
    maxAdverse: number;
  }
  const tracked = new Map<string, TrackedPosition>();

  for (const tick of ticks) {
    if (tick.feedId === SOL_FEED_ID) lastSolPrice = tick.price;

    // Before tick: record which strategies are in position
    const wasInPosition = new Set<string>();
    for (const { instance } of strategies) {
      if ((instance as any).paper?.inPosition) wasInPosition.add(instance.name);
    }

    // Process tick
    for (const { instance } of strategies) {
      instance.onTick(tick);
    }

    // After tick: detect opens and closes, track concurrent exposure
    let concurrent = 0;
    let notional = 0;
    let unrealizedPnl = 0;
    let longs = 0;
    let shorts = 0;

    for (const { instance, config } of strategies) {
      const paper = (instance as any).paper;
      if (!paper?.inPosition) {
        // Was in position but now isn't → closed
        if (tracked.has(instance.name)) {
          tracked.delete(instance.name);
        }
        continue;
      }

      concurrent++;
      const sizeSol = (config as any).betSizeSol || 1;
      notional += sizeSol;

      // Track entry
      if (!tracked.has(instance.name)) {
        const direction = (instance as any).entryDirection || 'long';
        const entryPrice = (instance as any).entryPrice || lastSolPrice;
        tracked.set(instance.name, { direction, entryPrice, sizeSol, maxAdverse: 0 });
      }

      const pos = tracked.get(instance.name)!;
      if (pos.direction === 'long') {
        longs++;
        const movePct = ((lastSolPrice / pos.entryPrice) - 1) * 100;
        const pnl = movePct / 100 * pos.sizeSol;
        unrealizedPnl += pnl;
        const adverse = Math.max(0, -movePct);
        if (adverse > pos.maxAdverse) pos.maxAdverse = adverse;
        if (adverse > maxAdverseMoveWhileInPosition) maxAdverseMoveWhileInPosition = adverse;
      } else {
        shorts++;
        const movePct = ((lastSolPrice / pos.entryPrice) - 1) * 100;
        const pnl = -movePct / 100 * pos.sizeSol;
        unrealizedPnl += pnl;
        const adverse = Math.max(0, movePct);
        if (adverse > pos.maxAdverse) pos.maxAdverse = adverse;
        if (adverse > maxAdverseMoveWhileInPosition) maxAdverseMoveWhileInPosition = adverse;
      }
    }

    if (concurrent > maxConcurrentPositions) maxConcurrentPositions = concurrent;
    if (notional > maxConcurrentNotionalSol) maxConcurrentNotionalSol = notional;
    if (longs > maxConcurrentLongs) maxConcurrentLongs = longs;
    if (shorts > maxConcurrentShorts) maxConcurrentShorts = shorts;
    if (unrealizedPnl < maxUnrealizedLoss) maxUnrealizedLoss = unrealizedPnl;

    // Snapshot every 5 min (300s)
    if (tick.publishTime - lastSnapshotTime >= 300) {
      snapshots.push({ time: tick.publishTime, concurrent, notional, unrealizedPnl });
      lastSnapshotTime = tick.publishTime;
    }
  }

  console.log = origLog;

  // ── Compute stats ──
  const avgConcurrent = snapshots.reduce((s, snap) => s + snap.concurrent, 0) / snapshots.length;
  const avgNotional = snapshots.reduce((s, snap) => s + snap.notional, 0) / snapshots.length;

  // Compute percentiles for concurrent positions
  const concurrentValues = snapshots.map(s => s.concurrent).sort((a, b) => a - b);
  const notionalValues = snapshots.map(s => s.notional).sort((a, b) => a - b);
  const pnlValues = snapshots.map(s => s.unrealizedPnl).sort((a, b) => a - b);

  const p50c = concurrentValues[Math.floor(concurrentValues.length * 0.5)];
  const p90c = concurrentValues[Math.floor(concurrentValues.length * 0.9)];
  const p95c = concurrentValues[Math.floor(concurrentValues.length * 0.95)];
  const p99c = concurrentValues[Math.floor(concurrentValues.length * 0.99)];

  const p50n = notionalValues[Math.floor(notionalValues.length * 0.5)];
  const p90n = notionalValues[Math.floor(notionalValues.length * 0.9)];
  const p95n = notionalValues[Math.floor(notionalValues.length * 0.95)];
  const p99n = notionalValues[Math.floor(notionalValues.length * 0.99)];

  const p1pnl = pnlValues[Math.floor(pnlValues.length * 0.01)];
  const p5pnl = pnlValues[Math.floor(pnlValues.length * 0.05)];

  // Collect per-strategy metrics
  const stratMetrics: { name: string; type: string; trades: number; pnl: number; bet: number }[] = [];
  for (const { instance, config } of strategies) {
    const m = instance.getMetrics();
    stratMetrics.push({
      name: instance.name, type: instance.type,
      trades: m.totalTrades, pnl: m.netPnlSol,
      bet: (config as any).betSizeSol || 1,
    });
  }
  const totalPnl = stratMetrics.reduce((s, m) => s + m.pnl, 0);

  // ── Print results ──
  console.log(`${'═'.repeat(90)}`);
  console.log(`  DRIFT LEVERAGE & LIQUIDATION ANALYSIS`);
  console.log(`  ${totalDays.toFixed(0)} days | ${ticks.length.toLocaleString()} ticks | 12 strategies | All bets = 1 SOL`);
  console.log(`${'═'.repeat(90)}`);

  console.log(`\n  CONCURRENT POSITION EXPOSURE`);
  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  Max concurrent positions:     ${maxConcurrentPositions}`);
  console.log(`  Max concurrent notional:      ${maxConcurrentNotionalSol} SOL`);
  console.log(`  Max concurrent longs:         ${maxConcurrentLongs}`);
  console.log(`  Max concurrent shorts:        ${maxConcurrentShorts}`);
  console.log(`  Avg concurrent positions:     ${avgConcurrent.toFixed(1)}`);
  console.log(`  Avg concurrent notional:      ${avgNotional.toFixed(1)} SOL`);

  console.log(`\n  CONCURRENT POSITION PERCENTILES`);
  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  Positions — p50: ${p50c}  p90: ${p90c}  p95: ${p95c}  p99: ${p99c}  max: ${maxConcurrentPositions}`);
  console.log(`  Notional  — p50: ${p50n}  p90: ${p90n}  p95: ${p95n}  p99: ${p99n}  max: ${maxConcurrentNotionalSol}`);

  console.log(`\n  WORST-CASE UNREALIZED PnL`);
  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  Max unrealized loss:          ${maxUnrealizedLoss.toFixed(4)} SOL`);
  console.log(`  Max adverse move in position: ${maxAdverseMoveWhileInPosition.toFixed(2)}%`);
  console.log(`  p1 unrealized PnL:            ${p1pnl.toFixed(4)} SOL`);
  console.log(`  p5 unrealized PnL:            ${p5pnl.toFixed(4)} SOL`);

  // ── Leverage analysis ──
  console.log(`\n\n${'═'.repeat(90)}`);
  console.log(`  LEVERAGE SCENARIOS (based on p99 concurrent notional = ${p99n} SOL)`);
  console.log(`${'═'.repeat(90)}`);

  for (const leverage of [2, 3, 5]) {
    const marginRequired = p99n / leverage;
    const maintenanceMargin = p99n * DRIFT_MAINTENANCE_MARGIN;
    const liquidationMove = ((1 / leverage) - DRIFT_MAINTENANCE_MARGIN) * 100;
    const maxSL = Math.max(...STRATEGIES.map(s => (s as any).stopLossPct || 0));
    const safetyMargin = liquidationMove - maxSL;

    console.log(`\n  ${leverage}x LEVERAGE`);
    console.log(`  ─────────────────────────────────────────────────`);
    console.log(`  p99 notional exposure:  ${p99n} SOL`);
    console.log(`  Margin required:        ${marginRequired.toFixed(2)} SOL (collateral needed)`);
    console.log(`  Maintenance margin:     ${maintenanceMargin.toFixed(2)} SOL`);
    console.log(`  Liquidation at:         ${liquidationMove.toFixed(1)}% adverse move`);
    console.log(`  Worst SL in strategies: ${maxSL.toFixed(1)}%`);
    console.log(`  Safety buffer:          ${safetyMargin.toFixed(1)}% (liquidation - max SL)`);
    console.log(`  VERDICT:                ${safetyMargin > 10 ? 'SAFE' : safetyMargin > 5 ? 'OK (tight)' : 'DANGEROUS'}`);
  }

  // ── Bankroll recommendations ──
  console.log(`\n\n${'═'.repeat(90)}`);
  console.log(`  BANKROLL & BET SIZE RECOMMENDATIONS`);
  console.log(`${'═'.repeat(90)}`);

  for (const bankroll of [5, 10, 20, 50]) {
    console.log(`\n  BANKROLL: ${bankroll} SOL`);
    console.log(`  ─────────────────────────────────────────────────`);

    for (const leverage of [2, 3, 5]) {
      const maxNotional = bankroll * leverage;
      // Reserve 20% for margin safety
      const usableNotional = maxNotional * 0.8;
      // Divide by p99 concurrent slots
      const betPerStrategy = usableNotional / p99n;
      const cappedBet = Math.min(betPerStrategy, 1.0);
      const expectedPnlPerYear = totalPnl * (cappedBet / 1.0); // linear scaling
      const roi = (expectedPnlPerYear / bankroll) * 100;

      console.log(`  ${leverage}x: max notional=${maxNotional} SOL → bet=${cappedBet.toFixed(2)} SOL/strategy → est. PnL=${expectedPnlPerYear.toFixed(2)} SOL/yr (${roi.toFixed(1)}% ROI)`);
    }
  }

  // ── Summary ──
  console.log(`\n\n${'═'.repeat(90)}`);
  console.log(`  OPTIMAL SETUP RECOMMENDATION`);
  console.log(`${'═'.repeat(90)}`);

  // Calculate optimal bet for common bankrolls at 2x
  const optBankrolls = [5, 10, 20];
  for (const bankroll of optBankrolls) {
    const maxNotional2x = bankroll * 2 * 0.8;
    const bet2x = Math.min(maxNotional2x / p99n, 1.0);
    const pnl2x = totalPnl * (bet2x / 1.0);
    const roi2x = (pnl2x / bankroll) * 100;

    console.log(`\n  ${bankroll} SOL bankroll @ 2x leverage:`);
    console.log(`    Bet: ${bet2x.toFixed(2)} SOL per strategy`);
    console.log(`    Max exposure: ${(bet2x * p99n).toFixed(1)} SOL (p99) / ${(bet2x * maxConcurrentNotionalSol).toFixed(1)} SOL (absolute max)`);
    console.log(`    Margin used: ${(bet2x * p99n / 2).toFixed(1)} / ${bankroll} SOL = ${((bet2x * p99n / 2 / bankroll) * 100).toFixed(0)}%`);
    console.log(`    Expected PnL: +${pnl2x.toFixed(2)} SOL/year (${roi2x.toFixed(1)}% ROI)`);
    console.log(`    Liquidation buffer: 45% (2x) vs 3% max SL = 42% safety margin`);
  }

  console.log(`\n`);
}

main();
