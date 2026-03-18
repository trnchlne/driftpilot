/**
 * Backtest R-fast (and R-base) on HYPE price data.
 * Uses the same regime strategy but with HYPE's feed ID.
 */

import { readFileSync } from 'node:fs';
import type { Tick } from './feed.js';
import { BankrollManager } from './bankroll.js';
import { RegimeStrategy } from './regime.js';
import { STRATEGIES } from './strategies.js';
import type { StrategyConfig } from './strategies.js';

const HYPE_FEED_ID = '4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b';
const BANKROLL = 3;

function loadTicks(filePath: string): Tick[] {
  const raw = readFileSync(filePath, 'utf-8');
  const ticks: Tick[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      // Remap to SOL_FEED_ID so the strategy accepts it
      ticks.push({ feedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', price: obj.price, publishTime: obj.publishTime });
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

function run(config: StrategyConfig, ticks: Tick[]) {
  const strategy = new RegimeStrategy(config as any);
  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: BANKROLL });
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  let peak = BANKROLL, maxDd = 0;
  for (const tick of ticks) {
    strategy.onTick(tick);
    const eq = bankroll.getEquity();
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }

  const m = strategy.getMetrics();
  return {
    roi: ((bankroll.getEquity() - BANKROLL) / BANKROLL) * 100,
    trades: m.totalTrades,
    wr: m.winRate * 100,
    pf: m.profitFactor,
    sharpe: m.sharpe,
    maxDd,
    pnl: m.netPnlSol,
    finalEquity: bankroll.getEquity(),
  };
}

// ── Main ──
const DATA_FILE = new URL('../data/hype-history.jsonl', import.meta.url).pathname;
const ticks = loadTicks(DATA_FILE);

const startPrice = ticks[0].price;
const endPrice = ticks[ticks.length - 1].price;
const days = Math.round((ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 86400);

console.log(`\n═══ HYPE Backtest (${days} days, ${ticks.length} ticks) ═══`);
console.log(`HYPE price: $${startPrice.toFixed(2)} → $${endPrice.toFixed(2)} (${((endPrice / startPrice - 1) * 100).toFixed(1)}%)\n`);

// Test R-fast, R-base, and R-sharp
const regimeConfigs = STRATEGIES.filter(s => s.type === 'regime') as Extract<StrategyConfig, { type: 'regime' }>[];

console.log(`${'Strategy'.padEnd(12)} | ${'ROI'.padStart(8)} | ${'Trades'.padStart(6)} | ${'WR%'.padStart(5)} | ${'PF'.padStart(5)} | ${'Sharpe'.padStart(7)} | ${'MaxDD'.padStart(6)} | ${'PnL'.padStart(8)} | ${'Final'.padStart(8)}`);
console.log('─'.repeat(95));

for (const cfg of regimeConfigs) {
  const r = run(cfg, ticks);
  const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`;
  const pnl = `${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(3)}`;
  console.log(`${cfg.name.padEnd(12)} | ${roi.padStart(8)} | ${String(r.trades).padStart(6)} | ${r.wr.toFixed(1).padStart(5)} | ${r.pf.toFixed(2).padStart(5)} | ${r.sharpe.toFixed(3).padStart(7)} | ${r.maxDd.toFixed(1).padStart(5)}% | ${pnl.padStart(8)} | ${r.finalEquity.toFixed(3).padStart(8)}`);
}

// Quarterly breakdown for R-fast
console.log(`\n── R-fast Quarterly Breakdown ──`);
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

const rFastCfg = regimeConfigs.find(c => c.name === 'R-fast')!;
console.log(`${'Quarter'.padEnd(10)} | ${'Dates'.padEnd(25)} | ${'ROI'.padStart(8)} | ${'Trades'.padStart(6)} | ${'WR%'.padStart(5)} | ${'PF'.padStart(5)} | ${'PnL'.padStart(8)}`);
console.log('─'.repeat(85));

for (const q of quarters) {
  const qTicks = sliceTicks(ticks, q.start, q.end);
  if (qTicks.length < 100) continue;
  const r = run(rFastCfg, qTicks);
  const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`;
  const pnl = `${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(3)}`;
  const startDate = new Date(q.start * 1000).toISOString().slice(0, 10);
  const endDate = new Date(q.end * 1000).toISOString().slice(0, 10);
  console.log(`${q.label.padEnd(10)} | ${(startDate + ' → ' + endDate).padEnd(25)} | ${roi.padStart(8)} | ${String(r.trades).padStart(6)} | ${r.wr.toFixed(1).padStart(5)} | ${r.pf.toFixed(2).padStart(5)} | ${pnl.padStart(8)}`);
}

// Also try different mean windows for R-fast on HYPE
console.log(`\n── R-fast Mean Window Sweep on HYPE ──`);
const meanWindows = [
  { label: '30m', seconds: 30 * 60 },
  { label: '1h',  seconds: 1 * 3600 },
  { label: '2h',  seconds: 2 * 3600 },
  { label: '3h',  seconds: 3 * 3600 },
  { label: '4h',  seconds: 4 * 3600 },
];

console.log(`${'Mean'.padEnd(6)} | ${'ROI'.padStart(8)} | ${'Trades'.padStart(6)} | ${'WR%'.padStart(5)} | ${'PF'.padStart(5)} | ${'Sharpe'.padStart(7)} | ${'MaxDD'.padStart(6)} | ${'PnL'.padStart(8)}`);
console.log('─'.repeat(70));

for (const mw of meanWindows) {
  const cfg = { ...rFastCfg, name: `R-fast-${mw.label}`, meanWindowSeconds: mw.seconds };
  const r = run(cfg, ticks);
  const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`;
  const pnl = `${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(3)}`;
  console.log(`${mw.label.padEnd(6)} | ${roi.padStart(8)} | ${String(r.trades).padStart(6)} | ${r.wr.toFixed(1).padStart(5)} | ${r.pf.toFixed(2).padStart(5)} | ${r.sharpe.toFixed(3).padStart(7)} | ${r.maxDd.toFixed(1).padStart(5)}% | ${pnl.padStart(8)}`);
}
