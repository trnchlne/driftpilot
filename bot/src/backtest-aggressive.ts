/**
 * Aggressive bankroll optimization.
 *
 * Tests different Kelly multipliers, strategy subsets, and deployment
 * caps to find the highest ROI that stays safe (max DD < 25% of bankroll).
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

// ── Custom bankroll manager for parameter sweep ──
// Inlined so we can vary Kelly multiplier and caps per run
class AggressiveBankroll {
  equity: number;
  deployed = 0;
  private kellyMultiplier: number;
  private maxDeployedFraction: number;

  private static BASE_KELLY: Record<string, number> = {
    trend:    0.060,
    momentum: 0.018,
    level:    0.010,
  };

  constructor(equity: number, kellyMultiplier: number, maxDeployedFraction: number) {
    this.equity = equity;
    this.kellyMultiplier = kellyMultiplier;
    this.maxDeployedFraction = maxDeployedFraction;
  }

  getBetSize(strategyType: string): number {
    const baseKelly = AggressiveBankroll.BASE_KELLY[strategyType] || 0.01;
    const fraction = baseKelly * this.kellyMultiplier;
    const capped = Math.min(fraction, 0.25); // absolute cap per trade

    const available = Math.max(0, this.equity - this.deployed);
    const bet = available * capped;

    // Deployment cap
    if ((this.deployed + bet) > this.equity * this.maxDeployedFraction) {
      const room = Math.max(0, this.equity * this.maxDeployedFraction - this.deployed);
      if (room < 0.01) return 0;
      return Math.floor(Math.min(bet, room) * 100) / 100;
    }

    if (bet < 0.01) return 0.01;
    return Math.floor(bet * 100) / 100;
  }

  reserve(amount: number): void { this.deployed += amount; }
  release(amount: number): void { this.deployed -= amount; if (this.deployed < 0) this.deployed = 0; }
  recordPnl(pnl: number): void { this.equity += pnl; if (this.equity < 0) this.equity = 0; }
}

// ── Strategy subsets ──
const TREND_ONLY = STRATEGIES.filter(s => s.type === 'trend');
const TREND_PLUS_MOM = STRATEGIES.filter(s => s.type === 'trend' || s.type === 'momentum');
const TOP3_TREND = STRATEGIES.filter(s => ['T-champion', 'T-fast-trail', 'T-selective'].includes(s.name));
const TOP2_TREND = STRATEGIES.filter(s => ['T-champion', 'T-fast-trail'].includes(s.name));
const ALL = STRATEGIES;

interface RunConfig {
  label: string;
  strategies: StrategyConfig[];
  kellyMultiplier: number;  // 1.0 = half-Kelly (our base), 2.0 = full Kelly, etc.
  maxDeployedFraction: number;
}

interface RunResult {
  label: string;
  stratCount: number;
  kellyMult: number;
  deployCap: number;
  finalEquity: number;
  pnl: number;
  roi: number;
  totalTrades: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  maxDeployed: number;
  maxConcurrent: number;
  profitable: number;
  // Quarterly stability
  q1Pnl: number;
  q2Pnl: number;
  q3Pnl: number;
  q4Pnl: number;
  quartersPositive: number;
}

function runBacktest(ticks: Tick[], config: RunConfig, startingBankroll: number): RunResult {
  const bankroll = new AggressiveBankroll(startingBankroll, config.kellyMultiplier, config.maxDeployedFraction);

  // Create strategies — we need to manually wire the bankroll since it's a custom class
  const instances: { instance: BaseStrategy; config: StrategyConfig }[] = [];
  for (const sc of config.strategies) {
    const inst = createStrategy(sc);
    instances.push({ instance: inst, config: sc });
  }

  // Intercept trades to track PnL flow
  let totalTrades = 0;
  let currentTickTime = 0;
  let peakEquity = startingBankroll;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let maxDeployed = 0;
  let maxConcurrent = 0;

  // Quarterly tracking
  const startTime = ticks[0].publishTime;
  const endTime = ticks[ticks.length - 1].publishTime;
  const span = endTime - startTime;
  const q1End = startTime + span * 0.25;
  const q2End = startTime + span * 0.50;
  const q3End = startTime + span * 0.75;
  let equityAtQ1 = 0, equityAtQ2 = 0, equityAtQ3 = 0;

  const origLog = console.log;
  console.log = (...args: any[]) => {
    const msg = args.join(' ');
    // Detect entries to reserve capital
    const entryMatch = msg.match(/\[(.+?)\] (?:BTC (?:PUMP|DUMP)|LEVEL (?:LONG|SHORT)) .+? (\d+\.?\d*) SOL/);
    if (entryMatch) {
      const betSize = parseFloat(entryMatch[2]);
      if (betSize > 0) bankroll.reserve(betSize);
    }
    // Detect exits to release capital and record PnL
    const exitMatch = msg.match(/\[(.+?)\] EXIT .+? \| .+? \| net ([+-]?\d+\.?\d+) SOL/);
    if (exitMatch) {
      totalTrades++;
      const pnl = parseFloat(exitMatch[2]);
      // Find the strategy's bet size to release
      const name = exitMatch[1];
      const inst = instances.find(i => i.instance.name === name);
      if (inst) {
        const paper = (inst.instance as any).paper;
        // The trade just closed so we need to find the size from the last trade
        const trades = (paper as any).trades;
        if (trades && trades.length > 0) {
          const lastTrade = trades[trades.length - 1];
          bankroll.release(lastTrade.sizeSol);
        }
      }
      bankroll.recordPnl(pnl);
    }
  };

  // We need to override getBetSize on each strategy to use our bankroll
  for (const { instance, config: sc } of instances) {
    // Monkey-patch getBetSize
    (instance as any).getBetSize = () => bankroll.getBetSize(sc.type);
    // Disable the bankroll reserve/release/recordPnl since we handle it via log interception
    (instance as any).bankroll = null;
  }

  let lastSnapTime = 0;

  for (const tick of ticks) {
    currentTickTime = tick.publishTime;
    if (tick.feedId === SOL_FEED) {
      // bankroll doesn't need SOL price in paper mode
    }

    for (const { instance } of instances) {
      instance.onTick(tick);
    }

    // Snapshot every 60s
    if (tick.publishTime - lastSnapTime >= 60) {
      lastSnapTime = tick.publishTime;

      const equity = bankroll.equity;
      const deployed = bankroll.deployed;

      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity - equity;
      if (dd > maxDrawdown) maxDrawdown = dd;
      const ddPct = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
      if (deployed > maxDeployed) maxDeployed = deployed;

      let concurrent = 0;
      for (const { instance } of instances) {
        if ((instance as any).paper?.inPosition) concurrent++;
      }
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;

      // Quarterly checkpoints
      if (!equityAtQ1 && tick.publishTime >= q1End) equityAtQ1 = equity;
      if (!equityAtQ2 && tick.publishTime >= q2End) equityAtQ2 = equity;
      if (!equityAtQ3 && tick.publishTime >= q3End) equityAtQ3 = equity;
    }
  }

  console.log = origLog;

  const finalEquity = bankroll.equity;
  const pnl = finalEquity - startingBankroll;
  const roi = ((finalEquity / startingBankroll) - 1) * 100;

  // Quarterly PnL
  const q1Pnl = equityAtQ1 - startingBankroll;
  const q2Pnl = equityAtQ2 - equityAtQ1;
  const q3Pnl = equityAtQ3 - equityAtQ2;
  const q4Pnl = finalEquity - equityAtQ3;
  const quartersPositive = [q1Pnl, q2Pnl, q3Pnl, q4Pnl].filter(q => q > 0).length;

  // Count profitable strategies
  let profitable = 0;
  for (const { instance } of instances) {
    if (instance.getMetrics().netPnlSol > 0) profitable++;
  }

  // Cleanup
  for (const { instance } of instances) instance.stop();

  return {
    label: config.label,
    stratCount: config.strategies.length,
    kellyMult: config.kellyMultiplier,
    deployCap: config.maxDeployedFraction,
    finalEquity, pnl, roi, totalTrades,
    maxDrawdown, maxDrawdownPct, maxDeployed, maxConcurrent,
    profitable,
    q1Pnl, q2Pnl, q3Pnl, q4Pnl, quartersPositive,
  };
}

function main(): void {
  const dataPath = process.argv.find((_, i, a) => a[i - 1] === '--data') || '';
  const startingBankroll = parseFloat(process.argv.find((_, i, a) => a[i - 1] === '--bankroll') || '10');

  if (!dataPath) {
    console.error('Usage: npx tsx src/backtest-aggressive.ts --data <path> [--bankroll 10]');
    process.exit(1);
  }

  console.log(`[aggressive] Loading ticks...`);
  const ticks = loadTicks(resolve(dataPath));
  const totalDays = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 86400;
  console.log(`[aggressive] ${ticks.length.toLocaleString()} ticks (${totalDays.toFixed(0)}d)`);
  console.log(`[aggressive] Starting bankroll: ${startingBankroll} SOL\n`);

  // ── Define test configurations ──
  const configs: RunConfig[] = [
    // Baseline: current half-Kelly, all 12 strategies
    { label: 'baseline-all12',       strategies: ALL,            kellyMultiplier: 1.0, maxDeployedFraction: 0.80 },

    // Strategy subset tests (half-Kelly)
    { label: 'trend-only-5',         strategies: TREND_ONLY,     kellyMultiplier: 1.0, maxDeployedFraction: 0.80 },
    { label: 'trend+mom-8',          strategies: TREND_PLUS_MOM, kellyMultiplier: 1.0, maxDeployedFraction: 0.80 },
    { label: 'top3-trend',           strategies: TOP3_TREND,     kellyMultiplier: 1.0, maxDeployedFraction: 0.80 },
    { label: 'top2-trend',           strategies: TOP2_TREND,     kellyMultiplier: 1.0, maxDeployedFraction: 0.80 },

    // Kelly multiplier tests (all 12)
    { label: 'all12-0.75K',          strategies: ALL,            kellyMultiplier: 1.5, maxDeployedFraction: 0.80 },
    { label: 'all12-1.0K',           strategies: ALL,            kellyMultiplier: 2.0, maxDeployedFraction: 0.80 },
    { label: 'all12-1.5K',           strategies: ALL,            kellyMultiplier: 3.0, maxDeployedFraction: 0.80 },
    { label: 'all12-2.0K',           strategies: ALL,            kellyMultiplier: 4.0, maxDeployedFraction: 0.80 },

    // Kelly multiplier tests (trend only)
    { label: 'trend5-0.75K',         strategies: TREND_ONLY,     kellyMultiplier: 1.5, maxDeployedFraction: 0.90 },
    { label: 'trend5-1.0K',          strategies: TREND_ONLY,     kellyMultiplier: 2.0, maxDeployedFraction: 0.90 },
    { label: 'trend5-1.5K',          strategies: TREND_ONLY,     kellyMultiplier: 3.0, maxDeployedFraction: 0.90 },
    { label: 'trend5-2.0K',          strategies: TREND_ONLY,     kellyMultiplier: 4.0, maxDeployedFraction: 0.90 },
    { label: 'trend5-2.5K',          strategies: TREND_ONLY,     kellyMultiplier: 5.0, maxDeployedFraction: 0.90 },
    { label: 'trend5-3.0K',          strategies: TREND_ONLY,     kellyMultiplier: 6.0, maxDeployedFraction: 0.90 },

    // Kelly multiplier tests (top 3 trend)
    { label: 'top3-0.75K',           strategies: TOP3_TREND,     kellyMultiplier: 1.5, maxDeployedFraction: 0.90 },
    { label: 'top3-1.0K',            strategies: TOP3_TREND,     kellyMultiplier: 2.0, maxDeployedFraction: 0.90 },
    { label: 'top3-1.5K',            strategies: TOP3_TREND,     kellyMultiplier: 3.0, maxDeployedFraction: 0.90 },
    { label: 'top3-2.0K',            strategies: TOP3_TREND,     kellyMultiplier: 4.0, maxDeployedFraction: 0.90 },
    { label: 'top3-2.5K',            strategies: TOP3_TREND,     kellyMultiplier: 5.0, maxDeployedFraction: 0.90 },
    { label: 'top3-3.0K',            strategies: TOP3_TREND,     kellyMultiplier: 6.0, maxDeployedFraction: 0.90 },
    { label: 'top3-4.0K',            strategies: TOP3_TREND,     kellyMultiplier: 8.0, maxDeployedFraction: 0.90 },

    // Top2 (champion + fast-trail) aggressive
    { label: 'top2-1.0K',            strategies: TOP2_TREND,     kellyMultiplier: 2.0, maxDeployedFraction: 0.90 },
    { label: 'top2-2.0K',            strategies: TOP2_TREND,     kellyMultiplier: 4.0, maxDeployedFraction: 0.90 },
    { label: 'top2-3.0K',            strategies: TOP2_TREND,     kellyMultiplier: 6.0, maxDeployedFraction: 0.90 },
    { label: 'top2-4.0K',            strategies: TOP2_TREND,     kellyMultiplier: 8.0, maxDeployedFraction: 0.90 },
    { label: 'top2-5.0K',            strategies: TOP2_TREND,     kellyMultiplier: 10.0, maxDeployedFraction: 0.90 },

    // Deployment cap tests (trend5 at full Kelly)
    { label: 'trend5-1K-cap90',      strategies: TREND_ONLY,     kellyMultiplier: 2.0, maxDeployedFraction: 0.90 },
    { label: 'trend5-1K-cap95',      strategies: TREND_ONLY,     kellyMultiplier: 2.0, maxDeployedFraction: 0.95 },
    { label: 'trend5-1K-nocap',      strategies: TREND_ONLY,     kellyMultiplier: 2.0, maxDeployedFraction: 1.00 },

    // Ultra aggressive: top3 trend, high Kelly, high cap
    { label: 'YOLO-top3-5K-95',      strategies: TOP3_TREND,     kellyMultiplier: 10.0, maxDeployedFraction: 0.95 },
    { label: 'YOLO-top3-6K-95',      strategies: TOP3_TREND,     kellyMultiplier: 12.0, maxDeployedFraction: 0.95 },
    { label: 'YOLO-top2-6K-95',      strategies: TOP2_TREND,     kellyMultiplier: 12.0, maxDeployedFraction: 0.95 },
    { label: 'YOLO-top2-8K-95',      strategies: TOP2_TREND,     kellyMultiplier: 16.0, maxDeployedFraction: 0.95 },
  ];

  const results: RunResult[] = [];
  const totalConfigs = configs.length;

  for (let i = 0; i < configs.length; i++) {
    process.stderr.write(`\r[aggressive] Running ${i + 1}/${totalConfigs}: ${configs[i].label}...`);
    results.push(runBacktest(ticks, configs[i], startingBankroll));
  }
  process.stderr.write(`\r[aggressive] All ${totalConfigs} configs complete.                    \n\n`);

  // ── Print results sorted by ROI ──
  results.sort((a, b) => b.roi - a.roi);

  console.log(`${'═'.repeat(140)}`);
  console.log(`  AGGRESSIVE OPTIMIZATION — ${startingBankroll} SOL BANKROLL, 365 DAYS`);
  console.log(`${'═'.repeat(140)}`);

  console.log(`\n  ${'Rank'.padEnd(5)} ${'Config'.padEnd(22)} ${'Strats'.padStart(6)} ${'Kelly'.padStart(6)} ${'Cap'.padStart(5)} ${'ROI'.padStart(8)} ${'PnL'.padStart(10)} ${'Final'.padStart(10)} ${'MaxDD'.padStart(8)} ${'DD%'.padStart(6)} ${'Trades'.padStart(7)} ${'MaxDep'.padStart(8)} ${'Q+'.padStart(3)} ${'Q1'.padStart(8)} ${'Q2'.padStart(8)} ${'Q3'.padStart(8)} ${'Q4'.padStart(8)} ${'Safety'}`);
  console.log(`  ${'─'.repeat(5)} ${'─'.repeat(22)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(3)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(14)}`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];

    // Safety verdict
    let safety: string;
    if (r.maxDrawdownPct > 40) safety = 'RECKLESS';
    else if (r.maxDrawdownPct > 25) safety = 'AGGRESSIVE';
    else if (r.maxDrawdownPct > 15) safety = 'MODERATE';
    else if (r.maxDrawdownPct > 8) safety = 'SAFE';
    else safety = 'CONSERVATIVE';

    // Mark the sweet spot
    const marker = r.maxDrawdownPct <= 25 && r.quartersPositive >= 3 && r.roi > 60 ? ' <<<' : '';

    const kellyLabel = `${(r.kellyMult * 0.5).toFixed(1)}K`; // translate back: mult 1.0 = 0.5K (half-Kelly), mult 2.0 = 1.0K (full Kelly)

    console.log(
      `  ${`#${i + 1}`.padEnd(5)} ${r.label.padEnd(22)} ${String(r.stratCount).padStart(6)} ` +
      `${kellyLabel.padStart(6)} ${`${(r.deployCap * 100).toFixed(0)}%`.padStart(5)} ` +
      `${`${r.roi.toFixed(1)}%`.padStart(8)} ${`+${r.pnl.toFixed(2)}`.padStart(10)} ` +
      `${r.finalEquity.toFixed(2).padStart(10)} ${r.maxDrawdown.toFixed(2).padStart(8)} ` +
      `${`${r.maxDrawdownPct.toFixed(1)}%`.padStart(6)} ${String(r.totalTrades).padStart(7)} ` +
      `${r.maxDeployed.toFixed(2).padStart(8)} ${`${r.quartersPositive}/4`.padStart(3)} ` +
      `${(r.q1Pnl >= 0 ? '+' : '') + r.q1Pnl.toFixed(2)}`.padStart(8) + ` ` +
      `${(r.q2Pnl >= 0 ? '+' : '') + r.q2Pnl.toFixed(2)}`.padStart(8) + ` ` +
      `${(r.q3Pnl >= 0 ? '+' : '') + r.q3Pnl.toFixed(2)}`.padStart(8) + ` ` +
      `${(r.q4Pnl >= 0 ? '+' : '') + r.q4Pnl.toFixed(2)}`.padStart(8) + ` ` +
      `${safety}${marker}`
    );
  }

  // ── Highlight the sweet spot ──
  console.log(`\n${'═'.repeat(140)}`);
  console.log(`  SWEET SPOT — Best ROI with MaxDD ≤ 25% and ≥ 3/4 quarters positive`);
  console.log(`${'═'.repeat(140)}`);

  const sweetSpot = results.filter(r => r.maxDrawdownPct <= 25 && r.quartersPositive >= 3);
  sweetSpot.sort((a, b) => b.roi - a.roi);

  if (sweetSpot.length > 0) {
    const best = sweetSpot[0];
    console.log(`\n  WINNER: ${best.label}`);
    console.log(`    ${best.stratCount} strategies | ${(best.kellyMult * 0.5).toFixed(1)}x Kelly | ${(best.deployCap * 100).toFixed(0)}% deploy cap`);
    console.log(`    ROI:          ${best.roi.toFixed(1)}%`);
    console.log(`    P&L:          +${best.pnl.toFixed(2)} SOL`);
    console.log(`    Final equity: ${best.finalEquity.toFixed(2)} SOL`);
    console.log(`    Max drawdown: ${best.maxDrawdown.toFixed(2)} SOL (${best.maxDrawdownPct.toFixed(1)}% from peak)`);
    console.log(`    Trades:       ${best.totalTrades}`);
    console.log(`    Quarters:     ${best.quartersPositive}/4 positive (Q1:${best.q1Pnl >= 0 ? '+' : ''}${best.q1Pnl.toFixed(2)} Q2:${best.q2Pnl >= 0 ? '+' : ''}${best.q2Pnl.toFixed(2)} Q3:${best.q3Pnl >= 0 ? '+' : ''}${best.q3Pnl.toFixed(2)} Q4:${best.q4Pnl >= 0 ? '+' : ''}${best.q4Pnl.toFixed(2)})`);
    console.log(`    Max deployed: ${best.maxDeployed.toFixed(2)} SOL (${(best.maxDeployed / startingBankroll * 100).toFixed(0)}% of bankroll)`);

    // Show top 5
    if (sweetSpot.length > 1) {
      console.log(`\n  Runner-ups:`);
      for (let i = 1; i < Math.min(5, sweetSpot.length); i++) {
        const r = sweetSpot[i];
        console.log(`    ${i + 1}. ${r.label} — ${r.roi.toFixed(1)}% ROI, DD ${r.maxDrawdownPct.toFixed(1)}%, ${r.quartersPositive}/4 Q+`);
      }
    }
  }

  // ── Risk frontier ──
  console.log(`\n${'═'.repeat(140)}`);
  console.log(`  RISK FRONTIER — Best ROI at each drawdown tier`);
  console.log(`${'═'.repeat(140)}`);

  const tiers = [
    { label: 'Conservative (DD ≤ 10%)', maxDD: 10 },
    { label: 'Moderate (DD ≤ 15%)',     maxDD: 15 },
    { label: 'Safe-Aggressive (DD ≤ 20%)', maxDD: 20 },
    { label: 'Aggressive (DD ≤ 25%)',   maxDD: 25 },
    { label: 'High Risk (DD ≤ 35%)',    maxDD: 35 },
    { label: 'YOLO (DD ≤ 50%)',         maxDD: 50 },
  ];

  for (const tier of tiers) {
    const candidates = results.filter(r => r.maxDrawdownPct <= tier.maxDD && r.quartersPositive >= 3);
    candidates.sort((a, b) => b.roi - a.roi);
    if (candidates.length > 0) {
      const best = candidates[0];
      console.log(`\n  ${tier.label}:`);
      console.log(`    ${best.label} — ${best.roi.toFixed(1)}% ROI | +${best.pnl.toFixed(2)} SOL | DD ${best.maxDrawdownPct.toFixed(1)}% | ${best.quartersPositive}/4 Q+`);
    } else {
      console.log(`\n  ${tier.label}: no qualifying config`);
    }
  }

  console.log('\n');
}

main();
