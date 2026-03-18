/**
 * Validate top configs from 90d research on 2y data.
 * Tests only the winning configs, not the full grid.
 */

import { readFileSync } from 'node:fs';
import { SOL_FEED_ID } from './feed.js';
import type { Tick } from './feed.js';
import type { Direction } from './base-strategy.js';
import { PaperTrader } from './base-strategy.js';
import { BankrollManager } from './bankroll.js';
import { RegimeStrategy } from './regime.js';
import { STRATEGIES } from './strategies.js';
import type { StrategyConfig } from './strategies.js';

const LEVERAGE = 10;
const TAKER_FEE = 2 / 10_000;
const BANKROLL = 3;

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

function sliceTicks(ticks: Tick[], startTs: number, endTs: number): Tick[] {
  let lo = 0, hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ticks[mid].publishTime < startTs) lo = mid + 1;
    else hi = mid;
  }
  const startIdx = lo;
  lo = startIdx; hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ticks[mid].publishTime <= endTs) lo = mid + 1;
    else hi = mid;
  }
  return ticks.slice(startIdx, lo);
}

/* ── Dual Timeframe Strategy (winner from 90d) ── */

class DualTFStrategy {
  readonly name: string;
  private paper: PaperTrader;
  private bankroll: BankrollManager | null = null;

  private atrPeriod: number;
  private longWindowSec: number;
  private shortWindowSec: number;
  private longThreshMult: number;
  private shortThreshMult: number;
  private trailAtrMult: number;
  private trailDelaySec: number;
  private hardSlPct: number;
  private cooldownSec: number;

  private atrBuffer: number[] = [];
  private lastAtrPrice = 0;
  private lastAtrSampleTime = 0;
  private atrPct = 0;
  private priceBuffer: { time: number; price: number }[] = [];
  private entryPrice = 0;
  private entryDirection: Direction = 'long';
  private entryTickTime = 0;
  private bestPrice = 0;
  private lastExitTime = 0;
  private warmedUp = false;

  constructor(name: string, opts: {
    atrPeriod: number; longWindowSec: number; shortWindowSec: number;
    longThreshMult: number; shortThreshMult: number;
    trailAtrMult: number; trailDelaySec: number; hardSlPct: number; cooldownSec: number;
  }) {
    this.name = name;
    this.paper = new PaperTrader(name);
    this.atrPeriod = opts.atrPeriod;
    this.longWindowSec = opts.longWindowSec;
    this.shortWindowSec = opts.shortWindowSec;
    this.longThreshMult = opts.longThreshMult;
    this.shortThreshMult = opts.shortThreshMult;
    this.trailAtrMult = opts.trailAtrMult;
    this.trailDelaySec = opts.trailDelaySec;
    this.hardSlPct = opts.hardSlPct;
    this.cooldownSec = opts.cooldownSec;
  }

  setBankroll(bm: BankrollManager) { this.bankroll = bm; }
  getMetrics() { return this.paper.getMetrics(); }

  onTick(tick: Tick): void {
    if (tick.feedId !== SOL_FEED_ID) return;
    const now = tick.publishTime;
    const price = tick.price;

    if (this.lastAtrPrice > 0) {
      if (now - this.lastAtrSampleTime >= 60) {
        const deltaPct = (Math.abs(price - this.lastAtrPrice) / this.lastAtrPrice) * 100;
        this.atrBuffer.push(deltaPct);
        if (this.atrBuffer.length > this.atrPeriod) this.atrBuffer.shift();
        this.lastAtrSampleTime = now;
        this.lastAtrPrice = price;
        if (this.atrBuffer.length > 0) {
          this.atrPct = this.atrBuffer.reduce((a, b) => a + b, 0) / this.atrBuffer.length;
        }
      }
    } else {
      this.lastAtrSampleTime = now;
      this.lastAtrPrice = price;
    }

    this.priceBuffer.push({ time: now, price });
    const cutoff = now - this.longWindowSec * 1.1;
    while (this.priceBuffer.length > 0 && this.priceBuffer[0].time < cutoff) this.priceBuffer.shift();

    if (!this.warmedUp) {
      if (this.atrBuffer.length >= this.atrPeriod) {
        const span = this.priceBuffer.length > 0 ? now - this.priceBuffer[0].time : 0;
        if (span >= this.longWindowSec * 0.9) this.warmedUp = true;
      }
      if (!this.warmedUp) return;
    }

    if (this.paper.inPosition) { this.checkExit(price, now); return; }
    if (this.lastExitTime > 0 && (now - this.lastExitTime) < this.cooldownSec) return;
    if (this.atrPct <= 0) return;

    const longChange = this.getChange(now, this.longWindowSec);
    const longAtr = this.atrPct * Math.sqrt(this.longWindowSec / 60);
    if (Math.abs(longChange) < this.longThreshMult * longAtr) return;
    const macroDir: Direction = longChange > 0 ? 'long' : 'short';

    const shortChange = this.getChange(now, this.shortWindowSec);
    const shortAtr = this.atrPct * Math.sqrt(this.shortWindowSec / 60);
    const shortThresh = this.shortThreshMult * shortAtr;

    if (macroDir === 'long' && shortChange > shortThresh) this.enter('long', price, now);
    else if (macroDir === 'short' && shortChange < -shortThresh) this.enter('short', price, now);
  }

  private getChange(now: number, windowSec: number): number {
    const cutoff = now - windowSec;
    for (const s of this.priceBuffer) {
      if (s.time >= cutoff) return ((this.priceBuffer[this.priceBuffer.length - 1].price / s.price) - 1) * 100;
    }
    return 0;
  }

  private enter(dir: Direction, price: number, now: number): void {
    const betSize = this.bankroll ? this.bankroll.getBetSize('regime') : 1.0;
    if (betSize <= 0) return;
    this.entryPrice = price;
    this.entryDirection = dir;
    this.entryTickTime = now;
    this.bestPrice = price;
    this.bankroll?.reserveCapital(betSize);
    this.paper.openPaper(dir, price, betSize * LEVERAGE, TAKER_FEE, now);
  }

  private checkExit(price: number, now: number): void {
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;
    if (favorable <= -this.hardSlPct) { this.exit(price, now); return; }
    if (this.entryDirection === 'long' && price > this.bestPrice) this.bestPrice = price;
    if (this.entryDirection === 'short' && price < this.bestPrice) this.bestPrice = price;
    if ((now - this.entryTickTime) < this.trailDelaySec) return;
    const trailPct = this.trailAtrMult * this.atrPct * Math.sqrt(240);
    if (this.entryDirection === 'long') {
      if (((this.bestPrice - price) / this.bestPrice) * 100 >= trailPct) this.exit(price, now);
    } else {
      if (((price - this.bestPrice) / this.bestPrice) * 100 >= trailPct) this.exit(price, now);
    }
  }

  private exit(price: number, now: number): void {
    const trade = this.paper.closePaper(price, TAKER_FEE, now);
    if (trade) {
      this.bankroll?.releaseCapital(Math.abs(trade.sizeSol) / LEVERAGE);
      this.bankroll?.recordPnl(trade.netPnlSol);
    }
    this.lastExitTime = now;
  }
}

/* ── Runner ── */

function run(factory: () => { onTick: (t: Tick) => void; getMetrics: () => any; setBankroll: (bm: BankrollManager) => void }, ticks: Tick[]) {
  const strat = factory();
  const bm = new BankrollManager({ mode: 'paper', initialEquitySol: BANKROLL });
  strat.setBankroll(bm);
  let peak = BANKROLL, maxDd = 0;
  for (const tick of ticks) {
    strat.onTick(tick);
    const eq = bm.getEquity();
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }
  const m = strat.getMetrics();
  return {
    roi: ((bm.getEquity() - BANKROLL) / BANKROLL) * 100,
    trades: m.totalTrades, wr: m.winRate * 100, pf: m.profitFactor,
    sharpe: m.sharpe, maxDd, pnl: m.netPnlSol,
  };
}

// ── Top configs from 90d research ──
const configs = [
  // Best Sharpe: DTF 120m signal, 4.5× threshold, various long windows (all identical results)
  { name: 'DTF-6h-120m-4.5x-t1.5', longH: 6, shortMin: 120, longMult: 1.2, shortMult: 4.5, trail: 1.5, sl: 2 },
  { name: 'DTF-8h-120m-4.5x-t1.5', longH: 8, shortMin: 120, longMult: 1.2, shortMult: 4.5, trail: 1.5, sl: 2 },
  { name: 'DTF-12h-120m-4.5x-t1.5', longH: 12, shortMin: 120, longMult: 1.2, shortMult: 4.5, trail: 1.5, sl: 2 },
  // Tighter trail
  { name: 'DTF-6h-120m-4.5x-t1.0', longH: 6, shortMin: 120, longMult: 1.2, shortMult: 4.5, trail: 1.0, sl: 2 },
  // Best ROI: DTF 30m signal, 3× threshold, 12h long
  { name: 'DTF-12h-30m-3x-t1.5', longH: 12, shortMin: 30, longMult: 1.2, shortMult: 3.0, trail: 1.5, sl: 3 },
  { name: 'DTF-12h-30m-3x-t1.5-sl2', longH: 12, shortMin: 30, longMult: 1.2, shortMult: 3.0, trail: 1.5, sl: 2 },
  // High Sharpe + good ROI: DTF 60m signal
  { name: 'DTF-6h-60m-4.5x-t1.5', longH: 6, shortMin: 60, longMult: 1.2, shortMult: 4.5, trail: 1.5, sl: 2 },
  { name: 'DTF-6h-60m-4.5x-t1.0', longH: 6, shortMin: 60, longMult: 1.2, shortMult: 4.5, trail: 1.0, sl: 2 },
  // 30m signal with higher threshold
  { name: 'DTF-6h-30m-4.5x-t1.5', longH: 6, shortMin: 30, longMult: 1.5, shortMult: 4.5, trail: 1.5, sl: 2 },
  // Wider trail delay
  { name: 'DTF-6h-60m-4.5x-t1.5-d600', longH: 6, shortMin: 60, longMult: 1.2, shortMult: 4.5, trail: 1.5, sl: 2, trailDelay: 600 },
  { name: 'DTF-8h-60m-4.5x-t1.5', longH: 8, shortMin: 60, longMult: 1.2, shortMult: 4.5, trail: 1.5, sl: 2 },
  { name: 'DTF-12h-60m-3x-t1.5', longH: 12, shortMin: 60, longMult: 1.2, shortMult: 3.0, trail: 1.5, sl: 3 },
];

const DATA_DIR = new URL('../data/', import.meta.url).pathname;

for (const dataFile of ['history-90d.jsonl', 'history-2y.jsonl']) {
  let ticks: Tick[];
  try { ticks = loadTicks(`${DATA_DIR}${dataFile}`); } catch { continue; }
  const days = Math.round((ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 86400);

  console.log(`\n═══ ${dataFile} (${days} days) ═══`);

  // Also run R-base and R-fast for comparison
  console.log(`\n── Existing strategies (baseline) ──`);
  for (const sName of ['R-base', 'R-fast']) {
    const cfg = STRATEGIES.find(s => s.name === sName)! as Extract<StrategyConfig, { type: 'regime' }>;
    const r = run(
      () => {
        const s = new RegimeStrategy(cfg);
        return { onTick: s.onTick.bind(s), getMetrics: s.getMetrics.bind(s), setBankroll: s.setBankroll!.bind(s) };
      },
      ticks,
    );
    const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`;
    const pnl = `${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(3)}`;
    console.log(`  ${sName.padEnd(35)} | ${roi.padStart(8)} | T:${String(r.trades).padStart(4)} | WR:${r.wr.toFixed(1).padStart(5)}% | PF:${r.pf.toFixed(2).padStart(5)} | Sh:${r.sharpe.toFixed(3).padStart(7)} | DD:${r.maxDd.toFixed(1).padStart(5)}% | ${pnl.padStart(7)}`);
  }

  console.log(`\n── New DTF strategy configs ──`);
  for (const c of configs) {
    const r = run(
      () => new DualTFStrategy(c.name, {
        atrPeriod: 90, longWindowSec: c.longH * 3600, shortWindowSec: c.shortMin * 60,
        longThreshMult: c.longMult, shortThreshMult: c.shortMult,
        trailAtrMult: c.trail, trailDelaySec: (c as any).trailDelay ?? 300, hardSlPct: c.sl, cooldownSec: 120,
      }),
      ticks,
    );
    const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`;
    const pnl = `${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(3)}`;
    console.log(`  ${c.name.padEnd(35)} | ${roi.padStart(8)} | T:${String(r.trades).padStart(4)} | WR:${r.wr.toFixed(1).padStart(5)}% | PF:${r.pf.toFixed(2).padStart(5)} | Sh:${r.sharpe.toFixed(3).padStart(7)} | DD:${r.maxDd.toFixed(1).padStart(5)}% | ${pnl.padStart(7)}`);
  }

  // Quarterly breakdown for top 3
  if (days > 100) {
    console.log(`\n── Quarterly ROI (top configs vs baselines) ──`);
    const startTs = ticks[0].publishTime;
    const endTs = ticks[ticks.length - 1].publishTime;
    const quarterSec = 90 * 86400;
    const quarters: { label: string; start: number; end: number }[] = [];
    let qs = startTs, qi = 1;
    while (qs < endTs) {
      const qe = Math.min(qs + quarterSec, endTs);
      quarters.push({ label: `Q${qi}`, start: qs, end: qe });
      qs = qe; qi++;
    }

    const toTest = [
      { name: 'R-base', factory: () => {
        const cfg = STRATEGIES.find(s => s.name === 'R-base')! as any;
        const s = new RegimeStrategy(cfg);
        return { onTick: s.onTick.bind(s), getMetrics: s.getMetrics.bind(s), setBankroll: s.setBankroll!.bind(s) };
      }},
      { name: 'R-fast', factory: () => {
        const cfg = STRATEGIES.find(s => s.name === 'R-fast')! as any;
        const s = new RegimeStrategy(cfg);
        return { onTick: s.onTick.bind(s), getMetrics: s.getMetrics.bind(s), setBankroll: s.setBankroll!.bind(s) };
      }},
      { name: 'DTF-6h-60m-4.5x-t1.5', factory: () => new DualTFStrategy('DTF', {
        atrPeriod: 90, longWindowSec: 6*3600, shortWindowSec: 60*60,
        longThreshMult: 1.2, shortThreshMult: 4.5, trailAtrMult: 1.5, trailDelaySec: 300, hardSlPct: 2, cooldownSec: 120,
      })},
      { name: 'DTF-12h-30m-3x-t1.5', factory: () => new DualTFStrategy('DTF', {
        atrPeriod: 90, longWindowSec: 12*3600, shortWindowSec: 30*60,
        longThreshMult: 1.2, shortThreshMult: 3.0, trailAtrMult: 1.5, trailDelaySec: 300, hardSlPct: 3, cooldownSec: 120,
      })},
      { name: 'DTF-6h-120m-4.5x-t1.5', factory: () => new DualTFStrategy('DTF', {
        atrPeriod: 90, longWindowSec: 6*3600, shortWindowSec: 120*60,
        longThreshMult: 1.2, shortThreshMult: 4.5, trailAtrMult: 1.5, trailDelaySec: 300, hardSlPct: 2, cooldownSec: 120,
      })},
    ];

    const header = `${'Strategy'.padEnd(30)} | ${quarters.map(q => q.label.padStart(8)).join(' | ')}`;
    console.log(header);
    console.log('─'.repeat(header.length));

    for (const t of toTest) {
      const qRois = quarters.map(q => {
        const qTicks = sliceTicks(ticks, q.start, q.end);
        if (qTicks.length < 100) return '   N/A  ';
        const r = run(t.factory, qTicks);
        return `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`.padStart(8);
      });
      console.log(`${t.name.padEnd(30)} | ${qRois.join(' | ')}`);
    }
  }
}
