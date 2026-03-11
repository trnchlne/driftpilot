/**
 * Validate top R-base trending configs against 30d data.
 * Tests current config + top 3 candidates from grid search.
 *
 * Usage: npx tsx src/backtest-validate.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import type { StrategyConfig } from './strategies.js';
import { STRATEGIES } from './strategies.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';

const BALANCE_USDC = 20;
const SOL_PRICE_APPROX = 87;
const BALANCE_SOL = BALANCE_USDC / SOL_PRICE_APPROX;
const LEVERAGE = 10;

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

interface TradeRecord {
  direction: string;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  holdSec: number;
  pnlSol: number;
  reason: string;
  regime: string;
}

function runConfig(
  label: string,
  ticks: Tick[],
  overrides: Partial<StrategyConfig & { type: 'regime' }>,
): { label: string; trades: TradeRecord[]; finalEquity: number; peakEquity: number; maxDdPct: number } {
  const baseConfig = STRATEGIES.find(s => s.name === 'R-base')! as StrategyConfig & { type: 'regime' };
  const config = { ...baseConfig, ...overrides, name: label };

  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: BALANCE_SOL });
  const strategy = new RegimeStrategy(config as any);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  const trades: TradeRecord[] = [];
  let peakEquity = BALANCE_SOL;
  let maxDdPct = 0;

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
    this.bankroll?.reserveCapital(betSize);
    this.paper.openPaper(direction, price, betSize * LEVERAGE, feeRate, now);
    this.paper.saveEntryRegime(regime);
  };

  (strategy as any).exit = function(price: number, now: number, feeRate: number, reason: string) {
    if (!this.paper.inPosition) return;
    const regime = this.entryRegime;
    const trade = this.paper.closePaper(price, feeRate, now);
    if (!trade) return;
    const margin = trade.sizeSol / LEVERAGE;
    this.bankroll?.releaseCapital(margin);
    this.bankroll?.recordPnl(trade.netPnlSol);
    this.lastTradeInfo = {
      direction: trade.direction, entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice, holdSec: now - this.entryTickTime,
      netPnl: trade.netPnlSol, reason, atrAtExit: this.atrPct, trailPctAtExit: 0,
    };

    trades.push({
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      entryTime: trade.entryTime,
      exitTime: trade.exitTime,
      holdSec: trade.exitTime - trade.entryTime,
      pnlSol: trade.netPnlSol,
      reason,
      regime: regime ?? '?',
    });
  };

  const origLog = console.log;
  console.log = () => {};

  for (const tick of ticks) {
    bankroll.updateSolPrice(tick.price);
    strategy.onTick(tick);
    const eq = bankroll.getEquity();
    if (eq > peakEquity) peakEquity = eq;
    const dd = peakEquity > 0 ? ((peakEquity - eq) / peakEquity) * 100 : 0;
    if (dd > maxDdPct) maxDdPct = dd;
  }

  console.log = origLog;
  strategy.stop();

  return { label, trades, finalEquity: bankroll.getEquity(), peakEquity, maxDdPct };
}

function printResult(
  r: ReturnType<typeof runConfig>,
  hours: number,
  lastPrice: number,
  showTrades: boolean,
) {
  const { label, trades, finalEquity, peakEquity, maxDdPct } = r;
  const totalPnl = finalEquity - BALANCE_SOL;
  const roiPct = ((finalEquity / BALANCE_SOL) - 1) * 100;
  const wins = trades.filter(t => t.pnlSol > 0).length;
  const losses = trades.length - wins;
  const wr = trades.length > 0 ? (wins / trades.length * 100) : 0;
  const grossWin = trades.filter(t => t.pnlSol > 0).reduce((s, t) => s + t.pnlSol, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnlSol <= 0).reduce((s, t) => s + t.pnlSol, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdSec, 0) / trades.length / 60 : 0;

  console.log(`  ${label}`);
  console.log(`  Trades: ${trades.length} (${wins}W/${losses}L) | WR: ${wr.toFixed(1)}% | PF: ${pf.toFixed(2)} | ROI: ${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(1)}% | MaxDD: ${maxDdPct.toFixed(1)}% | AvgHold: ${avgHold.toFixed(0)}m | T/Day: ${(trades.length / (hours / 24)).toFixed(1)}`);
  console.log(`  PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(6)} SOL (${totalPnl >= 0 ? '+' : ''}$${(totalPnl * lastPrice).toFixed(2)})`);

  // Regime breakdown
  const regimes = [...new Set(trades.map(t => t.regime))];
  for (const regime of regimes) {
    const rt = trades.filter(t => t.regime === regime);
    const rw = rt.filter(t => t.pnlSol > 0).length;
    const rp = rt.reduce((s, t) => s + t.pnlSol, 0);
    console.log(`    [${regime}] ${rt.length}t (${rw}W/${rt.length - rw}L, ${rt.length > 0 ? (rw / rt.length * 100).toFixed(0) : 0}% WR) | ${rp >= 0 ? '+' : ''}${rp.toFixed(6)} SOL`);
  }

  // Direction breakdown
  for (const dir of ['long', 'short']) {
    const dt = trades.filter(t => t.direction === dir);
    if (dt.length === 0) continue;
    const dw = dt.filter(t => t.pnlSol > 0).length;
    const dp = dt.reduce((s, t) => s + t.pnlSol, 0);
    console.log(`    ${dir.toUpperCase()}: ${dt.length}t (${dw}W, ${(dw / dt.length * 100).toFixed(0)}% WR) | ${dp >= 0 ? '+' : ''}${dp.toFixed(6)} SOL`);
  }

  if (showTrades) {
    console.log('');
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      const entryDate = new Date(t.entryTime * 1000).toISOString().replace('T', ' ').slice(0, 16);
      const sign = t.pnlSol >= 0 ? '+' : '';
      const holdMin = (t.holdSec / 60).toFixed(0);
      const movePct = ((t.exitPrice / t.entryPrice) - 1) * 100;
      const favPct = t.direction === 'long' ? movePct : -movePct;
      const roe = favPct * LEVERAGE;
      console.log(`    #${String(i + 1).padStart(2)} ${t.direction.toUpperCase().padEnd(5)} [${t.regime.padEnd(9)}] $${t.entryPrice.toFixed(2)} → $${t.exitPrice.toFixed(2)} | ${sign}${t.pnlSol.toFixed(6)} SOL | ROE ${roe >= 0 ? '+' : ''}${roe.toFixed(1)}% | ${holdMin}m | ${t.reason} | ${entryDate}`);
    }
  }

  console.log('');
}

function main() {
  // Test configs
  const configs: { label: string; overrides: Partial<StrategyConfig & { type: 'regime' }> }[] = [
    {
      label: 'CURRENT (trail=0.8 sig=4.5 win=25m)',
      overrides: {},  // no overrides = current config
    },
    {
      label: 'CANDIDATE A: trail=2.5 sig=4.0 win=40m (highest ROI)',
      overrides: { trailingAtrMultiple: 2.5, signalMultiple: 4.0, signalWindowSeconds: 40 * 60 } as any,
    },
    {
      label: 'CANDIDATE B: trail=1.2 sig=4.5 win=40m (best risk-adj)',
      overrides: { trailingAtrMultiple: 1.2, signalMultiple: 4.5, signalWindowSeconds: 40 * 60 } as any,
    },
    {
      label: 'CANDIDATE C: trail=1.5 sig=4.5 win=40m (balanced)',
      overrides: { trailingAtrMultiple: 1.5, signalMultiple: 4.5, signalWindowSeconds: 40 * 60 } as any,
    },
    {
      label: 'CANDIDATE D: trail=1.0 sig=3.5 win=20m (most trades)',
      overrides: { trailingAtrMultiple: 1.0, signalMultiple: 3.5, signalWindowSeconds: 20 * 60 } as any,
    },
    {
      label: 'CANDIDATE E: trail=2.0 sig=4.0 win=40m (wide trail moderate)',
      overrides: { trailingAtrMultiple: 2.0, signalMultiple: 4.0, signalWindowSeconds: 40 * 60 } as any,
    },
  ];

  // Run on both datasets
  for (const dataFile of ['data/history-14d.jsonl', 'data/history-30d.jsonl']) {
    const dataPath = resolve(dataFile);
    console.log(`Loading ${dataFile}...`);
    const ticks = loadTicks(dataPath);
    const hours = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 3600;
    const firstPrice = ticks[0].price;
    const lastPrice = ticks[ticks.length - 1].price;
    const firstDate = new Date(ticks[0].publishTime * 1000).toISOString().slice(0, 10);
    const lastDate = new Date(ticks[ticks.length - 1].publishTime * 1000).toISOString().slice(0, 10);

    console.log('');
    console.log('═'.repeat(120));
    console.log(`  ${dataFile.toUpperCase()} — ${ticks.length} ticks, ${(hours / 24).toFixed(0)} days (${firstDate} → ${lastDate})`);
    console.log(`  SOL: $${firstPrice.toFixed(2)} → $${lastPrice.toFixed(2)} (${((lastPrice / firstPrice - 1) * 100).toFixed(1)}%)`);
    console.log('═'.repeat(120));
    console.log('');

    for (const c of configs) {
      const result = runConfig(c.label, ticks, c.overrides);
      printResult(result, hours, lastPrice, dataFile.includes('14d'));
    }
  }
}

main();
