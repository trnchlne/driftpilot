/**
 * Focused 14-day backtest for R-base only.
 * Uses pre-fetched data from data/history-14d.jsonl.
 * Shows trade-by-trade detail + summary metrics.
 *
 * Usage: npx tsx src/backtest-rbase-14d.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import { STRATEGIES } from './strategies.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';

/* ─── Config ─────────────────────────────────────────────── */

// Match live bot: R-base on sub 0, ~$20 USDC balance, 10x leverage, 30% Kelly
const BALANCE_USDC = 20;
const SOL_PRICE_APPROX = 87;
const BALANCE_SOL = BALANCE_USDC / SOL_PRICE_APPROX;
const LEVERAGE = 10;

/* ─── Load Data ──────────────────────────────────────────── */

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

/* ─── Run Strategy ───────────────────────────────────────── */

interface TradeRecord {
  direction: string;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  holdSec: number;
  pnlSol: number;
  sizeSol: number;
  reason: string;
  bestPrice: number;
  regime: string;
}

function runRBase(ticks: Tick[]): { trades: TradeRecord[]; finalEquity: number; peakEquity: number } {
  const config = STRATEGIES.find(s => s.name === 'R-base');
  if (!config) throw new Error('R-base config not found');

  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: BALANCE_SOL });
  const strategy = new RegimeStrategy(config as any);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  const trades: TradeRecord[] = [];
  let peakEquity = BALANCE_SOL;

  // Patch enter for leveraged sizing (same as live.ts)
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

  // Patch exit for leveraged sizing
  (strategy as any).exit = function(price: number, now: number, feeRate: number, reason: string) {
    if (!this.paper.inPosition) return;
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
      sizeSol: trade.sizeSol,
      reason,
      bestPrice: this.bestPriceSinceEntry ?? trade.entryPrice,
      regime: this.entryRegime ?? '?',
    });
  };

  // Suppress console noise
  const origLog = console.log;
  console.log = () => {};

  for (const tick of ticks) {
    bankroll.updateSolPrice(tick.price);
    strategy.onTick(tick);
    const eq = bankroll.getEquity();
    if (eq > peakEquity) peakEquity = eq;
  }

  console.log = origLog;

  return { trades, finalEquity: bankroll.getEquity(), peakEquity };
}

/* ─── Main ───────────────────────────────────────────────── */

function main() {
  const dataPath = resolve('data/history-14d.jsonl');
  console.log(`[backtest] Loading ${dataPath}...`);
  const ticks = loadTicks(dataPath);

  if (ticks.length === 0) { console.error('No ticks'); process.exit(1); }

  const firstPrice = ticks[0].price;
  const lastPrice = ticks[ticks.length - 1].price;
  const hours = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 3600;
  const firstDate = new Date(ticks[0].publishTime * 1000).toISOString().slice(0, 16);
  const lastDate = new Date(ticks[ticks.length - 1].publishTime * 1000).toISOString().slice(0, 16);

  console.log(`[data] ${ticks.length} ticks over ${hours.toFixed(1)}h (${(hours / 24).toFixed(1)} days)`);
  console.log(`[data] SOL: $${firstPrice.toFixed(2)} → $${lastPrice.toFixed(2)} (${((lastPrice / firstPrice - 1) * 100).toFixed(1)}%)`);
  console.log(`[data] Period: ${firstDate} → ${lastDate} UTC`);
  console.log(`[data] Simulated balance: ${BALANCE_SOL.toFixed(4)} SOL (~$${BALANCE_USDC}), 10x leverage, 30% Kelly`);
  console.log('');

  const { trades, finalEquity, peakEquity } = runRBase(ticks);

  console.log('═'.repeat(100));
  console.log('  R-base — 14-DAY PAPER BACKTEST TRADES');
  console.log('═'.repeat(100));

  if (trades.length === 0) {
    console.log('  No trades taken.');
  } else {
    let totalPnl = 0;
    let wins = 0;
    let losses = 0;
    let grossWin = 0;
    let grossLoss = 0;

    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      const entryDate = new Date(t.entryTime * 1000).toISOString().replace('T', ' ').slice(0, 19);
      const exitDate = new Date(t.exitTime * 1000).toISOString().replace('T', ' ').slice(0, 19);
      const holdMin = (t.holdSec / 60).toFixed(0);
      const sign = t.pnlSol >= 0 ? '+' : '';
      const pnlUsd = t.pnlSol * t.exitPrice;
      const pnlUsdSign = pnlUsd >= 0 ? '+' : '';
      const movePct = ((t.exitPrice / t.entryPrice) - 1) * 100;
      const favPct = t.direction === 'long' ? movePct : -movePct;
      const roe = favPct * LEVERAGE;

      totalPnl += t.pnlSol;
      if (t.pnlSol > 0) { wins++; grossWin += t.pnlSol; }
      else { losses++; grossLoss += Math.abs(t.pnlSol); }

      console.log(`  #${String(i + 1).padStart(2)} ${t.direction.toUpperCase().padEnd(5)} [${t.regime}] $${t.entryPrice.toFixed(2)} → $${t.exitPrice.toFixed(2)} (best $${t.bestPrice.toFixed(2)}) | ${sign}${t.pnlSol.toFixed(6)} SOL (${pnlUsdSign}$${Math.abs(pnlUsd).toFixed(4)}) | ROE ${roe >= 0 ? '+' : ''}${roe.toFixed(1)}% | ${holdMin}m | ${t.reason}`);
      console.log(`       entry: ${entryDate}  exit: ${exitDate}`);
    }

    console.log('');
    console.log('─'.repeat(100));
    const sign = totalPnl >= 0 ? '+' : '';
    const roiPct = ((finalEquity / BALANCE_SOL) - 1) * 100;
    const maxDd = ((peakEquity - finalEquity) / peakEquity * 100);
    const wr = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : '0';
    const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : grossWin > 0 ? 'Inf' : '0';
    const avgHold = trades.reduce((s, t) => s + t.holdSec, 0) / trades.length;

    console.log(`  SUMMARY`);
    console.log(`  Trades:      ${trades.length} (${wins}W / ${losses}L)`);
    console.log(`  Win Rate:    ${wr}%`);
    console.log(`  Profit Factor: ${pf}`);
    console.log(`  Net PnL:     ${sign}${totalPnl.toFixed(6)} SOL (${sign}$${(totalPnl * lastPrice).toFixed(2)})`);
    console.log(`  Equity:      ${BALANCE_SOL.toFixed(4)} → ${finalEquity.toFixed(4)} SOL (${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(1)}% ROI)`);
    console.log(`  Peak Equity: ${peakEquity.toFixed(4)} SOL`);
    console.log(`  Avg Hold:    ${(avgHold / 60).toFixed(0)} min`);
    console.log(`  Trades/Day:  ${(trades.length / (hours / 24)).toFixed(1)}`);
    console.log('');

    // Breakdown by regime
    const regimes = [...new Set(trades.map(t => t.regime))];
    for (const regime of regimes) {
      const rt = trades.filter(t => t.regime === regime);
      const rWins = rt.filter(t => t.pnlSol > 0).length;
      const rPnl = rt.reduce((s, t) => s + t.pnlSol, 0);
      const rsign = rPnl >= 0 ? '+' : '';
      console.log(`  [${regime}] ${rt.length} trades (${rWins}W/${rt.length - rWins}L, ${(rWins / rt.length * 100).toFixed(0)}% WR) | ${rsign}${rPnl.toFixed(6)} SOL`);
    }

    // Breakdown by direction
    console.log('');
    for (const dir of ['long', 'short']) {
      const dt = trades.filter(t => t.direction === dir);
      if (dt.length === 0) continue;
      const dWins = dt.filter(t => t.pnlSol > 0).length;
      const dPnl = dt.reduce((s, t) => s + t.pnlSol, 0);
      const dsign = dPnl >= 0 ? '+' : '';
      console.log(`  ${dir.toUpperCase()} trades: ${dt.length} (${dWins}W/${dt.length - dWins}L, ${(dWins / dt.length * 100).toFixed(0)}% WR) | ${dsign}${dPnl.toFixed(6)} SOL`);
    }

    // Breakdown by exit reason
    console.log('');
    const reasons = [...new Set(trades.map(t => t.reason))];
    for (const reason of reasons) {
      const rt = trades.filter(t => t.reason === reason);
      const rPnl = rt.reduce((s, t) => s + t.pnlSol, 0);
      const rsign = rPnl >= 0 ? '+' : '';
      console.log(`  Exit [${reason}]: ${rt.length} trades | ${rsign}${rPnl.toFixed(6)} SOL`);
    }
  }

  console.log('');
}

main();
