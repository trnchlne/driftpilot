/**
 * Quick test of key configs on fresh 14d data.
 * Usage: npx tsx src/backtest-fresh14d.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import type { StrategyConfig } from './strategies.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';

const BALANCE_USDC = 20;
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

interface ParamSet {
  atrPeriod: number; regimeWindowSeconds: number; trendThreshold: number; rangeThreshold: number;
  signalWindowSeconds: number; signalMultiple: number; trailingAtrMultiple: number; slAtrMultiple: number;
  trailDelaySeconds: number; meanWindowSeconds: number; entryBandMultiple: number; reversionSlMultiple: number;
  cooldownSeconds: number; minAtrPct: number; uncertainMultiple: number;
}

interface TradeRecord {
  direction: string; entryPrice: number; exitPrice: number; entryTime: number; exitTime: number;
  holdSec: number; pnlSol: number; reason: string; regime: string; bestPrice: number;
}

function runConfig(ticks: Tick[], p: ParamSet, balanceSol: number): {
  trades: TradeRecord[]; finalEquity: number; peakEquity: number; maxDdPct: number;
} {
  const config = {
    type: 'regime' as const, name: 'test',
    atrPeriod: p.atrPeriod, regimeWindowSeconds: p.regimeWindowSeconds,
    trendThreshold: p.trendThreshold, rangeThreshold: p.rangeThreshold,
    signalWindowSeconds: p.signalWindowSeconds, signalMultiple: p.signalMultiple,
    trailingAtrMultiple: p.trailingAtrMultiple, slAtrMultiple: p.slAtrMultiple,
    trailDelaySeconds: p.trailDelaySeconds, meanWindowSeconds: p.meanWindowSeconds,
    entryBandMultiple: p.entryBandMultiple, reversionSlMultiple: p.reversionSlMultiple,
    cooldownSeconds: p.cooldownSeconds, betSizeSol: 1.0,
    minAtrPct: p.minAtrPct, uncertainMultiple: p.uncertainMultiple,
  };

  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: balanceSol });
  const strategy = new RegimeStrategy(config as any);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  const trades: TradeRecord[] = [];
  let peakEquity = balanceSol;
  let maxDdPct = 0;

  (strategy as any).enter = function(direction: any, price: number, now: number, regime: any, feeRate: number) {
    const betSize = this.getBetSize();
    if (betSize <= 0) return;
    this.entryPrice = price; this.entryDirection = direction; this.entryTickTime = now;
    this.entryRegime = regime; this.bestPriceSinceEntry = price;
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
    const best = this.bestPriceSinceEntry ?? price;
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
      direction: trade.direction, entryPrice: trade.entryPrice, exitPrice: trade.exitPrice,
      entryTime: trade.entryTime, exitTime: trade.exitTime,
      holdSec: trade.exitTime - trade.entryTime, pnlSol: trade.netPnlSol,
      reason, regime: regime ?? '?', bestPrice: best,
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

  return { trades, finalEquity: bankroll.getEquity(), peakEquity, maxDdPct };
}

function fmtTime(sec: number): string {
  if (sec >= 86400) return `${(sec / 86400).toFixed(0)}d`;
  if (sec >= 3600) return `${(sec / 3600).toFixed(0)}h`;
  return `${(sec / 60).toFixed(0)}m`;
}

function main() {
  const ticks = loadTicks(resolve('data/history-14d.jsonl'));
  const hours = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 3600;
  const firstPrice = ticks[0].price;
  const lastPrice = ticks[ticks.length - 1].price;
  const midPrice = ticks[Math.floor(ticks.length / 2)].price;
  const balanceSol = BALANCE_USDC / midPrice;

  console.log(`Fresh 14d data: ${ticks.length} ticks, ${(hours / 24).toFixed(1)} days`);
  console.log(`SOL: $${firstPrice.toFixed(2)} → $${lastPrice.toFixed(2)} (${((lastPrice / firstPrice - 1) * 100).toFixed(1)}%)`);
  console.log(`Period: ${new Date(ticks[0].publishTime * 1000).toISOString().slice(0, 10)} → ${new Date(ticks[ticks.length - 1].publishTime * 1000).toISOString().slice(0, 10)}`);
  console.log(`Balance: ${balanceSol.toFixed(4)} SOL (~$${BALANCE_USDC}), 10x leverage\n`);

  const configs: { label: string; params: ParamSet }[] = [
    { label: 'R-base (new)', params: {
      atrPeriod: 90, regimeWindowSeconds: 4*3600, trendThreshold: 1.2, rangeThreshold: 1.0,
      signalWindowSeconds: 40*60, signalMultiple: 4.5, trailingAtrMultiple: 1.5, slAtrMultiple: 1.0,
      trailDelaySeconds: 300, meanWindowSeconds: 1*3600, entryBandMultiple: 2.5, reversionSlMultiple: 4.0,
      cooldownSeconds: 120, minAtrPct: 0.035, uncertainMultiple: 1.0,
    }},
    { label: 'R-base (old)', params: {
      atrPeriod: 90, regimeWindowSeconds: 4*3600, trendThreshold: 1.2, rangeThreshold: 1.0,
      signalWindowSeconds: 25*60, signalMultiple: 4.5, trailingAtrMultiple: 0.8, slAtrMultiple: 1.0,
      trailDelaySeconds: 300, meanWindowSeconds: 1*3600, entryBandMultiple: 2.5, reversionSlMultiple: 4.0,
      cooldownSeconds: 120, minAtrPct: 0.035, uncertainMultiple: 1.0,
    }},
    { label: 'R-fast', params: {
      atrPeriod: 30, regimeWindowSeconds: 4*3600, trendThreshold: 1.5, rangeThreshold: 0.5,
      signalWindowSeconds: 20*60, signalMultiple: 5.0, trailingAtrMultiple: 1.5, slAtrMultiple: 2.5,
      trailDelaySeconds: 300, meanWindowSeconds: 2*3600, entryBandMultiple: 1.5, reversionSlMultiple: 3.0,
      cooldownSeconds: 120, minAtrPct: 0.035, uncertainMultiple: 1.0,
    }},
    { label: 'TOP-3 (90d winner)', params: {
      atrPeriod: 90, regimeWindowSeconds: 4*3600, trendThreshold: 3.0, rangeThreshold: 2.0,
      signalWindowSeconds: 60*60, signalMultiple: 5.5, trailingAtrMultiple: 2.5, slAtrMultiple: 0.5,
      trailDelaySeconds: 180, meanWindowSeconds: 8*3600, entryBandMultiple: 1.0, reversionSlMultiple: 1.5,
      cooldownSeconds: 120, minAtrPct: 0.05, uncertainMultiple: 0.5,
    }},
    { label: 'TOP-6 (best Sharpe)', params: {
      atrPeriod: 120, regimeWindowSeconds: 30*60, trendThreshold: 1.0, rangeThreshold: 1.2,
      signalWindowSeconds: 2*3600, signalMultiple: 6.0, trailingAtrMultiple: 1.5, slAtrMultiple: 3.0,
      trailDelaySeconds: 60, meanWindowSeconds: 10*60, entryBandMultiple: 1.5, reversionSlMultiple: 4.0,
      cooldownSeconds: 900, minAtrPct: 0.08, uncertainMultiple: 1.5,
    }},
  ];

  // Run each and show trade-by-trade
  for (const c of configs) {
    const { trades, finalEquity, peakEquity, maxDdPct } = runConfig(ticks, c.params, balanceSol);
    const totalPnl = finalEquity - balanceSol;
    const roiPct = ((finalEquity / balanceSol) - 1) * 100;
    const wins = trades.filter(t => t.pnlSol > 0).length;
    const losses = trades.length - wins;
    const wr = trades.length > 0 ? (wins / trades.length * 100) : 0;
    const grossWin = trades.filter(t => t.pnlSol > 0).reduce((s, t) => s + t.pnlSol, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnlSol <= 0).reduce((s, t) => s + t.pnlSol, 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;

    const p = c.params;
    console.log('═'.repeat(120));
    console.log(`  ${c.label}`);
    console.log(`  atr=${p.atrPeriod}m reg=${fmtTime(p.regimeWindowSeconds)} tThr=${p.trendThreshold} rThr=${p.rangeThreshold} sig=${fmtTime(p.signalWindowSeconds)}×${p.signalMultiple} trail=${p.trailingAtrMultiple} sl=${p.slAtrMultiple} delay=${fmtTime(p.trailDelaySeconds)} mean=${fmtTime(p.meanWindowSeconds)} band=${p.entryBandMultiple} revSl=${p.reversionSlMultiple}`);
    console.log(`  ${trades.length} trades (${wins}W/${losses}L) | WR: ${wr.toFixed(1)}% | PF: ${pf.toFixed(2)} | ROI: ${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(1)}% | MaxDD: ${maxDdPct.toFixed(1)}% | PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(6)} SOL ($${(totalPnl * lastPrice).toFixed(2)})`);
    console.log('─'.repeat(120));

    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      const entryDate = new Date(t.entryTime * 1000).toISOString().replace('T', ' ').slice(0, 16);
      const sign = t.pnlSol >= 0 ? '+' : '';
      const holdMin = (t.holdSec / 60).toFixed(0);
      const movePct = ((t.exitPrice / t.entryPrice) - 1) * 100;
      const favPct = t.direction === 'long' ? movePct : -movePct;
      const roe = favPct * LEVERAGE;
      console.log(`  #${String(i + 1).padStart(2)} ${t.direction.toUpperCase().padEnd(5)} [${t.regime.padEnd(9)}] $${t.entryPrice.toFixed(2)} → $${t.exitPrice.toFixed(2)} (best $${t.bestPrice.toFixed(2)}) | ${sign}${t.pnlSol.toFixed(6)} SOL | ROE ${roe >= 0 ? '+' : ''}${roe.toFixed(1)}% | ${holdMin}m | ${t.reason} | ${entryDate}`);
    }

    // Regime breakdown
    const regimes = [...new Set(trades.map(t => t.regime))];
    console.log('');
    for (const regime of regimes) {
      const rt = trades.filter(t => t.regime === regime);
      const rw = rt.filter(t => t.pnlSol > 0).length;
      const rp = rt.reduce((s, t) => s + t.pnlSol, 0);
      console.log(`  [${regime}] ${rt.length}t (${rw}W/${rt.length - rw}L, ${rt.length > 0 ? (rw / rt.length * 100).toFixed(0) : 0}% WR) | ${rp >= 0 ? '+' : ''}${rp.toFixed(6)} SOL`);
    }
    for (const dir of ['long', 'short']) {
      const dt = trades.filter(t => t.direction === dir);
      if (dt.length === 0) continue;
      const dw = dt.filter(t => t.pnlSol > 0).length;
      const dp = dt.reduce((s, t) => s + t.pnlSol, 0);
      console.log(`  ${dir.toUpperCase()}: ${dt.length}t (${dw}W, ${(dw / dt.length * 100).toFixed(0)}% WR) | ${dp >= 0 ? '+' : ''}${dp.toFixed(6)} SOL`);
    }
    console.log('');
  }
}

main();
