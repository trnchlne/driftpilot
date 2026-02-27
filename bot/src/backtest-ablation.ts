/**
 * Ablation test: remove one strategy at a time to see if portfolio improves.
 * If removing a strategy INCREASES total PnL, it was eating bankroll from winners.
 * Also measures capital efficiency (PnL per SOL deployed) per strategy.
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

// Inlined bankroll for parameter control
class TestBankroll {
  equity: number;
  deployed = 0;
  private kellyMultiplier: number;
  private maxDeployedFraction: number;
  // Track per-strategy capital usage
  capitalHours: Record<string, number> = {};  // strategy → SOL*seconds deployed
  private openPositions: Map<string, { size: number; openTime: number }> = new Map();

  private static BASE_KELLY: Record<string, number> = {
    trend: 0.060, momentum: 0.018, level: 0.010,
  };

  constructor(equity: number, kellyMultiplier: number, maxDeployedFraction: number) {
    this.equity = equity;
    this.kellyMultiplier = kellyMultiplier;
    this.maxDeployedFraction = maxDeployedFraction;
  }

  getBetSize(strategyType: string): number {
    const baseKelly = TestBankroll.BASE_KELLY[strategyType] || 0.01;
    const fraction = baseKelly * this.kellyMultiplier;
    const capped = Math.min(fraction, 0.25);
    const available = Math.max(0, this.equity - this.deployed);
    const bet = available * capped;
    if ((this.deployed + bet) > this.equity * this.maxDeployedFraction) {
      const room = Math.max(0, this.equity * this.maxDeployedFraction - this.deployed);
      if (room < 0.01) return 0;
      return Math.floor(Math.min(bet, room) * 100) / 100;
    }
    if (bet < 0.01) return 0.01;
    return Math.floor(bet * 100) / 100;
  }

  reserve(stratName: string, amount: number, time: number): void {
    this.deployed += amount;
    this.openPositions.set(stratName, { size: amount, openTime: time });
  }

  release(stratName: string, amount: number, time: number): void {
    this.deployed -= amount;
    if (this.deployed < 0) this.deployed = 0;
    const open = this.openPositions.get(stratName);
    if (open) {
      const holdSeconds = time - open.openTime;
      const solHours = open.size * (holdSeconds / 3600);
      this.capitalHours[stratName] = (this.capitalHours[stratName] || 0) + solHours;
      this.openPositions.delete(stratName);
    }
  }

  recordPnl(pnl: number): void {
    this.equity += pnl;
    if (this.equity < 0) this.equity = 0;
  }
}

interface StratPerf {
  name: string;
  type: string;
  trades: number;
  pnl: number;
  wr: number;
  capitalHours: number;  // SOL*hours tied up
  pnlPerCapHour: number; // efficiency: PnL per SOL-hour deployed
  timesSkipped: number;  // times getBetSize returned 0 (capital blocked)
}

interface RunResult {
  label: string;
  strategies: string[];
  finalEquity: number;
  pnl: number;
  roi: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  totalTrades: number;
  perStrat: StratPerf[];
}

function runTest(ticks: Tick[], stratConfigs: StrategyConfig[], bankroll: number, kellyMult: number, label: string): RunResult {
  const bm = new TestBankroll(bankroll, kellyMult, 0.80);

  const instances: { instance: BaseStrategy; config: StrategyConfig }[] = [];
  for (const sc of stratConfigs) {
    const inst = createStrategy(sc);
    instances.push({ instance: inst, config: sc });
  }

  // Monkey-patch getBetSize + disable internal bankroll
  const skipCounts: Record<string, number> = {};
  for (const { instance, config: sc } of instances) {
    skipCounts[sc.name] = 0;
    (instance as any).getBetSize = () => {
      const size = bm.getBetSize(sc.type);
      if (size <= 0) skipCounts[sc.name]++;
      return size;
    };
    (instance as any).bankroll = null;
  }

  let currentTickTime = 0;
  let peakEquity = bankroll;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let totalTrades = 0;
  const stratPnl: Record<string, number> = {};
  const stratTrades: Record<string, number> = {};

  const origLog = console.log;
  console.log = (...args: any[]) => {
    const msg = args.join(' ');
    // Entry detection
    const entryMatch = msg.match(/\[(.+?)\] (?:SOL (?:PUMP|DUMP)|LEVEL (?:LONG|SHORT)) .+? (\d+\.?\d*) SOL/);
    if (entryMatch) {
      const [, name, betStr] = entryMatch;
      const betSize = parseFloat(betStr);
      if (betSize > 0) bm.reserve(name, betSize, currentTickTime);
    }
    // Exit detection
    const exitMatch = msg.match(/\[(.+?)\] EXIT .+? \| .+? \| net ([+-]?\d+\.?\d+) SOL/);
    if (exitMatch) {
      const [, name, pnlStr] = exitMatch;
      totalTrades++;
      const pnl = parseFloat(pnlStr);
      stratPnl[name] = (stratPnl[name] || 0) + pnl;
      stratTrades[name] = (stratTrades[name] || 0) + 1;
      // Release capital
      const inst = instances.find(i => i.instance.name === name);
      if (inst) {
        const paper = (inst.instance as any).paper;
        const trades = (paper as any).trades;
        if (trades && trades.length > 0) {
          bm.release(name, trades[trades.length - 1].sizeSol, currentTickTime);
        }
      }
      bm.recordPnl(pnl);
    }
  };

  let lastSnapTime = 0;
  for (const tick of ticks) {
    currentTickTime = tick.publishTime;
    for (const { instance } of instances) {
      instance.onTick(tick);
    }
    if (tick.publishTime - lastSnapTime >= 60) {
      lastSnapTime = tick.publishTime;
      const eq = bm.equity;
      if (eq > peakEquity) peakEquity = eq;
      const dd = peakEquity - eq;
      if (dd > maxDrawdown) maxDrawdown = dd;
      const ddPct = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    }
  }
  console.log = origLog;

  const finalEquity = bm.equity;
  const pnl = finalEquity - bankroll;
  const roi = ((finalEquity / bankroll) - 1) * 100;

  // Per-strategy performance
  const perStrat: StratPerf[] = [];
  for (const { instance, config: sc } of instances) {
    const m = instance.getMetrics();
    const capHours = bm.capitalHours[sc.name] || 0;
    const sPnl = stratPnl[sc.name] || 0;
    perStrat.push({
      name: sc.name,
      type: sc.type,
      trades: m.totalTrades,
      pnl: sPnl,
      wr: m.winRate,
      capitalHours: capHours,
      pnlPerCapHour: capHours > 0 ? sPnl / capHours : 0,
      timesSkipped: skipCounts[sc.name] || 0,
    });
    instance.stop();
  }

  return {
    label,
    strategies: stratConfigs.map(s => s.name),
    finalEquity, pnl, roi, maxDrawdown, maxDrawdownPct, totalTrades, perStrat,
  };
}

function main(): void {
  const dataPath = process.argv.find((_, i, a) => a[i - 1] === '--data') || '';
  const bankroll = parseFloat(process.argv.find((_, i, a) => a[i - 1] === '--bankroll') || '10');
  const kellyMult = 4.0; // 2x Kelly — the winner from aggressive test

  if (!dataPath) { console.error('Usage: npx tsx src/backtest-ablation.ts --data <path> [--bankroll 10]'); process.exit(1); }

  console.log(`[ablation] Loading ticks...`);
  const ticks = loadTicks(resolve(dataPath));
  const totalDays = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 86400;
  console.log(`[ablation] ${ticks.length.toLocaleString()} ticks (${totalDays.toFixed(0)}d)`);
  console.log(`[ablation] Bankroll: ${bankroll} SOL | Kelly: 2.0x (mult=${kellyMult})\n`);

  // ── 1. Full portfolio baseline with per-strategy stats ──
  process.stderr.write(`[ablation] Running baseline (all 12)...\n`);
  const baseline = runTest(ticks, STRATEGIES, bankroll, kellyMult, 'ALL 12');

  console.log(`${'═'.repeat(130)}`);
  console.log(`  CAPITAL EFFICIENCY — Which strategies earn their keep?`);
  console.log(`${'═'.repeat(130)}`);
  console.log(`  Baseline: ${baseline.roi.toFixed(1)}% ROI | +${baseline.pnl.toFixed(2)} SOL | DD ${baseline.maxDrawdownPct.toFixed(1)}%\n`);

  // Sort by PnL/capital-hour (efficiency)
  const sorted = [...baseline.perStrat].sort((a, b) => b.pnlPerCapHour - a.pnlPerCapHour);

  console.log(`  ${'Rank'.padEnd(5)} ${'Name'.padEnd(15)} ${'Type'.padEnd(10)} ${'Trades'.padStart(7)} ${'WR'.padStart(7)} ${'PnL'.padStart(10)} ${'CapHours'.padStart(10)} ${'PnL/CapHr'.padStart(11)} ${'Skipped'.padStart(8)} ${'Verdict'}`);
  console.log(`  ${'─'.repeat(5)} ${'─'.repeat(15)} ${'─'.repeat(10)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(11)} ${'─'.repeat(8)} ${'─'.repeat(14)}`);

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    let verdict: string;
    if (s.pnl <= 0) verdict = 'PARASITE';
    else if (s.pnlPerCapHour < 0.0001) verdict = 'DRAG';
    else if (s.pnlPerCapHour < 0.001) verdict = 'MARGINAL';
    else verdict = 'EARNER';

    console.log(
      `  ${`#${i + 1}`.padEnd(5)} ${s.name.padEnd(15)} ${s.type.padEnd(10)} ` +
      `${String(s.trades).padStart(7)} ${`${s.wr.toFixed(1)}%`.padStart(7)} ` +
      `${`${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(4)}`.padStart(10)} ` +
      `${s.capitalHours.toFixed(1).padStart(10)} ` +
      `${s.pnlPerCapHour.toFixed(5).padStart(11)} ` +
      `${String(s.timesSkipped).padStart(8)} ` +
      `${verdict}`
    );
  }

  // ── 2. Ablation: remove one at a time ──
  console.log(`\n${'═'.repeat(130)}`);
  console.log(`  ABLATION TEST — Remove one strategy, measure portfolio impact`);
  console.log(`${'═'.repeat(130)}`);

  const ablationResults: { removed: string; type: string; portfolioPnl: number; delta: number; portfolioDD: number }[] = [];

  for (let i = 0; i < STRATEGIES.length; i++) {
    const removed = STRATEGIES[i];
    const remaining = STRATEGIES.filter((_, j) => j !== i);
    process.stderr.write(`\r[ablation] Testing without ${removed.name}...                   `);
    const result = runTest(ticks, remaining, bankroll, kellyMult, `no-${removed.name}`);
    ablationResults.push({
      removed: removed.name,
      type: removed.type,
      portfolioPnl: result.pnl,
      delta: result.pnl - baseline.pnl,
      portfolioDD: result.maxDrawdownPct,
    });
  }
  process.stderr.write(`\r[ablation] Ablation complete.                                    \n`);

  // Sort by delta (most harmful removal first = most valuable strategy)
  ablationResults.sort((a, b) => a.delta - b.delta);

  console.log(`\n  ${'Removed'.padEnd(15)} ${'Type'.padEnd(10)} ${'Portfolio PnL'.padStart(13)} ${'Delta'.padStart(10)} ${'DD%'.padStart(6)} ${'Impact'}`);
  console.log(`  ${'─'.repeat(15)} ${'─'.repeat(10)} ${'─'.repeat(13)} ${'─'.repeat(10)} ${'─'.repeat(6)} ${'─'.repeat(20)}`);

  for (const r of ablationResults) {
    let impact: string;
    if (r.delta < -0.5) impact = 'CRITICAL — keep!';
    else if (r.delta < -0.1) impact = 'VALUABLE';
    else if (r.delta < 0.1) impact = 'NEUTRAL';
    else if (r.delta < 0.5) impact = 'SLIGHTLY HARMFUL';
    else impact = 'REMOVE IT!';

    console.log(
      `  ${r.removed.padEnd(15)} ${r.type.padEnd(10)} ` +
      `${`+${r.portfolioPnl.toFixed(2)}`.padStart(13)} ` +
      `${`${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)}`.padStart(10)} ` +
      `${`${r.portfolioDD.toFixed(1)}%`.padStart(6)} ` +
      `${impact}`
    );
  }

  // ── 3. Group ablation: remove entire types ──
  console.log(`\n${'═'.repeat(130)}`);
  console.log(`  GROUP ABLATION — Remove entire strategy types`);
  console.log(`${'═'.repeat(130)}`);

  const types = ['level', 'momentum'] as const;
  for (const removeType of types) {
    const remaining = STRATEGIES.filter(s => s.type !== removeType);
    process.stderr.write(`\r[ablation] Testing without all ${removeType}...              `);
    const result = runTest(ticks, remaining, bankroll, kellyMult, `no-${removeType}`);
    const delta = result.pnl - baseline.pnl;
    console.log(`\n  Remove all ${removeType} (${STRATEGIES.filter(s => s.type === removeType).length} strategies):`);
    console.log(`    Portfolio PnL: +${result.pnl.toFixed(2)} SOL (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} vs baseline)`);
    console.log(`    Max DD: ${result.maxDrawdownPct.toFixed(1)}% (baseline: ${baseline.maxDrawdownPct.toFixed(1)}%)`);
    console.log(`    Verdict: ${delta > 0.3 ? 'REMOVE — frees capital for winners' : delta > 0 ? 'Slightly better without' : 'Keep — contributes positively'}`);
  }

  // Remove both level + momentum
  {
    const remaining = STRATEGIES.filter(s => s.type === 'trend');
    process.stderr.write(`\r[ablation] Testing trend-only...                               `);
    const result = runTest(ticks, remaining, bankroll, kellyMult, 'trend-only');
    const delta = result.pnl - baseline.pnl;
    console.log(`\n  Remove level + momentum (trend only, ${remaining.length} strategies):`);
    console.log(`    Portfolio PnL: +${result.pnl.toFixed(2)} SOL (${delta >= 0 ? '+' : ''}${delta.toFixed(2)} vs baseline)`);
    console.log(`    Max DD: ${result.maxDrawdownPct.toFixed(1)}% (baseline: ${baseline.maxDrawdownPct.toFixed(1)}%)`);
    console.log(`    Verdict: ${delta > 0.3 ? 'REMOVE — frees capital for winners' : delta > 0 ? 'Slightly better without' : 'Keep — diversification helps'}`);
  }
  process.stderr.write(`\r[ablation] All tests complete.                                   \n`);

  // ── 4. Optimal subset search ──
  console.log(`\n${'═'.repeat(130)}`);
  console.log(`  OPTIMAL SUBSET — Greedy removal of worst strategies`);
  console.log(`${'═'.repeat(130)}`);

  let currentStrats = [...STRATEGIES];
  let currentPnl = baseline.pnl;
  const removalOrder: { name: string; pnlAfter: number; delta: number }[] = [];

  for (let round = 0; round < 8; round++) {
    if (currentStrats.length <= 2) break;

    let bestRemoval = '';
    let bestPnl = -Infinity;
    let bestDD = 0;

    for (let i = 0; i < currentStrats.length; i++) {
      const remaining = currentStrats.filter((_, j) => j !== i);
      const result = runTest(ticks, remaining, bankroll, kellyMult, `opt-${round}`);
      if (result.pnl > bestPnl) {
        bestPnl = result.pnl;
        bestRemoval = currentStrats[i].name;
        bestDD = result.maxDrawdownPct;
      }
    }

    const delta = bestPnl - currentPnl;
    removalOrder.push({ name: bestRemoval, pnlAfter: bestPnl, delta });

    if (delta < 0) {
      // Removing anything hurts — stop
      console.log(`\n  Round ${round + 1}: Removing any strategy hurts PnL — stopping.`);
      break;
    }

    console.log(`  Round ${round + 1}: Remove ${bestRemoval.padEnd(15)} → PnL +${bestPnl.toFixed(2)} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)}) DD ${bestDD.toFixed(1)}%`);
    currentStrats = currentStrats.filter(s => s.name !== bestRemoval);
    currentPnl = bestPnl;
  }

  console.log(`\n  Optimal subset (${currentStrats.length} strategies):`);
  for (const s of currentStrats) {
    console.log(`    - ${s.name} (${s.type})`);
  }
  console.log(`  PnL: +${currentPnl.toFixed(2)} SOL (${((currentPnl / bankroll) * 100).toFixed(1)}% ROI)`);

  console.log('\n');
}

main();
