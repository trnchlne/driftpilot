/**
 * Re-validate: do the optimal params change with minAtrPct=0.035?
 * Tests the top combined configs + some neighboring values with the new filter.
 *
 * Usage: cd bot && npx tsx src/backtest-revalidate.ts
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

interface Overrides {
  atrPeriod: number;
  trailingAtrMultiple: number;
  slAtrMultiple: number;
  hardSlPct: number;
  signalMultiple: number;
  signalWindowSeconds: number;
  trailDelaySeconds: number;
  cooldownSeconds: number;
  trendThreshold: number;
  rangeThreshold: number;
  regimeWindowSeconds: number;
  meanWindowSeconds: number;
  entryBandMultiple: number;
  reversionSlMultiple: number;
  minAtrPct: number;
}

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

function run(o: Overrides, ticks: Tick[]): { trades: number; wins: number; losses: number; winRate: number; roi: number; pf: number; sharpe: number; maxDd: number } {
  const rBase = STRATEGIES.find(s => s.name === 'R-base')!;
  const config = { ...rBase, ...o } as any;

  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: BALANCE_SOL });
  const strategy = new RegimeStrategy(config);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

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
    this.lastTradeInfo = { direction: trade.direction, entryPrice: trade.entryPrice, exitPrice: trade.exitPrice, holdSec: now - this.entryTickTime, netPnl: trade.netPnlSol, reason, atrAtExit: this.atrPct, trailPctAtExit: 0 };
  };

  (strategy as any).checkTrendExit = function (price: number, now: number) {
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;
    if (favorable <= -o.hardSlPct) { this.exit(price, now, 2 / 10_000, 'SL'); return; }
    const holdTime = now - this.entryTickTime;
    if (holdTime < this.config.trailDelaySeconds) { if (now - this.lastTrailCheckTime >= 60) { this.trackBestPrice(price); this.lastTrailCheckTime = now; } return; }
    if (now - this.lastTrailCheckTime < 60) return;
    this.lastTrailCheckTime = now; this.trackBestPrice(price);
    const stopAtr = this.scaledAtr(this.config.regimeWindowSeconds / 60);
    const trailPct = this.config.trailingAtrMultiple * stopAtr;
    if (this.entryDirection === 'long') { if (((this.bestPriceSinceEntry - price) / this.bestPriceSinceEntry) * 100 >= trailPct) this.exit(price, now, 2 / 10_000, 'trail'); }
    else { if (((price - this.bestPriceSinceEntry) / this.bestPriceSinceEntry) * 100 >= trailPct) this.exit(price, now, 2 / 10_000, 'trail'); }
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
  return { trades: m.totalTrades, wins: m.wins, losses: m.losses, winRate: m.winRate, roi, pf: m.profitFactor, sharpe: m.sharpe, maxDd };
}

function main(): void {
  console.log('Loading data...');
  const allTicks = loadTicks();
  const lastTs = allTicks[allTicks.length - 1].publishTime;

  // Sensitive params to cross with minAtrPct=0.035
  const configs: { label: string; o: Overrides }[] = [];

  const base = {
    slAtrMultiple: 1.0,
    hardSlPct: 2.0,
    cooldownSeconds: 120,
    regimeWindowSeconds: 4 * 3600,
    meanWindowSeconds: 60 * 60,
    entryBandMultiple: 2.5,
    reversionSlMultiple: 4.0,
    minAtrPct: 0.035,
  };

  // Cross the sensitive params: atr, trail, signal, sigWin, delay, trendThr, rangeThr
  const atrs = [85, 90, 95];
  const trails = [0.6, 0.7, 0.8];
  const sigs = [4.0, 4.5, 5.0];
  const sigWins = [20*60, 25*60, 30*60];
  const delays = [240, 300, 360];
  const trends = [1.2, 1.3, 1.5];
  const ranges = [0.8, 0.9, 1.0];

  // That's 3^7 = 2187 combos — very manageable
  for (const atr of atrs) {
    for (const trail of trails) {
      for (const sig of sigs) {
        for (const sigWin of sigWins) {
          for (const delay of delays) {
            for (const trend of trends) {
              for (const range of ranges) {
                configs.push({
                  label: `atr=${atr} tr=${trail} sig=${sig} win=${sigWin/60}m dly=${delay} t=${trend} r=${range}`,
                  o: { ...base, atrPeriod: atr, trailingAtrMultiple: trail, signalMultiple: sig, signalWindowSeconds: sigWin, trailDelaySeconds: delay, trendThreshold: trend, rangeThreshold: range },
                });
              }
            }
          }
        }
      }
    }
  }

  console.log(`Testing ${configs.length} configs with minAtrPct=0.035\n`);

  // Run on both 90d and 180d
  const windows = [90, 180];
  const results: { label: string; o: Overrides; r90: ReturnType<typeof run>; r180: ReturnType<typeof run>; avgRoi: number; avgSharpe: number }[] = [];

  const t0 = Date.now();
  let count = 0;

  for (const cfg of configs) {
    count++;
    if (count % 200 === 0) process.stdout.write(`  ${count}/${configs.length}...\r`);

    const startTs90 = lastTs - (90 * 24 * 3600);
    const ticks90 = allTicks.filter(t => t.publishTime >= startTs90);
    const r90 = run(cfg.o, ticks90);

    const startTs180 = lastTs - (180 * 24 * 3600);
    const ticks180 = allTicks.filter(t => t.publishTime >= startTs180);
    const r180 = run(cfg.o, ticks180);

    results.push({
      label: cfg.label,
      o: cfg.o,
      r90,
      r180,
      avgRoi: (r90.roi + r180.roi) / 2,
      avgSharpe: (r90.sharpe + r180.sharpe) / 2,
    });
  }

  // Sort by composite score (same as grid-fine)
  results.sort((a, b) => {
    const scoreA = a.avgRoi * 0.50 + a.avgSharpe * 200 * 0.25 + (a.r180.maxDd > 30 ? -(a.r180.maxDd - 30) * 2 * 0.15 : 0) + (a.r180.trades >= 50 ? 0.5 : -1) * 0.10;
    const scoreB = b.avgRoi * 0.50 + b.avgSharpe * 200 * 0.25 + (b.r180.maxDd > 30 ? -(b.r180.maxDd - 30) * 2 * 0.15 : 0) + (b.r180.trades >= 50 ? 0.5 : -1) * 0.10;
    return scoreB - scoreA;
  });

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Print top 25
  console.log('TOP 25 CONFIGS with minAtrPct=0.035 (by composite score):');
  console.log('  #   atr  trail  sig  sWin  dly  tThr  rThr | 90d ROI  90d Shp | 180d ROI  180d Shp  180d DD | Avg ROI');
  console.log('  ' + '─'.repeat(110));

  for (let i = 0; i < Math.min(25, results.length); i++) {
    const { o, r90, r180, avgRoi } = results[i];
    console.log(
      `  ${String(i+1).padStart(3)}  ` +
      `${String(o.atrPeriod).padStart(3)}  ` +
      `${o.trailingAtrMultiple.toFixed(1).padStart(5)}  ` +
      `${o.signalMultiple.toFixed(1).padStart(3)}  ` +
      `${(o.signalWindowSeconds/60 + 'm').padStart(4)}  ` +
      `${String(o.trailDelaySeconds).padStart(3)}  ` +
      `${o.trendThreshold.toFixed(1).padStart(4)}  ` +
      `${o.rangeThreshold.toFixed(1).padStart(4)} | ` +
      `${(r90.roi >= 0 ? '+' : '') + r90.roi.toFixed(1) + '%'}`.padStart(9) + `  ` +
      `${r90.sharpe.toFixed(3)}`.padStart(7) + ` | ` +
      `${(r180.roi >= 0 ? '+' : '') + r180.roi.toFixed(1) + '%'}`.padStart(9) + `  ` +
      `${r180.sharpe.toFixed(3)}`.padStart(8) + `  ` +
      `${r180.maxDd.toFixed(1) + '%'}`.padStart(7) + ` | ` +
      `${(avgRoi >= 0 ? '+' : '') + avgRoi.toFixed(1) + '%'}`.padStart(8)
    );
  }

  // Show what the current config scores
  const currentIdx = results.findIndex(r =>
    r.o.atrPeriod === 90 && r.o.trailingAtrMultiple === 0.7 && r.o.signalMultiple === 4.5 &&
    r.o.signalWindowSeconds === 25*60 && r.o.trailDelaySeconds === 300 &&
    r.o.trendThreshold === 1.2 && r.o.rangeThreshold === 1.0
  );
  if (currentIdx >= 0) {
    console.log(`\n  Current config (atr=90 trail=0.7 sig=4.5 win=25m dly=300 trend=1.2 range=1.0) is rank #${currentIdx + 1} of ${results.length}`);
  }

  // Check if #1 differs from current
  const top = results[0].o;
  const isSame = top.atrPeriod === 90 && top.trailingAtrMultiple === 0.7 && top.signalMultiple === 4.5 &&
    top.signalWindowSeconds === 25*60 && top.trailDelaySeconds === 300 &&
    top.trendThreshold === 1.2 && top.rangeThreshold === 1.0;

  if (isSame) {
    console.log('\n  ✓ Current config is STILL the winner with minAtrPct=0.035 — no change needed.');
  } else {
    console.log(`\n  ⚠ NEW winner with minAtrPct=0.035:`);
    console.log(`    atr=${top.atrPeriod} trail=${top.trailingAtrMultiple} sig=${top.signalMultiple} win=${top.signalWindowSeconds/60}m dly=${top.trailDelaySeconds} trend=${top.trendThreshold} range=${top.rangeThreshold}`);
  }
}

main();
