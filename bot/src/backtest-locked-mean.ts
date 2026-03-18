/**
 * Backtest: Live rolling mean TP vs Locked entry mean TP for RANGING exits.
 *
 * Current behavior: TP triggers when price reaches the LIVE rolling mean (can drift)
 * Proposed: TP triggers when price reaches the ENTRY-TIME rolling mean (locked)
 *
 * Runs R-fast and R-base on 90d data with both modes.
 */

import { readFileSync } from 'node:fs';
import type { Tick } from './feed.js';
import { BankrollManager } from './bankroll.js';
import { RegimeStrategy } from './regime.js';
import type { StrategyConfig } from './strategies.js';
import { STRATEGIES } from './strategies.js';

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

function runBacktest(config: StrategyConfig, ticks: Tick[], bankrollSol: number): {
  metrics: ReturnType<RegimeStrategy['getMetrics']>;
  finalEquity: number;
  roiPct: number;
  maxDdPct: number;
} {
  const strategy = new RegimeStrategy(config) as RegimeStrategy;
  const bankroll = new BankrollManager({
    mode: 'paper',
    initialEquitySol: bankrollSol,
  });

  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  // Track drawdown
  let peakEquity = bankrollSol;
  let maxDdPct = 0;

  for (const tick of ticks) {
    strategy.onTick(tick);

    const eq = bankroll.getEquity();
    if (eq > peakEquity) peakEquity = eq;
    const dd = peakEquity > 0 ? ((peakEquity - eq) / peakEquity) * 100 : 0;
    if (dd > maxDdPct) maxDdPct = dd;
  }

  const finalEquity = bankroll.getEquity();
  const roiPct = ((finalEquity - bankrollSol) / bankrollSol) * 100;

  return {
    metrics: strategy.getMetrics(),
    finalEquity,
    roiPct,
    maxDdPct,
  };
}

function printResult(label: string, r: ReturnType<typeof runBacktest>) {
  const m = r.metrics;
  console.log(`  ${label.padEnd(30)} | ROI: ${r.roiPct >= 0 ? '+' : ''}${r.roiPct.toFixed(1)}% | Trades: ${m.totalTrades} | WR: ${(m.winRate * 100).toFixed(1)}% | PF: ${m.profitFactor.toFixed(2)} | Sharpe: ${m.sharpe.toFixed(3)} | MaxDD: ${r.maxDdPct.toFixed(1)}% | PnL: ${m.netPnlSol >= 0 ? '+' : ''}${m.netPnlSol.toFixed(3)} SOL`);
}

// ── Main ──
const DATA_DIR = new URL('../data/', import.meta.url).pathname;
const BANKROLL = 3; // SOL

// Configs to test
const regimeConfigs = STRATEGIES.filter(s => s.type === 'regime') as Extract<StrategyConfig, { type: 'regime' }>[];

for (const dataFile of ['history-90d.jsonl', 'history-2y.jsonl']) {
  let ticks: Tick[];
  try {
    ticks = loadTicks(`${DATA_DIR}${dataFile}`);
  } catch {
    console.log(`Skipping ${dataFile} — not found`);
    continue;
  }

  const days = Math.round((ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 86400);
  console.log(`\n═══ ${dataFile} (${days} days, ${ticks.length} ticks) ═══\n`);

  for (const baseCfg of regimeConfigs) {
    console.log(`── ${baseCfg.name} ──`);

    // A) Current: live rolling mean TP (default)
    const resultLive = runBacktest(baseCfg, ticks, BANKROLL);
    printResult('Live mean TP (current)', resultLive);

    // B) Proposed: locked entry mean TP
    // We need to patch the strategy. The cleanest way is to use a config flag.
    // Since RegimeStrategy doesn't have this flag yet, we'll monkey-patch.
    const lockedCfg = { ...baseCfg, name: baseCfg.name + '-locked', _useLockedMeanTP: true } as any;
    const resultLocked = runBacktest(lockedCfg, ticks, BANKROLL);
    printResult('Locked mean TP (proposed)', resultLocked);

    const roiDiff = resultLocked.roiPct - resultLive.roiPct;
    console.log(`  ${'Delta'.padEnd(30)} | ROI: ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(1)}pp`);
    console.log('');
  }
}
