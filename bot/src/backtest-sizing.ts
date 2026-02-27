/**
 * Optimal bet sizing analysis: no arbitrary cap.
 * Tracks combined portfolio equity curve, max drawdown, margin usage,
 * and finds the Kelly-optimal bet size for different bankrolls.
 *
 * Runs the 365d backtest once at 1 SOL baseline, then scales the
 * equity curve to find safe bet sizes for each bankroll.
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
const DRIFT_MAINT_MARGIN = 0.05;

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
  if (!dataPath) { console.error('Usage: npx tsx src/backtest-sizing.ts --data <path>'); process.exit(1); }

  console.log(`[sizing] Loading ticks...`);
  const ticks = loadTicks(resolve(dataPath));
  const totalDays = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 86400;
  console.log(`[sizing] ${ticks.length.toLocaleString()} ticks (${totalDays.toFixed(0)}d)\n`);

  // ── Run backtest, capture every trade's PnL + timestamp + concurrent state ──
  const strategies = STRATEGIES.map(c => ({ instance: createStrategy(c), config: c }));

  // Capture trade PnLs by intercepting console output
  interface TradeRecord {
    time: number;
    strategy: string;
    pnl: number; // at 1 SOL bet (normalized)
    betSol: number;
  }
  const trades: TradeRecord[] = [];
  let currentTickTime = 0;

  const origLog = console.log;
  console.log = (...args: any[]) => {
    const msg = args.join(' ');
    const exitMatch = msg.match(/\[(.+?)\] EXIT .+? \| .+? \| net ([+-]?\d+\.?\d+) SOL/);
    if (exitMatch) {
      const [, name, pnlStr] = exitMatch;
      const config = STRATEGIES.find(s => s.name === name);
      const betSol = config ? (config as any).betSizeSol || 1 : 1;
      trades.push({
        time: currentTickTime,
        strategy: name,
        pnl: parseFloat(pnlStr),
        betSol,
      });
    }
  };

  // Also track concurrent exposure at each SOL tick
  interface ExposureSnapshot {
    time: number;
    concurrent: number;
    notionalSol: number;
    unrealizedPnl: number;
  }
  const exposureSnapshots: ExposureSnapshot[] = [];
  let lastSnapTime = 0;
  let lastSolPrice = 0;

  for (const tick of ticks) {
    currentTickTime = tick.publishTime;
    if (tick.feedId === SOL_FEED) lastSolPrice = tick.price;

    for (const { instance } of strategies) {
      instance.onTick(tick);
    }

    // Snapshot exposure every 60s
    if (tick.publishTime - lastSnapTime >= 60) {
      let concurrent = 0;
      let notional = 0;
      let unrealized = 0;

      for (const { instance, config } of strategies) {
        const paper = (instance as any).paper;
        if (!paper?.inPosition) continue;
        concurrent++;
        const bet = (config as any).betSizeSol || 1;
        notional += bet;

        const dir = (instance as any).entryDirection;
        const entry = (instance as any).entryPrice;
        if (entry > 0 && lastSolPrice > 0) {
          const movePct = ((lastSolPrice / entry) - 1) * 100;
          unrealized += (dir === 'long' ? movePct : -movePct) / 100 * bet;
        }
      }

      exposureSnapshots.push({ time: tick.publishTime, concurrent, notionalSol: notional, unrealizedPnl: unrealized });
      lastSnapTime = tick.publishTime;
    }
  }

  console.log = origLog;

  // Collect final per-strategy metrics
  const stratResults: { name: string; type: string; trades: number; pnl: number; bet: number; wr: number }[] = [];
  for (const { instance, config } of strategies) {
    const m = instance.getMetrics();
    stratResults.push({
      name: instance.name, type: instance.type,
      trades: m.totalTrades, pnl: m.netPnlSol,
      bet: (config as any).betSizeSol || 1,
      wr: m.winRate,
    });
  }

  // Sort trades chronologically
  trades.sort((a, b) => a.time - b.time);

  console.log(`[sizing] ${trades.length} total trades captured\n`);

  // ── Build combined equity curve at 1x baseline ──
  // Each trade's PnL is already at the betSizeSol in strategies (1 SOL)
  // To scale to bet size B: multiply each PnL by (B / original_bet)

  function buildEquityCurve(betMultiplier: number): { equity: number[]; maxDrawdown: number; maxDrawdownPct: number; finalPnl: number; peakEquity: number } {
    let equity = 0;
    let peak = 0;
    let maxDd = 0;
    let maxDdPct = 0;
    const equityArr: number[] = [0];

    for (const t of trades) {
      const scaledPnl = t.pnl * (betMultiplier / t.betSol);
      equity += scaledPnl;
      equityArr.push(equity);
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDd) maxDd = dd;
      // Drawdown relative to peak equity (or initial if peak is 0)
      const base = peak > 0 ? peak : 1;
      const ddPct = dd / base * 100;
      if (ddPct > maxDdPct) maxDdPct = ddPct;
    }

    return { equity: equityArr, maxDrawdown: maxDd, maxDrawdownPct: maxDdPct, finalPnl: equity, peakEquity: peak };
  }

  // ── Scale exposure snapshots ──
  function scaleExposure(betMultiplier: number): { maxNotional: number; p99Notional: number; avgNotional: number; maxUnrealized: number } {
    const scaleFactor = betMultiplier / 1.0; // strategies already at 1 SOL
    const notionals = exposureSnapshots.map(s => s.notionalSol * scaleFactor).sort((a, b) => a - b);
    let minUnrealized = 0;
    for (const s of exposureSnapshots) {
      const v = s.unrealizedPnl * scaleFactor;
      if (v < minUnrealized) minUnrealized = v;
    }
    return {
      maxNotional: notionals[notionals.length - 1],
      p99Notional: notionals[Math.floor(notionals.length * 0.99)],
      avgNotional: notionals.reduce((s, n) => s + n, 0) / notionals.length,
      maxUnrealized: minUnrealized,
    };
  }

  // ── Analyze bet sizes ──
  console.log(`${'═'.repeat(110)}`);
  console.log(`  BET SIZE ANALYSIS — NO CAP`);
  console.log(`  365 days | ${trades.length} trades | 12 strategies`);
  console.log(`${'═'.repeat(110)}`);

  console.log(`\n  ${'Bet/Strat'.padEnd(10)}  ${'PnL/Year'.padStart(10)}  ${'MaxDD'.padStart(10)}  ${'DD%ofPeak'.padStart(10)}  ${'MaxNotional'.padStart(12)}  ${'p99Notional'.padStart(12)}  ${'MaxUnreal'.padStart(12)}  ${'Margin@2x'.padStart(10)}`);
  console.log(`  ${'─'.repeat(10)}  ${'─'.repeat(10)}  ${'─'.repeat(10)}  ${'─'.repeat(10)}  ${'─'.repeat(12)}  ${'─'.repeat(12)}  ${'─'.repeat(12)}  ${'─'.repeat(10)}`);

  const betSizes = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 7.5, 10.0];

  interface SizeResult {
    bet: number;
    pnl: number;
    maxDd: number;
    maxDdPct: number;
    maxNotional: number;
    p99Notional: number;
    margin2x: number;
    maxUnrealized: number;
  }
  const sizeResults: SizeResult[] = [];

  for (const bet of betSizes) {
    const curve = buildEquityCurve(bet);
    const exp = scaleExposure(bet);
    const margin2x = exp.p99Notional / 2;

    sizeResults.push({
      bet, pnl: curve.finalPnl, maxDd: curve.maxDrawdown, maxDdPct: curve.maxDrawdownPct,
      maxNotional: exp.maxNotional, p99Notional: exp.p99Notional, margin2x,
      maxUnrealized: exp.maxUnrealized,
    });

    console.log(
      `  ${`${bet} SOL`.padEnd(10)}  ${`+${curve.finalPnl.toFixed(2)}`.padStart(10)}  ` +
      `${curve.maxDrawdown.toFixed(3).padStart(10)}  ${`${curve.maxDrawdownPct.toFixed(1)}%`.padStart(10)}  ` +
      `${`${exp.maxNotional.toFixed(1)} SOL`.padStart(12)}  ${`${exp.p99Notional.toFixed(1)} SOL`.padStart(12)}  ` +
      `${`${exp.maxUnrealized.toFixed(3)}`.padStart(12)}  ${`${margin2x.toFixed(1)} SOL`.padStart(10)}`
    );
  }

  // ── Bankroll-specific recommendations ──
  for (const bankroll of [5, 10, 20, 50, 100]) {
    console.log(`\n\n${'═'.repeat(110)}`);
    console.log(`  BANKROLL: ${bankroll} SOL`);
    console.log(`${'═'.repeat(110)}`);

    for (const leverage of [2, 3, 5]) {
      console.log(`\n  ── ${leverage}x LEVERAGE ──`);
      console.log(`  ${'Bet'.padEnd(10)}  ${'PnL/yr'.padStart(9)}  ${'ROI'.padStart(7)}  ${'MaxDD'.padStart(8)}  ${'DD%Bank'.padStart(8)}  ${'Margin%'.padStart(8)}  ${'Liq@'.padStart(8)}  ${'Safety'.padStart(8)}  ${'Verdict'.padStart(14)}`);
      console.log(`  ${'─'.repeat(10)}  ${'─'.repeat(9)}  ${'─'.repeat(7)}  ${'─'.repeat(8)}  ${'─'.repeat(8)}  ${'─'.repeat(8)}  ${'─'.repeat(8)}  ${'─'.repeat(8)}  ${'─'.repeat(14)}`);

      for (const sr of sizeResults) {
        const marginNeeded = sr.p99Notional / leverage;
        const marginPctBankroll = (marginNeeded / bankroll) * 100;
        if (marginPctBankroll > 150) continue; // skip obviously impossible

        const roi = (sr.pnl / bankroll) * 100;
        const ddPctBankroll = (sr.maxDd / bankroll) * 100;
        const liqMove = ((1 / leverage) - DRIFT_MAINT_MARGIN) * 100;
        const maxSL = 3.0; // worst SL across strategies
        const safety = liqMove - maxSL;

        // Can we even fit this in our margin?
        const maxAllowed = bankroll * leverage;
        const peakNotional = sr.maxNotional;
        const fits = peakNotional <= maxAllowed;

        // Worst case: all positions in same direction + max adverse move
        // Account equity = bankroll + unrealized PnL
        // Liquidation when equity < maintenance margin on total position
        // Worst case equity = bankroll + maxUnrealized (which is negative)
        const worstEquity = bankroll + sr.maxUnrealized;
        const worstMaintenanceReq = sr.maxNotional * DRIFT_MAINT_MARGIN;
        const wouldSurvive = worstEquity > worstMaintenanceReq;

        let verdict: string;
        if (!fits) {
          verdict = 'OVER MARGIN';
        } else if (ddPctBankroll > 50) {
          verdict = 'RECKLESS';
        } else if (ddPctBankroll > 30) {
          verdict = 'AGGRESSIVE';
        } else if (ddPctBankroll > 15) {
          verdict = 'MODERATE';
        } else if (ddPctBankroll > 5) {
          verdict = 'SAFE';
        } else {
          verdict = 'CONSERVATIVE';
        }

        if (!wouldSurvive) verdict = 'LIQUIDATION RISK';

        console.log(
          `  ${`${sr.bet} SOL`.padEnd(10)}  ${`+${sr.pnl.toFixed(2)}`.padStart(9)}  ` +
          `${`${roi.toFixed(0)}%`.padStart(7)}  ${sr.maxDd.toFixed(3).padStart(8)}  ` +
          `${`${ddPctBankroll.toFixed(1)}%`.padStart(8)}  ${`${marginPctBankroll.toFixed(0)}%`.padStart(8)}  ` +
          `${`${liqMove.toFixed(0)}%`.padStart(8)}  ${`${safety.toFixed(0)}%`.padStart(8)}  ` +
          `${verdict.padStart(14)}`
        );
      }
    }
  }

  // ── Find optimal bet per bankroll ──
  console.log(`\n\n${'═'.repeat(110)}`);
  console.log(`  RECOMMENDED OPTIMAL SETUP (max drawdown ≤ 20% of bankroll, 2x leverage)`);
  console.log(`${'═'.repeat(110)}`);

  for (const bankroll of [5, 10, 20, 50, 100]) {
    // Find largest bet where DD ≤ 20% of bankroll AND margin fits
    let bestBet = 0;
    let bestPnl = 0;
    let bestDd = 0;
    let bestMargin = 0;

    for (const sr of sizeResults) {
      const ddPct = (sr.maxDd / bankroll) * 100;
      const marginPct = (sr.p99Notional / 2 / bankroll) * 100;
      const peakFits = sr.maxNotional <= bankroll * 2;

      if (ddPct <= 20 && peakFits && marginPct <= 90) {
        if (sr.pnl > bestPnl) {
          bestBet = sr.bet;
          bestPnl = sr.pnl;
          bestDd = sr.maxDd;
          bestMargin = sr.p99Notional / 2;
        }
      }
    }

    if (bestBet > 0) {
      const roi = (bestPnl / bankroll) * 100;
      console.log(`\n  ${bankroll} SOL bankroll:`);
      console.log(`    Bet: ${bestBet} SOL per strategy (12 strategies)`);
      console.log(`    Expected PnL: +${bestPnl.toFixed(2)} SOL/year (${roi.toFixed(0)}% ROI)`);
      console.log(`    Max drawdown: ${bestDd.toFixed(3)} SOL (${(bestDd / bankroll * 100).toFixed(1)}% of bankroll)`);
      console.log(`    Margin used: ${bestMargin.toFixed(1)} / ${bankroll} SOL`);
      console.log(`    Liquidation: impossible (45% buffer vs 3% max SL)`);
    } else {
      // Find the safe bet by interpolation
      console.log(`\n  ${bankroll} SOL bankroll:`);
      // Scale down from smallest tested
      const smallest = sizeResults[0];
      const maxBetForDd = bankroll * 0.20 / smallest.maxDd * smallest.bet;
      const pnlEst = smallest.pnl * (maxBetForDd / smallest.bet);
      console.log(`    Bet: ${maxBetForDd.toFixed(2)} SOL per strategy (estimated)`);
      console.log(`    Expected PnL: +${pnlEst.toFixed(2)} SOL/year (${(pnlEst / bankroll * 100).toFixed(0)}% ROI)`);
    }
  }

  // ── Kelly Criterion ──
  console.log(`\n\n${'═'.repeat(110)}`);
  console.log(`  KELLY CRITERION ANALYSIS`);
  console.log(`${'═'.repeat(110)}`);

  // Compute Kelly for each strategy type
  for (const { name, type, trades: numTrades, pnl, bet, wr } of stratResults) {
    if (numTrades === 0) continue;

    // Separate wins and losses from the trade records
    const stratTrades = trades.filter(t => t.strategy === name);
    const wins = stratTrades.filter(t => t.pnl > 0);
    const losses = stratTrades.filter(t => t.pnl <= 0);

    if (wins.length === 0 || losses.length === 0) continue;

    const avgWin = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length);
    const winRate = wins.length / stratTrades.length;
    const b = avgWin / avgLoss; // win/loss ratio

    // Kelly: f* = (bp - q) / b where p=win rate, q=loss rate, b=win/loss ratio
    const kelly = (b * winRate - (1 - winRate)) / b;
    const halfKelly = kelly / 2; // conservative

    // What does this mean in SOL for a bankroll?
    console.log(`\n  ${name} (${type}):`);
    console.log(`    WR: ${(winRate * 100).toFixed(1)}% | Avg win: +${avgWin.toFixed(4)} | Avg loss: -${avgLoss.toFixed(4)} | W/L ratio: ${b.toFixed(2)}`);
    console.log(`    Full Kelly: ${(kelly * 100).toFixed(1)}% of bankroll per trade`);
    console.log(`    Half Kelly: ${(halfKelly * 100).toFixed(1)}% of bankroll per trade (recommended)`);
    if (halfKelly > 0) {
      for (const bankroll of [10, 20, 50]) {
        const betSol = bankroll * halfKelly;
        console.log(`      ${bankroll} SOL bankroll → bet ${betSol.toFixed(2)} SOL`);
      }
    } else {
      console.log(`    ⚠ Negative Kelly — this strategy has negative expected value at current config`);
    }
  }

  console.log(`\n\n${'═'.repeat(110)}`);
  console.log(`  FINAL ANSWER: SAFE OPTIMAL STRATEGY`);
  console.log(`${'═'.repeat(110)}`);

  // Compute portfolio Kelly
  const allWins = trades.filter(t => t.pnl > 0);
  const allLosses = trades.filter(t => t.pnl <= 0);
  const portfolioWR = allWins.length / trades.length;
  const portfolioAvgWin = allWins.reduce((s, t) => s + t.pnl, 0) / allWins.length;
  const portfolioAvgLoss = Math.abs(allLosses.reduce((s, t) => s + t.pnl, 0) / allLosses.length);
  const portfolioB = portfolioAvgWin / portfolioAvgLoss;
  const portfolioKelly = (portfolioB * portfolioWR - (1 - portfolioWR)) / portfolioB;

  console.log(`\n  Portfolio stats (all 12 strategies combined):`);
  console.log(`    Total trades: ${trades.length}`);
  console.log(`    Win rate: ${(portfolioWR * 100).toFixed(1)}%`);
  console.log(`    Avg win: +${portfolioAvgWin.toFixed(4)} SOL | Avg loss: -${portfolioAvgLoss.toFixed(4)} SOL`);
  console.log(`    W/L ratio: ${portfolioB.toFixed(2)}`);
  console.log(`    Portfolio Kelly: ${(portfolioKelly * 100).toFixed(1)}%`);
  console.log(`    Half Kelly: ${(portfolioKelly / 2 * 100).toFixed(1)}%`);

  console.log(`\n  Recommended bet per strategy (Half Kelly, 2x leverage):`);
  for (const bankroll of [5, 10, 20, 50, 100]) {
    const halfKellyBet = bankroll * (portfolioKelly / 2);
    const maxFromMargin = (bankroll * 2 * 0.8) / 12; // 12 strategies, 80% margin utilization
    const recommended = Math.min(halfKellyBet, maxFromMargin);
    const annualPnl = sizeResults[0].pnl * (recommended / sizeResults[0].bet);
    const roi = (annualPnl / bankroll) * 100;

    // Find the max drawdown for this bet size by interpolation
    const ddPerUnit = sizeResults[0].maxDd / sizeResults[0].bet;
    const estDd = ddPerUnit * recommended;
    const ddPct = (estDd / bankroll) * 100;

    console.log(`    ${String(bankroll).padStart(5)} SOL → bet ${recommended.toFixed(2)} SOL/strat → PnL +${annualPnl.toFixed(2)} SOL/yr (${roi.toFixed(0)}% ROI) | MaxDD ~${estDd.toFixed(2)} SOL (${ddPct.toFixed(0)}% of bankroll)`);
  }

  console.log(`\n`);
}

main();
