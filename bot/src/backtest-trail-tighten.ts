/**
 * Trail tightening sweep — test progressive trailing stops that lock profits.
 *
 * Current: fixed trail = 0.8 × scaledATR (~0.43% from best price), never changes.
 * Problem: a trade that's up +2% uses the same wide trail as one that just entered.
 *
 * Tests several tightening approaches:
 *   A) Linear: trail shrinks linearly as profit grows
 *   B) Profit-lock: never give back more than X% of peak profit
 *   C) Stepped: discrete tightening at profit milestones
 *   D) Hybrid: max(ATR trail, profit lock) — tighter of the two always wins
 *
 * Usage: cd bot && npx tsx src/backtest-trail-tighten.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import { STRATEGIES } from './strategies.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';

const DATA_PATH = resolve('data/history-180d.jsonl');
const BALANCE_USDC = 27.51;
const SOL_PRICE_APPROX = 140;
const BALANCE_SOL = BALANCE_USDC / SOL_PRICE_APPROX;
const LEVERAGE = 10;
const HARD_SL_PCT = 2.0;

function loadTicks(): Tick[] {
  const raw = readFileSync(DATA_PATH, 'utf-8');
  const ticks: Tick[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      ticks.push({ feedId: o.feedId, price: o.price, publishTime: o.publishTime });
    } catch {}
  }
  ticks.sort((a, b) => a.publishTime - b.publishTime);
  return ticks;
}

type TightenMode =
  | { type: 'none' }                                            // current behavior
  | { type: 'linear'; tightenRate: number; minFraction: number } // trail × max(minFrac, 1 - profit% × rate)
  | { type: 'lock'; lockPct: number }                            // never give back more than lockPct% of profit
  | { type: 'stepped'; steps: { profitPct: number; trailFraction: number }[] }
  | { type: 'hybrid'; lockPct: number };                         // min(atr trail, profit lock)

function computeTrailPct(
  baseTrailPct: number,
  profitPct: number,
  mode: TightenMode,
): number {
  switch (mode.type) {
    case 'none':
      return baseTrailPct;

    case 'linear': {
      // Trail shrinks linearly with profit. At 0% profit → full trail.
      // tightenRate=0.5 means at +2% profit, trail = base × max(minFrac, 1 - 2×0.5) = base × minFrac
      const factor = Math.max(mode.minFraction, 1 - profitPct * mode.tightenRate);
      return baseTrailPct * factor;
    }

    case 'lock': {
      // Never give back more than lockPct% of unrealized profit
      // e.g. lockPct=50: if up +2%, max giveback = 1%, so trail = min(baseTrail, 1%)
      if (profitPct <= 0) return baseTrailPct;
      const maxGiveback = profitPct * (mode.lockPct / 100);
      return Math.min(baseTrailPct, maxGiveback);
    }

    case 'stepped': {
      // Discrete steps: tighter trail at higher profit levels
      let fraction = 1.0;
      for (const step of mode.steps) {
        if (profitPct >= step.profitPct) fraction = step.trailFraction;
      }
      return baseTrailPct * fraction;
    }

    case 'hybrid': {
      // Tighter of: ATR trail OR profit lock
      if (profitPct <= 0) return baseTrailPct;
      const maxGiveback = profitPct * (mode.lockPct / 100);
      return Math.min(baseTrailPct, maxGiveback);
    }
  }
}

interface RunResult {
  trades: number; wins: number; losses: number; winRate: number;
  roi: number; pf: number; sharpe: number; maxDd: number;
  avgHoldSec: number; trailExits: number; slExits: number;
}

function run(mode: TightenMode, ticks: Tick[]): RunResult {
  const rBase = STRATEGIES.find(s => s.name === 'R-base')!;
  const config = { ...rBase } as any;

  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: BALANCE_SOL });
  const strategy = new RegimeStrategy(config);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  let trailExits = 0;
  let slExits = 0;
  let totalHoldSec = 0;

  (strategy as any).enter = function (dir: any, price: number, now: number, regime: any, fee: number) {
    const bet = this.getBetSize(); if (bet <= 0) return;
    this.entryPrice = price; this.entryDirection = dir; this.entryTickTime = now;
    this.entryRegime = regime; this.bestPriceSinceEntry = price;
    this.entryRollingMean = this.rollingMean;
    this.entryScaledAtr = this.scaledAtr(this.config.meanWindowSeconds / 60);
    this.lastTrailCheckTime = now;
    this.bankroll?.reserveCapital(bet);
    this.paper.openPaper(dir, price, bet * LEVERAGE, fee, now);
    this.paper.saveEntryRegime(regime);
  };

  (strategy as any).exit = function (price: number, now: number, fee: number, reason: string) {
    if (!this.paper.inPosition) return;
    const trade = this.paper.closePaper(price, fee, now); if (!trade) return;
    this.bankroll?.releaseCapital(trade.sizeSol / LEVERAGE);
    this.bankroll?.recordPnl(trade.netPnlSol);
    totalHoldSec += now - this.entryTickTime;
    if (reason === 'trail') trailExits++;
    if (reason === 'SL') slExits++;
    this.lastTradeInfo = { direction: trade.direction, entryPrice: trade.entryPrice, exitPrice: trade.exitPrice, holdSec: now - this.entryTickTime, netPnl: trade.netPnlSol, reason, atrAtExit: this.atrPct, trailPctAtExit: 0 };
  };

  (strategy as any).checkTrendExit = function (price: number, now: number) {
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;

    // Hard SL — always active
    if (favorable <= -HARD_SL_PCT) { this.exit(price, now, 2 / 10_000, 'SL'); return; }

    const holdTime = now - this.entryTickTime;
    if (holdTime < this.config.trailDelaySeconds) {
      if (now - this.lastTrailCheckTime >= 60) { this.trackBestPrice(price); this.lastTrailCheckTime = now; }
      return;
    }
    if (now - this.lastTrailCheckTime < 60) return;
    this.lastTrailCheckTime = now;
    this.trackBestPrice(price);

    // Compute base ATR trail
    const stopAtr = this.scaledAtr(this.config.regimeWindowSeconds / 60);
    const baseTrailPct = this.config.trailingAtrMultiple * stopAtr;

    // Compute current profit from entry
    const profitFromEntry = this.entryDirection === 'long'
      ? ((this.bestPriceSinceEntry / this.entryPrice) - 1) * 100
      : ((this.entryPrice / this.bestPriceSinceEntry) - 1) * 100;

    // Apply tightening
    const trailPct = computeTrailPct(baseTrailPct, profitFromEntry, mode);

    // Check trail trigger
    if (this.entryDirection === 'long') {
      if (((this.bestPriceSinceEntry - price) / this.bestPriceSinceEntry) * 100 >= trailPct)
        this.exit(price, now, 2 / 10_000, 'trail');
    } else {
      if (((price - this.bestPriceSinceEntry) / this.bestPriceSinceEntry) * 100 >= trailPct)
        this.exit(price, now, 2 / 10_000, 'trail');
    }
  };

  const origLog = console.log; console.log = () => {};
  let peak = BALANCE_SOL, maxDd = 0, lastSnap = 0;
  for (const tick of ticks) {
    bankroll.updateSolPrice(tick.price);
    strategy.onTick(tick);
    if (tick.publishTime - lastSnap >= 60) {
      const eq = bankroll.getEquity();
      if (eq > peak) peak = eq;
      const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
      if (dd > maxDd) maxDd = dd;
      lastSnap = tick.publishTime;
    }
  }
  console.log = origLog;

  const m = strategy.getMetrics();
  const eq = bankroll.getEquity();
  const roi = ((eq / BALANCE_SOL) - 1) * 100;
  strategy.stop();

  return {
    trades: m.totalTrades, wins: m.wins, losses: m.losses, winRate: m.winRate,
    roi, pf: m.profitFactor, sharpe: m.sharpe, maxDd,
    avgHoldSec: m.totalTrades > 0 ? totalHoldSec / m.totalTrades : 0,
    trailExits, slExits,
  };
}

function main(): void {
  console.log('Loading data...');
  const allTicks = loadTicks();
  const lastTs = allTicks[allTicks.length - 1].publishTime;

  const configs: { label: string; mode: TightenMode }[] = [];

  // ── Baseline: no tightening (current behavior) ──
  configs.push({ label: 'NONE (current)', mode: { type: 'none' } });

  // ── Linear tightening: trail × max(minFrac, 1 - profit% × rate) ──
  // tightenRate=0.2 → at +2% profit, trail = base × 0.6
  // tightenRate=0.5 → at +2% profit, trail = base × minFrac (fully tight)
  for (const rate of [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]) {
    for (const minFrac of [0.1, 0.2, 0.3, 0.5]) {
      configs.push({
        label: `LINEAR rate=${rate} min=${minFrac}`,
        mode: { type: 'linear', tightenRate: rate, minFraction: minFrac },
      });
    }
  }

  // ── Profit-lock: never give back more than X% of profit ──
  // lockPct=50 → if up +2%, trail capped at 1% (keep at least 50% of profit)
  for (const lockPct of [30, 40, 50, 60, 70, 80, 90]) {
    configs.push({
      label: `LOCK ${lockPct}%`,
      mode: { type: 'lock', lockPct },
    });
  }

  // ── Stepped: discrete trail fractions at profit milestones ──
  configs.push({
    label: 'STEP conservative',
    mode: { type: 'stepped', steps: [
      { profitPct: 0.5, trailFraction: 0.80 },
      { profitPct: 1.0, trailFraction: 0.60 },
      { profitPct: 2.0, trailFraction: 0.40 },
    ]},
  });
  configs.push({
    label: 'STEP aggressive',
    mode: { type: 'stepped', steps: [
      { profitPct: 0.3, trailFraction: 0.70 },
      { profitPct: 0.8, trailFraction: 0.40 },
      { profitPct: 1.5, trailFraction: 0.20 },
    ]},
  });
  configs.push({
    label: 'STEP moderate',
    mode: { type: 'stepped', steps: [
      { profitPct: 0.5, trailFraction: 0.75 },
      { profitPct: 1.0, trailFraction: 0.50 },
      { profitPct: 1.5, trailFraction: 0.35 },
      { profitPct: 2.5, trailFraction: 0.20 },
    ]},
  });
  configs.push({
    label: 'STEP late-lock',
    mode: { type: 'stepped', steps: [
      { profitPct: 1.0, trailFraction: 0.80 },
      { profitPct: 2.0, trailFraction: 0.50 },
      { profitPct: 3.0, trailFraction: 0.25 },
    ]},
  });

  // ── Hybrid: tighter of ATR trail OR profit lock ──
  for (const lockPct of [30, 40, 50, 60, 70, 80]) {
    configs.push({
      label: `HYBRID lock=${lockPct}%`,
      mode: { type: 'hybrid', lockPct },
    });
  }

  console.log(`Testing ${configs.length} trail tightening configs\n`);

  const windows = [90, 180];
  const results: {
    label: string; mode: TightenMode;
    r90: RunResult; r180: RunResult;
    avgRoi: number; avgSharpe: number;
  }[] = [];

  const t0 = Date.now();
  for (const cfg of configs) {
    const startTs90 = lastTs - (90 * 24 * 3600);
    const ticks90 = allTicks.filter(t => t.publishTime >= startTs90);
    const r90 = run(cfg.mode, ticks90);

    const startTs180 = lastTs - (180 * 24 * 3600);
    const ticks180 = allTicks.filter(t => t.publishTime >= startTs180);
    const r180 = run(cfg.mode, ticks180);

    results.push({
      label: cfg.label, mode: cfg.mode,
      r90, r180,
      avgRoi: (r90.roi + r180.roi) / 2,
      avgSharpe: (r90.sharpe + r180.sharpe) / 2,
    });
  }

  // Sort by composite score
  results.sort((a, b) => {
    const scoreA = a.avgRoi * 0.50 + a.avgSharpe * 200 * 0.25 + (a.r180.maxDd > 30 ? -(a.r180.maxDd - 30) * 2 * 0.15 : 0) + (a.r180.trades >= 50 ? 0.5 : -1) * 0.10;
    const scoreB = b.avgRoi * 0.50 + b.avgSharpe * 200 * 0.25 + (b.r180.maxDd > 30 ? -(b.r180.maxDd - 30) * 2 * 0.15 : 0) + (b.r180.trades >= 50 ? 0.5 : -1) * 0.10;
    return scoreB - scoreA;
  });

  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // ── Print all results ──
  console.log('ALL TRAIL TIGHTENING RESULTS (sorted by composite score):');
  console.log('  #  Config                       | 90d ROI  90d Shp  Trades | 180d ROI  180d Shp  MaxDD  Trades  Trail/SL      AvgHold | Avg ROI');
  console.log('  ' + '─'.repeat(140));

  for (let i = 0; i < results.length; i++) {
    const { label, r90, r180, avgRoi } = results[i];
    const holdMin = (r180.avgHoldSec / 60).toFixed(0);
    console.log(
      `  ${String(i + 1).padStart(3)}  ${label.padEnd(27)} | ` +
      `${(r90.roi >= 0 ? '+' : '') + r90.roi.toFixed(1) + '%'}`.padStart(8) + `  ` +
      `${r90.sharpe.toFixed(3)}`.padStart(7) + `  ` +
      `${String(r90.trades).padStart(5)}  | ` +
      `${(r180.roi >= 0 ? '+' : '') + r180.roi.toFixed(1) + '%'}`.padStart(9) + `  ` +
      `${r180.sharpe.toFixed(3)}`.padStart(8) + `  ` +
      `${r180.maxDd.toFixed(1) + '%'}`.padStart(6) + `  ` +
      `${String(r180.trades).padStart(5)}  ` +
      `${r180.trailExits}/${r180.slExits}`.padStart(8) + `  ` +
      `${holdMin}m`.padStart(8) + ` | ` +
      `${(avgRoi >= 0 ? '+' : '') + avgRoi.toFixed(1) + '%'}`.padStart(8)
    );
  }

  // Find where baseline ranks
  const baseIdx = results.findIndex(r => r.label === 'NONE (current)');
  console.log(`\n  Baseline "NONE (current)" is rank #${baseIdx + 1} of ${results.length}`);

  // Show top 5 by type
  console.log('\n  Best per approach type:');
  for (const type of ['none', 'linear', 'lock', 'stepped', 'hybrid'] as const) {
    const best = results.find(r => r.mode.type === type);
    if (best) {
      const rank = results.indexOf(best) + 1;
      console.log(`    ${type.padEnd(8)} → #${rank} ${best.label} (avg ROI: ${best.avgRoi >= 0 ? '+' : ''}${best.avgRoi.toFixed(1)}%)`);
    }
  }
}

main();
