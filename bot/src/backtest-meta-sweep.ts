/**
 * Meta-parameter sweep: uncertain multiplier, leverage, and Kelly fraction.
 * These are structural params that were hardcoded in previous grid searches.
 *
 * Usage: cd bot && npx tsx src/backtest-meta-sweep.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import { STRATEGIES } from './strategies.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';
import { SOL_FEED_ID } from './feed.js';

const DATA_PATH = resolve('data/history-180d.jsonl');
const BALANCE_USDC = 27.51;

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

interface MetaResult {
  uncertainMult: number;
  leverage: number;
  kelly: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  roi: number;
  pf: number;
  sharpe: number;
  maxDd: number;
  finalEquity: number;
}

function runMeta(
  uncertainMult: number,
  leverage: number,
  kelly: number,
  ticks: Tick[],
  balanceSol: number,
): MetaResult {
  const rBase = STRATEGIES.find(s => s.name === 'R-base')!;
  const config = { ...rBase } as any;

  const bankroll = new BankrollManager({
    mode: 'paper',
    initialEquitySol: balanceSol,
    kellyOverride: kelly,
    maxBetOverride: kelly, // cap = kelly fraction
  });
  const strategy = new RegimeStrategy(config);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  // Patch enter — use custom leverage
  (strategy as any).enter = function (dir: any, price: number, now: number, regime: any, fee: number) {
    const bet = this.getBetSize();
    if (bet <= 0) return;
    this.entryPrice = price; this.entryDirection = dir; this.entryTickTime = now;
    this.entryRegime = regime; this.bestPriceSinceEntry = price;
    this.entryRollingMean = this.rollingMean;
    this.entryScaledAtr = this.scaledAtr(this.config.meanWindowSeconds / 60);
    this.lastTrailCheckTime = now;
    this.bankroll?.reserveCapital(bet);
    this.paper.openPaper(dir, price, bet * leverage, fee, now);
    this.paper.saveEntryRegime(regime);
  };

  // Patch exit — release margin
  (strategy as any).exit = function (price: number, now: number, fee: number, reason: string) {
    if (!this.paper.inPosition) return;
    const trade = this.paper.closePaper(price, fee, now);
    if (!trade) return;
    this.bankroll?.releaseCapital(trade.sizeSol / leverage);
    this.bankroll?.recordPnl(trade.netPnlSol);
    this.lastTradeInfo = {
      direction: trade.direction, entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice, holdSec: now - this.entryTickTime,
      netPnl: trade.netPnlSol, reason, atrAtExit: this.atrPct, trailPctAtExit: 0,
    };
  };

  // Patch checkTrendExit — pure ATR trail + 2% hard SL
  (strategy as any).checkTrendExit = function (price: number, now: number) {
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;
    if (favorable <= -2.0) { this.exit(price, now, 2 / 10_000, 'SL'); return; }
    const holdTime = now - this.entryTickTime;
    if (holdTime < this.config.trailDelaySeconds) {
      if (now - this.lastTrailCheckTime >= 60) { this.trackBestPrice(price); this.lastTrailCheckTime = now; }
      return;
    }
    if (now - this.lastTrailCheckTime < 60) return;
    this.lastTrailCheckTime = now; this.trackBestPrice(price);
    const stopAtr = this.scaledAtr(this.config.regimeWindowSeconds / 60);
    const trailPct = this.config.trailingAtrMultiple * stopAtr;
    if (this.entryDirection === 'long') {
      if (((this.bestPriceSinceEntry - price) / this.bestPriceSinceEntry) * 100 >= trailPct)
        this.exit(price, now, 2 / 10_000, 'trail');
    } else {
      if (((price - this.bestPriceSinceEntry) / this.bestPriceSinceEntry) * 100 >= trailPct)
        this.exit(price, now, 2 / 10_000, 'trail');
    }
  };

  // Patch checkUncertainEntry — use custom uncertain multiplier
  (strategy as any).checkUncertainEntry = function (price: number, now: number) {
    const signalCutoff = now - this.config.signalWindowSeconds;
    let signalOldest: any = null;
    for (const s of this.priceBuffer) {
      if (s.time >= signalCutoff) { signalOldest = s; break; }
    }
    if (!signalOldest) return;

    const signalChange = ((price / signalOldest.price) - 1) * 100;
    const threshold = this.config.signalMultiple * this.scaledAtr(this.config.signalWindowSeconds / 60) * uncertainMult;

    if (signalChange > threshold) {
      this.enter('long', price, now, 'UNCERTAIN', 2 / 10_000);
    } else if (signalChange < -threshold) {
      this.enter('short', price, now, 'UNCERTAIN', 2 / 10_000);
    }
  };

  const origLog = console.log; console.log = () => {};
  let peak = balanceSol, maxDd = 0, lastSnap = 0;
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
  const roi = ((eq / balanceSol) - 1) * 100;
  strategy.stop();

  return {
    uncertainMult, leverage, kelly,
    trades: m.totalTrades, wins: m.wins, losses: m.losses, winRate: m.winRate,
    roi, pf: m.profitFactor, sharpe: m.sharpe, maxDd, finalEquity: eq,
  };
}

function main(): void {
  console.log('Loading data...');
  const allTicks = loadTicks();
  const lastTs = allTicks[allTicks.length - 1].publishTime;

  // Use approximate SOL price for balance conversion
  const solTicks = allTicks.filter(t => t.feedId === SOL_FEED_ID);
  const solEnd = solTicks[solTicks.length - 1]?.price ?? 140;

  // Uncertain multiplier: how much stricter UNCERTAIN entries are vs TRENDING
  const uncertainMults = [1.0, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0];

  // Leverage: how much the position is multiplied
  const leverages = [5, 7, 10, 12, 15, 20];

  // Kelly fraction: % of equity per trade
  const kellys = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50];

  const total = uncertainMults.length * leverages.length * kellys.length;
  console.log(`Testing ${total} combos: ${uncertainMults.length} uncertain × ${leverages.length} leverage × ${kellys.length} kelly`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  //  PART 1: Uncertain multiplier sweep (leverage=10, kelly=30%)
  // ═══════════════════════════════════════════════════════════
  console.log('═══ PART 1: Uncertain Multiplier (leverage=10x, kelly=30%) ═══\n');

  for (const days of [90, 180]) {
    const startTs = lastTs - (days * 24 * 3600);
    const ticks = allTicks.filter(t => t.publishTime >= startTs);
    const balanceSol = BALANCE_USDC / solEnd;

    console.log(`  ── ${days}d ──`);
    console.log('  uncMult  Trades  W/L       WR      ROI%      PF    Sharpe  MaxDD%');
    console.log('  ─────────────────────────────────────────────────────────────────');

    for (const um of uncertainMults) {
      const r = runMeta(um, 10, 0.30, ticks, balanceSol);
      const sign = r.roi >= 0 ? '+' : '';
      const marker = um === 1.5 ? ' ← current' : '';
      console.log(
        `  ${um.toFixed(1).padStart(7)}  ${String(r.trades).padStart(6)}  ` +
        `${(r.wins + '/' + r.losses).padStart(8)}  ` +
        `${(r.winRate.toFixed(1) + '%').padStart(6)}  ` +
        `${(sign + r.roi.toFixed(1) + '%').padStart(8)}  ` +
        `${(r.pf === Infinity ? 'Inf' : r.pf.toFixed(2)).padStart(5)}  ` +
        `${r.sharpe.toFixed(3).padStart(6)}  ` +
        `${(r.maxDd.toFixed(1) + '%').padStart(6)}${marker}`
      );
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════
  //  PART 2: Leverage sweep (uncertain=best from P1, kelly=30%)
  // ═══════════════════════════════════════════════════════════
  console.log('═══ PART 2: Leverage (kelly=30%) ═══');
  console.log('Testing each leverage with the current uncertain mult (1.5)\n');

  for (const days of [90, 180]) {
    const startTs = lastTs - (days * 24 * 3600);
    const ticks = allTicks.filter(t => t.publishTime >= startTs);
    const balanceSol = BALANCE_USDC / solEnd;

    console.log(`  ── ${days}d ──`);
    console.log('  lever  Trades  W/L       WR      ROI%       PF    Sharpe  MaxDD%   Final$');
    console.log('  ──────────────────────────────────────────────────────────────────────────');

    for (const lev of leverages) {
      const r = runMeta(1.5, lev, 0.30, ticks, balanceSol);
      const sign = r.roi >= 0 ? '+' : '';
      const marker = lev === 10 ? ' ← current' : '';
      const finalUsd = r.finalEquity * solEnd;
      console.log(
        `  ${String(lev).padStart(5)}x  ${String(r.trades).padStart(6)}  ` +
        `${(r.wins + '/' + r.losses).padStart(8)}  ` +
        `${(r.winRate.toFixed(1) + '%').padStart(6)}  ` +
        `${(sign + r.roi.toFixed(1) + '%').padStart(9)}  ` +
        `${(r.pf === Infinity ? 'Inf' : r.pf.toFixed(2)).padStart(5)}  ` +
        `${r.sharpe.toFixed(3).padStart(6)}  ` +
        `${(r.maxDd.toFixed(1) + '%').padStart(6)}  ` +
        `$${finalUsd.toFixed(2)}${marker}`
      );
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════
  //  PART 3: Kelly sweep (uncertain=best, leverage=10x)
  // ═══════════════════════════════════════════════════════════
  console.log('═══ PART 3: Kelly Fraction (leverage=10x) ═══\n');

  for (const days of [90, 180]) {
    const startTs = lastTs - (days * 24 * 3600);
    const ticks = allTicks.filter(t => t.publishTime >= startTs);
    const balanceSol = BALANCE_USDC / solEnd;

    console.log(`  ── ${days}d ──`);
    console.log('  kelly%  Trades  W/L       WR      ROI%       PF    Sharpe  MaxDD%   Final$');
    console.log('  ──────────────────────────────────────────────────────────────────────────');

    for (const k of kellys) {
      const r = runMeta(1.5, 10, k, ticks, balanceSol);
      const sign = r.roi >= 0 ? '+' : '';
      const marker = k === 0.30 ? ' ← current' : '';
      const finalUsd = r.finalEquity * solEnd;
      console.log(
        `  ${(k * 100).toFixed(0).padStart(5)}%  ${String(r.trades).padStart(6)}  ` +
        `${(r.wins + '/' + r.losses).padStart(8)}  ` +
        `${(r.winRate.toFixed(1) + '%').padStart(6)}  ` +
        `${(sign + r.roi.toFixed(1) + '%').padStart(9)}  ` +
        `${(r.pf === Infinity ? 'Inf' : r.pf.toFixed(2)).padStart(5)}  ` +
        `${r.sharpe.toFixed(3).padStart(6)}  ` +
        `${(r.maxDd.toFixed(1) + '%').padStart(6)}  ` +
        `$${finalUsd.toFixed(2)}${marker}`
      );
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════
  //  PART 4: Combined cross-search (leverage × kelly × uncertain)
  // ═══════════════════════════════════════════════════════════
  console.log('═══ PART 4: Combined Cross-Search (all 3 params) ═══');
  console.log(`Total: ${total} combos\n`);

  const combinedResults: MetaResult[] = [];
  let count = 0;
  const t0 = Date.now();

  // Use 180d for combined
  const startTs180 = lastTs - (180 * 24 * 3600);
  const ticks180 = allTicks.filter(t => t.publishTime >= startTs180);
  const balanceSol = BALANCE_USDC / solEnd;

  for (const um of uncertainMults) {
    for (const lev of leverages) {
      for (const k of kellys) {
        count++;
        if (count % 50 === 0) process.stdout.write(`  ${count}/${total}...\r`);
        const r = runMeta(um, lev, k, ticks180, balanceSol);
        combinedResults.push(r);
      }
    }
  }

  // Score: balance ROI and risk
  combinedResults.sort((a, b) => {
    // Penalize >40% MaxDD heavily (these are too risky for live)
    const ddPenA = a.maxDd > 40 ? -(a.maxDd - 40) * 3 : a.maxDd > 30 ? -(a.maxDd - 30) : 0;
    const ddPenB = b.maxDd > 40 ? -(b.maxDd - 40) * 3 : b.maxDd > 30 ? -(b.maxDd - 30) : 0;
    const scoreA = a.roi * 0.45 + a.sharpe * 200 * 0.30 + ddPenA * 0.15 + (a.trades >= 50 ? 5 : -10) * 0.10;
    const scoreB = b.roi * 0.45 + b.sharpe * 200 * 0.30 + ddPenB * 0.15 + (b.trades >= 50 ? 5 : -10) * 0.10;
    return scoreB - scoreA;
  });

  console.log(`\n  Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('\n  TOP 30 COMBINED (180d, by composite score):');
  console.log('  #   uncMu  lever  kelly  Trades  W/L       WR       ROI%       PF    Sharpe  MaxDD%   Final$');
  console.log('  ' + '─'.repeat(100));

  for (let i = 0; i < Math.min(30, combinedResults.length); i++) {
    const r = combinedResults[i];
    const sign = r.roi >= 0 ? '+' : '';
    const finalUsd = r.finalEquity * solEnd;
    const marker = (r.uncertainMult === 1.5 && r.leverage === 10 && r.kelly === 0.30) ? ' ← current' : '';
    console.log(
      `  ${String(i+1).padStart(3)}  ` +
      `${r.uncertainMult.toFixed(1).padStart(5)}  ` +
      `${(r.leverage + 'x').padStart(5)}  ` +
      `${(r.kelly * 100).toFixed(0).padStart(4)}%  ` +
      `${String(r.trades).padStart(6)}  ` +
      `${(r.wins + '/' + r.losses).padStart(8)}  ` +
      `${(r.winRate.toFixed(1) + '%').padStart(6)}  ` +
      `${(sign + r.roi.toFixed(1) + '%').padStart(9)}  ` +
      `${(r.pf === Infinity ? 'Inf' : r.pf.toFixed(2)).padStart(5)}  ` +
      `${r.sharpe.toFixed(3).padStart(6)}  ` +
      `${(r.maxDd.toFixed(1) + '%').padStart(6)}  ` +
      `$${finalUsd.toFixed(2)}${marker}`
    );
  }

  // Find where current config ranks
  const currentIdx = combinedResults.findIndex(r =>
    r.uncertainMult === 1.5 && r.leverage === 10 && r.kelly === 0.30
  );
  if (currentIdx >= 0) {
    console.log(`\n  Current config (unc=1.5, lev=10x, kelly=30%) is rank #${currentIdx + 1} of ${total}`);
  }

  const best = combinedResults[0];
  console.log(`\n  OPTIMAL: uncertain=${best.uncertainMult} leverage=${best.leverage}x kelly=${(best.kelly * 100).toFixed(0)}%`);
  console.log(`  ROI: ${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(1)}% | Sharpe: ${best.sharpe.toFixed(3)} | MaxDD: ${best.maxDd.toFixed(1)}% | $${(best.finalEquity * solEnd).toFixed(2)}`);
}

main();
