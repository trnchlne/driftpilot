/**
 * minAtrPct sweep — test from 0 (disabled) to 0.05 using optimal config.
 * This parameter skips entries when volatility is too low to trade profitably.
 *
 * Usage: cd bot && npx tsx src/backtest-minatr-sweep.ts
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
const SOL_PRICE_APPROX = 140;
const BALANCE_SOL = BALANCE_USDC / SOL_PRICE_APPROX;
const LEVERAGE = 10;

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

function runWithMinAtr(minAtrPct: number, ticks: Tick[]): { trades: number; wins: number; losses: number; winRate: number; roi: number; pf: number; sharpe: number; maxDd: number } {
  const rBase = STRATEGIES.find(s => s.name === 'R-base')!;
  const config = {
    ...rBase,
    atrPeriod: 90,
    trailingAtrMultiple: 0.7,
    slAtrMultiple: 1.0,
    signalMultiple: 4.5,
    signalWindowSeconds: 25 * 60,
    trailDelaySeconds: 300,
    cooldownSeconds: 120,
    trendThreshold: 1.2,
    rangeThreshold: 1.0,
    regimeWindowSeconds: 4 * 3600,
    meanWindowSeconds: 60 * 60,
    entryBandMultiple: 2.5,
    reversionSlMultiple: 4.0,
    minAtrPct: minAtrPct > 0 ? minAtrPct : undefined,
  } as any;

  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: BALANCE_SOL });
  const strategy = new RegimeStrategy(config);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  (strategy as any).enter = function (dir: any, price: number, now: number, regime: any, fee: number) {
    const bet = this.getBetSize();
    if (bet <= 0) return;
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
    const trade = this.paper.closePaper(price, fee, now);
    if (!trade) return;
    this.bankroll?.releaseCapital(trade.sizeSol / LEVERAGE);
    this.bankroll?.recordPnl(trade.netPnlSol);
    this.lastTradeInfo = {
      direction: trade.direction, entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice, holdSec: now - this.entryTickTime,
      netPnl: trade.netPnlSol, reason, atrAtExit: this.atrPct, trailPctAtExit: 0,
    };
  };

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
    this.lastTrailCheckTime = now;
    this.trackBestPrice(price);
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

  const origLog = console.log;
  console.log = () => {};

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

  return { trades: m.totalTrades, wins: m.wins, losses: m.losses, winRate: m.winRate, roi, pf: m.profitFactor, sharpe: m.sharpe, maxDd };
}

function main(): void {
  console.log('Loading data...');
  const allTicks = loadTicks();
  const lastTs = allTicks[allTicks.length - 1].publishTime;

  const minAtrValues = [0, 0.005, 0.008, 0.010, 0.012, 0.015, 0.018, 0.020, 0.025, 0.030, 0.035, 0.040, 0.050];
  const windows = [90, 180];

  console.log('minAtrPct Sweep — optimal config, only varying minAtrPct');
  console.log('0 = disabled (no volatility filter)');
  console.log('Current live value: 0.015');
  console.log('');

  for (const days of windows) {
    const startTs = lastTs - (days * 24 * 3600);
    const ticks = allTicks.filter(t => t.publishTime >= startTs);
    const solTicks = ticks.filter(t => t.feedId === SOL_FEED_ID);
    const solStart = solTicks[0]?.price ?? 0;
    const solEnd = solTicks[solTicks.length - 1]?.price ?? 0;

    console.log(`── ${days}d window (SOL $${solStart.toFixed(0)} → $${solEnd.toFixed(0)}) ──`);
    console.log('  minATR%  Trades  W/L       WR      ROI%      PF    Sharpe  MaxDD%');
    console.log('  ─────────────────────────────────────────────────────────────────');

    for (const minAtr of minAtrValues) {
      const r = runWithMinAtr(minAtr, ticks);
      const sign = r.roi >= 0 ? '+' : '';
      const label = minAtr === 0 ? '   OFF' : minAtr.toFixed(3);
      const marker = minAtr === 0.015 ? ' ← current' : '';
      console.log(
        `  ${label}  ${String(r.trades).padStart(6)}  ` +
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
}

main();
