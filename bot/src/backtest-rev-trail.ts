/**
 * Backtest: Grid search reversionTrailMultiple for R-fast on SOL and HYPE.
 */

import { readFileSync } from 'node:fs';
import type { Tick } from './feed.js';
import { BankrollManager } from './bankroll.js';
import { RegimeStrategy } from './regime.js';
import { STRATEGIES } from './strategies.js';
import type { StrategyConfig } from './strategies.js';

const SOL_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const BANKROLL = 3;

const TRAIL_VALUES = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 2.0];

function loadTicks(filePath: string, feedId: string): Tick[] {
  const raw = readFileSync(filePath, 'utf-8');
  const ticks: Tick[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      ticks.push({ feedId, price: obj.price, publishTime: obj.publishTime });
    } catch { /* skip */ }
  }
  ticks.sort((a, b) => a.publishTime - b.publishTime);
  return ticks;
}

function run(config: StrategyConfig, ticks: Tick[]) {
  const strategy = new RegimeStrategy(config as any);
  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: BANKROLL });
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  let peak = BANKROLL, maxDd = 0;
  const exitReasons: Record<string, number> = {};
  const origLog = console.log;
  console.log = (...args: any[]) => {
    const msg = args.join(' ');
    const match = msg.match(/EXIT (\S+)/);
    if (match) {
      exitReasons[match[1]] = (exitReasons[match[1]] || 0) + 1;
    }
  };

  for (const tick of ticks) {
    strategy.onTick(tick);
    const eq = bankroll.getEquity();
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }

  console.log = origLog;

  const m = strategy.getMetrics();
  return {
    roi: ((bankroll.getEquity() - BANKROLL) / BANKROLL) * 100,
    trades: m.totalTrades,
    wr: m.winRate * 100,
    pf: m.profitFactor,
    sharpe: m.sharpe,
    maxDd,
    pnl: m.netPnlSol,
    exitReasons,
  };
}

// ── Main ──
const rFastCfg = STRATEGIES.find(c => c.name === 'R-fast-SOL')! as Extract<StrategyConfig, { type: 'regime' }>;

function gridSearch(label: string, ticks: Tick[]) {
  const days = Math.round((ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 86400);
  const startPrice = ticks[0].price;
  const endPrice = ticks[ticks.length - 1].price;

  console.log(`\n═══ ${label} (${days} days, ${ticks.length} ticks) ═══`);
  console.log(`Price: $${startPrice.toFixed(2)} → $${endPrice.toFixed(2)} (${((endPrice / startPrice - 1) * 100).toFixed(1)}%)\n`);

  console.log(`${'Trail'.padEnd(7)} | ${'ROI'.padStart(9)} | ${'Trades'.padStart(6)} | ${'WR%'.padStart(5)} | ${'PF'.padStart(5)} | ${'Sharpe'.padStart(7)} | ${'MaxDD'.padStart(6)} | ${'PnL'.padStart(9)} | Exit Reasons`);
  console.log('─'.repeat(115));

  const results: { trail: string; roi: number; line: string }[] = [];

  for (const mult of TRAIL_VALUES) {
    const cfg = { ...rFastCfg, name: `rt-${mult}`, feedId: SOL_FEED_ID, reversionTrailMultiple: mult };
    const r = run(cfg, ticks);
    const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`;
    const pnl = `${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(3)}`;
    const reasons = Object.entries(r.exitReasons).map(([k, v]) => `${k}:${v}`).join(' ');
    const line = `${String(mult).padEnd(7)} | ${roi.padStart(9)} | ${String(r.trades).padStart(6)} | ${r.wr.toFixed(1).padStart(5)} | ${r.pf.toFixed(2).padStart(5)} | ${r.sharpe.toFixed(3).padStart(7)} | ${r.maxDd.toFixed(1).padStart(5)}% | ${pnl.padStart(9)} | ${reasons}`;
    results.push({ trail: String(mult), roi: r.roi, line });
  }

  // Also test no-trail
  const noTrailCfg = { ...rFastCfg, name: 'none', feedId: SOL_FEED_ID, trailDelaySeconds: 999999 };
  const nr = run(noTrailCfg, ticks);
  const nrRoi = `${nr.roi >= 0 ? '+' : ''}${nr.roi.toFixed(1)}%`;
  const nrPnl = `${nr.pnl >= 0 ? '+' : ''}${nr.pnl.toFixed(3)}`;
  const nrReasons = Object.entries(nr.exitReasons).map(([k, v]) => `${k}:${v}`).join(' ');
  results.push({ trail: 'none', roi: nr.roi, line: `${'none'.padEnd(7)} | ${nrRoi.padStart(9)} | ${String(nr.trades).padStart(6)} | ${nr.wr.toFixed(1).padStart(5)} | ${nr.pf.toFixed(2).padStart(5)} | ${nr.sharpe.toFixed(3).padStart(7)} | ${nr.maxDd.toFixed(1).padStart(5)}% | ${nrPnl.padStart(9)} | ${nrReasons}` });

  for (const r of results) console.log(r.line);

  const best = results.reduce((a, b) => a.roi > b.roi ? a : b);
  console.log(`\n  ★ Best: reversionTrailMultiple = ${best.trail} (${best.roi >= 0 ? '+' : ''}${best.roi.toFixed(1)}% ROI)`);
}

// SOL 90d
try {
  const sol90 = loadTicks(new URL('../data/history-90d.jsonl', import.meta.url).pathname, SOL_FEED_ID);
  if (sol90.length > 100) gridSearch('SOL 90d', sol90);
} catch { console.log('No SOL 90d data'); }

// SOL 2y
try {
  const sol2y = loadTicks(new URL('../data/history-2y.jsonl', import.meta.url).pathname, SOL_FEED_ID);
  if (sol2y.length > 100) gridSearch('SOL 2y', sol2y);
} catch { console.log('No SOL 2y data'); }

// HYPE
try {
  const hype = loadTicks(new URL('../data/hype-history.jsonl', import.meta.url).pathname, SOL_FEED_ID);
  if (hype.length > 100) gridSearch('HYPE', hype);
} catch { console.log('No HYPE data'); }
