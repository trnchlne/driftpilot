/**
 * Sweep meanWindowSeconds for R-base to find the optimal value.
 * Tests: 30m, 1h, 2h, 3h, 4h, 6h, 8h
 */

import { readFileSync } from 'node:fs';
import type { Tick } from './feed.js';
import { BankrollManager } from './bankroll.js';
import { RegimeStrategy } from './regime.js';
import { STRATEGIES } from './strategies.js';
import type { StrategyConfig } from './strategies.js';

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

const BANKROLL = 3;

function run(config: StrategyConfig, ticks: Tick[]): {
  roi: number; trades: number; wr: number; pf: number; sharpe: number; maxDd: number; pnl: number;
} {
  const strategy = new RegimeStrategy(config as any);
  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: BANKROLL });
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  let peak = BANKROLL;
  let maxDd = 0;

  for (const tick of ticks) {
    strategy.onTick(tick);
    const eq = bankroll.getEquity();
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }

  const final = bankroll.getEquity();
  const m = strategy.getMetrics();
  return {
    roi: ((final - BANKROLL) / BANKROLL) * 100,
    trades: m.totalTrades,
    wr: m.winRate * 100,
    pf: m.profitFactor,
    sharpe: m.sharpe,
    maxDd,
    pnl: m.netPnlSol,
  };
}

// ── Main ──
const DATA_DIR = new URL('../data/', import.meta.url).pathname;
const stratName = process.argv[2] || 'R-base';
const baseCfg = STRATEGIES.find(s => s.name === stratName)! as Extract<StrategyConfig, { type: 'regime' }>;
if (!baseCfg) { console.error(`Strategy ${stratName} not found`); process.exit(1); }

const meanWindows = [
  { label: '30m', seconds: 30 * 60 },
  { label: '1h',  seconds: 1 * 3600 },
  { label: '2h',  seconds: 2 * 3600 },
  { label: '3h',  seconds: 3 * 3600 },
  { label: '4h',  seconds: 4 * 3600 },
  { label: '6h',  seconds: 6 * 3600 },
  { label: '8h',  seconds: 8 * 3600 },
];

for (const dataFile of ['history-90d.jsonl', 'history-2y.jsonl']) {
  let ticks: Tick[];
  try {
    ticks = loadTicks(`${DATA_DIR}${dataFile}`);
  } catch {
    console.log(`Skipping ${dataFile}`);
    continue;
  }

  const totalDays = Math.round((ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 86400);
  console.log(`\n═══ ${dataFile} (${totalDays} days) ═══`);
  console.log(`${'Mean'.padEnd(6)} | ${'ROI'.padStart(8)} | ${'Trades'.padStart(6)} | ${'WR%'.padStart(6)} | ${'PF'.padStart(5)} | ${'Sharpe'.padStart(7)} | ${'MaxDD'.padStart(6)} | ${'PnL SOL'.padStart(8)}`);
  console.log('─'.repeat(75));

  for (const mw of meanWindows) {
    const cfg = { ...baseCfg, name: `R-base-${mw.label}`, meanWindowSeconds: mw.seconds };
    const r = run(cfg, ticks);
    const roiStr = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`;
    const pnlStr = `${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(3)}`;
    console.log(`${mw.label.padEnd(6)} | ${roiStr.padStart(8)} | ${String(r.trades).padStart(6)} | ${r.wr.toFixed(1).padStart(6)} | ${r.pf.toFixed(2).padStart(5)} | ${r.sharpe.toFixed(3).padStart(7)} | ${r.maxDd.toFixed(1).padStart(5)}% | ${pnlStr.padStart(8)}`);
  }

  // Also do quarterly breakdown for the best candidates
  if (totalDays > 100) {
    console.log(`\n── Quarterly breakdown ──`);
    const startTs = ticks[0].publishTime;
    const endTs = ticks[ticks.length - 1].publishTime;
    const quarterSec = 90 * 86400;

    // Find quarters
    const quarters: { label: string; start: number; end: number }[] = [];
    let qs = startTs;
    let qi = 1;
    while (qs < endTs) {
      const qe = Math.min(qs + quarterSec, endTs);
      quarters.push({ label: `Q${qi}`, start: qs, end: qe });
      qs = qe;
      qi++;
    }

    const header = `${'Mean'.padEnd(6)} | ${quarters.map(q => q.label.padStart(8)).join(' | ')}`;
    console.log(header);
    console.log('─'.repeat(header.length));

    for (const mw of meanWindows) {
      const cfg = { ...baseCfg, name: `R-base-${mw.label}`, meanWindowSeconds: mw.seconds };
      const qResults = quarters.map(q => {
        const qTicks = sliceTicks(ticks, q.start, q.end);
        if (qTicks.length < 100) return '   N/A  ';
        const r = run(cfg, qTicks);
        return `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`.padStart(8);
      });
      console.log(`${mw.label.padEnd(6)} | ${qResults.join(' | ')}`);
    }
  }
}
