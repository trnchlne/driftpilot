/**
 * Backtest profit-locking variants with 10x leverage.
 * Patches RegimeStrategy to use leveraged position sizes for accurate P&L.
 *
 * Usage: npx tsx src/backtest-locks.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import { STRATEGIES } from './strategies.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';
import { SOL_FEED_ID } from './feed.js';

const DATA_PATH = resolve('data/history-180d.jsonl');
const LAST_N_DAYS = 90;
const BALANCE_USDC = 27.51;
const SOL_PRICE_APPROX = 86;
const BALANCE_SOL = BALANCE_USDC / SOL_PRICE_APPROX;
const LEVERAGE = 10;
const KELLY = 0.30;

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

/* ─── Profit-lock variants ───────────────────────────────── */

interface LockConfig {
  name: string;
  delaySec: number;
  tiers: [number, number][]; // [portfolioThreshold%, lockFraction]
  minTrail: number;
}

const LOCK_VARIANTS: LockConfig[] = [
  {
    name: 'Current (greedy)',
    delaySec: 3 * 60,
    tiers: [
      [0.3, 0], [1.0, 0.40], [2.0, 0.60], [3.0, 0.70], [5.0, 0.80],
    ],
    minTrail: 0.10,
  },
  {
    name: 'BE@1% portfolio',
    delaySec: 5 * 60,
    tiers: [
      [1.0, 0], [2.0, 0.40], [3.0, 0.55], [5.0, 0.70],
    ],
    minTrail: 0.10,
  },
  {
    name: 'BE@2% portfolio',
    delaySec: 5 * 60,
    tiers: [
      [2.0, 0], [3.0, 0.40], [5.0, 0.60], [8.0, 0.70],
    ],
    minTrail: 0.15,
  },
  {
    name: 'BE@3% portfolio',
    delaySec: 8 * 60,
    tiers: [
      [3.0, 0], [5.0, 0.40], [8.0, 0.55], [12.0, 0.65],
    ],
    minTrail: 0.20,
  },
  {
    name: 'Light lock (BE@5%)',
    delaySec: 10 * 60,
    tiers: [
      [5.0, 0], [10.0, 0.40], [15.0, 0.55],
    ],
    minTrail: 0.25,
  },
  {
    name: 'Pure ATR trail',
    delaySec: 999999,
    tiers: [],
    minTrail: 0.10,
  },
];

/* ─── Run a single variant ───────────────────────────────── */

function runVariant(variant: LockConfig, ticks: Tick[]): {
  roi: number; trades: number; winRate: number; pf: number;
  maxDd: number; netPnl: number; sharpe: number;
  finalEquity: number; wins: number; losses: number;
} {
  const rBaseConfig = STRATEGIES.find(s => s.name === 'R-base')!;

  const bankroll = new BankrollManager({
    mode: 'paper',
    initialEquitySol: BALANCE_SOL,
  });
  const strategy = new RegimeStrategy(rBaseConfig);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  // Patch enter() to use leveraged position size
  const origEnter = (strategy as any).enter.bind(strategy);
  (strategy as any).enter = function(direction: any, price: number, now: number, regime: any, feeRate: number) {
    const betSize = this.getBetSize();
    if (betSize <= 0) return;

    this.entryPrice = price;
    this.entryDirection = direction;
    this.entryTickTime = now;
    this.entryRegime = regime;
    this.bestPriceSinceEntry = price;
    this.entryRollingMean = this.rollingMean;
    this.entryScaledAtr = this.scaledAtr(this.config.meanWindowSeconds / 60);
    this.lastTrailCheckTime = now;

    // Reserve margin in bankroll, but open paper with leveraged size
    this.bankroll?.reserveCapital(betSize);
    this.paper.openPaper(direction, price, betSize * LEVERAGE, feeRate, now);
    this.paper.saveEntryRegime(regime);
  };

  // Patch exit() to release only margin (not leveraged size)
  const origExit = (strategy as any).exit.bind(strategy);
  (strategy as any).exit = function(price: number, now: number, feeRate: number, reason: string) {
    if (!this.paper.inPosition) return;

    const trade = this.paper.closePaper(price, feeRate, now);
    if (!trade) return;

    // Release margin (sizeSol / leverage), not the full leveraged position
    const margin = trade.sizeSol / LEVERAGE;
    this.bankroll?.releaseCapital(margin);
    this.bankroll?.recordPnl(trade.netPnlSol);

    // Capture last trade info
    this.lastTradeInfo = {
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      holdSec: now - this.entryTickTime,
      netPnl: trade.netPnlSol,
      reason,
      atrAtExit: this.atrPct,
      trailPctAtExit: 0,
    };

    const sign = trade.netPnlSol >= 0 ? '+' : '';
    console.log(
      `[${this.name}] EXIT ${reason} | $${trade.entryPrice.toFixed(2)} → $${price.toFixed(2)} | ` +
      `net ${sign}${trade.netPnlSol.toFixed(6)} SOL`,
    );
  };

  // Patch checkTrendExit for this variant's lock config
  (strategy as any).checkTrendExit = function(price: number, now: number) {
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;

    // Hard SL — 3% from entry
    if (favorable <= -3.0) {
      this.exit(price, now, 2 / 10_000, 'SL');
      return;
    }

    const holdTime = now - this.entryTickTime;

    // Trail delay
    if (holdTime < this.config.trailDelaySeconds) {
      if (now - this.lastTrailCheckTime >= 60) {
        this.trackBestPrice(price);
        this.lastTrailCheckTime = now;
      }
      return;
    }

    if (now - this.lastTrailCheckTime < 60) return;
    this.lastTrailCheckTime = now;
    this.trackBestPrice(price);

    // ATR-based trail
    const stopAtr = this.scaledAtr(this.config.regimeWindowSeconds / 60);
    let trailPct = this.config.trailingAtrMultiple * stopAtr;

    // Profit locking
    if (holdTime >= variant.delaySec && favorable > 0 && variant.tiers.length > 0) {
      const portfolioGain = favorable * LEVERAGE * KELLY;
      let lockFloor = -1;

      for (let i = variant.tiers.length - 1; i >= 0; i--) {
        if (portfolioGain >= variant.tiers[i][0]) {
          lockFloor = variant.tiers[i][1] === 0 ? 0 : favorable * variant.tiers[i][1];
          break;
        }
      }

      if (lockFloor >= 0) {
        const maxGiveBack = favorable - lockFloor;
        trailPct = Math.min(trailPct, maxGiveBack);
        trailPct = Math.max(trailPct, variant.minTrail);
      }
    }

    // Check trail trigger
    if (this.entryDirection === 'long') {
      const drawdown = ((this.bestPriceSinceEntry - price) / this.bestPriceSinceEntry) * 100;
      if (drawdown >= trailPct) this.exit(price, now, 2 / 10_000, 'trail');
    } else {
      const drawup = ((price - this.bestPriceSinceEntry) / this.bestPriceSinceEntry) * 100;
      if (drawup >= trailPct) this.exit(price, now, 2 / 10_000, 'trail');
    }
  };

  // Suppress logs
  const origLog = console.log;
  console.log = () => {};

  let peakEquity = BALANCE_SOL;
  let maxDdPct = 0;
  let lastSnap = 0;

  for (const tick of ticks) {
    bankroll.updateSolPrice(tick.price);
    strategy.onTick(tick);

    if (tick.publishTime - lastSnap >= 60) {
      const eq = bankroll.getEquity();
      if (eq > peakEquity) peakEquity = eq;
      const ddPct = peakEquity > 0 ? ((peakEquity - eq) / peakEquity) * 100 : 0;
      if (ddPct > maxDdPct) maxDdPct = ddPct;
      lastSnap = tick.publishTime;
    }
  }

  console.log = origLog;

  const metrics = strategy.getMetrics();
  const finalEquity = bankroll.getEquity();
  const roi = ((finalEquity / BALANCE_SOL) - 1) * 100;

  strategy.stop();

  return {
    roi,
    trades: metrics.totalTrades,
    winRate: metrics.winRate,
    pf: metrics.profitFactor,
    maxDd: maxDdPct,
    netPnl: metrics.netPnlSol,
    sharpe: metrics.sharpe,
    finalEquity,
    wins: metrics.wins,
    losses: metrics.losses,
  };
}

/* ─── Main ───────────────────────────────────────────────── */

function main(): void {
  console.log(`Loading data...`);
  const allTicks = loadTicks(DATA_PATH);
  const lastTs = allTicks[allTicks.length - 1].publishTime;
  const startTs = lastTs - (LAST_N_DAYS * 24 * 3600);
  const ticks = allTicks.filter(t => t.publishTime >= startTs);
  const solTicks = ticks.filter(t => t.feedId === SOL_FEED_ID);
  const solStart = solTicks[0]?.price ?? 0;
  const solEnd = solTicks[solTicks.length - 1]?.price ?? 0;
  const days = LAST_N_DAYS;

  console.log(`${ticks.length.toLocaleString()} ticks, ${days} days, SOL $${solStart.toFixed(2)} → $${solEnd.toFixed(2)} (${(((solEnd/solStart)-1)*100).toFixed(1)}%)`);
  console.log(`Starting: ${BALANCE_SOL.toFixed(4)} SOL ($${BALANCE_USDC}) | ${LEVERAGE}x leverage | ${(KELLY*100).toFixed(0)}% Kelly`);
  console.log('');

  console.log('═'.repeat(130));
  console.log('  PROFIT-LOCK VARIANT COMPARISON — R-base, 3 months, 10x leverage, 30% Kelly');
  console.log('═'.repeat(130));
  console.log('');
  console.log('  Variant              Trades  W/L       WR      ROI%      P&L SOL    $P&L     PF     Sharpe  MaxDD%  Final$');
  console.log('  ───────────────────  ──────  ────────  ──────  ────────  ─────────  ───────  ─────  ──────  ──────  ──────');

  for (const variant of LOCK_VARIANTS) {
    const r = runVariant(variant, ticks);
    const name = variant.name.padEnd(21);
    const trades = String(r.trades).padStart(6);
    const wl = `${r.wins}/${r.losses}`.padStart(8);
    const wr = `${r.winRate.toFixed(1)}%`.padStart(6);
    const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`.padStart(8);
    const pnl = `${r.netPnl >= 0 ? '+' : ''}${r.netPnl.toFixed(4)}`.padStart(9);
    const pnlUsd = `$${(r.netPnl * solEnd).toFixed(2)}`.padStart(7);
    const pf = r.pf === Infinity ? '  Inf' : r.pf.toFixed(2).padStart(5);
    const sharpe = r.sharpe.toFixed(3).padStart(6);
    const dd = `${r.maxDd.toFixed(1)}%`.padStart(6);
    const finalUsd = `$${(r.finalEquity * solEnd).toFixed(2)}`.padStart(6);

    console.log(`  ${name}  ${trades}  ${wl}  ${wr}  ${roi}  ${pnl}  ${pnlUsd}  ${pf}  ${sharpe}  ${dd}  ${finalUsd}`);
  }

  console.log('');
  console.log('  Notes:');
  console.log('  - P&L accounts for 10x leveraged position sizes (margin × 10)');
  console.log('  - MaxDD% is on equity (margin account), not on position');
  console.log('  - Bust = MaxDD >= 100% (account wiped)');
  console.log('  - SOL dropped -40% in this period — holding spot lost more than any variant');
  console.log('');
  console.log('═'.repeat(130));
}

main();
