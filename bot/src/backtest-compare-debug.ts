/**
 * Debug: show what R-fast saw around the trade entry time.
 * Compare 1-min candle prices vs what the live bot saw.
 */

import type { Tick } from './feed.js';
import { SOL_FEED_ID } from './feed.js';
import { STRATEGIES } from './strategies.js';
import { RegimeStrategy } from './regime.js';
import { BankrollManager } from './bankroll.js';

const WARMUP_START = Math.floor(new Date('2026-03-05T10:00:00Z').getTime() / 1000);
const NOW = Math.floor(Date.now() / 1000);
const BALANCE_SOL = 27.51 / 89;
const LEVERAGE = 10;

// The live entry happened at 2026-03-06T07:26:45Z at $88.67
const ENTRY_TIME = Math.floor(new Date('2026-03-06T07:26:45Z').getTime() / 1000);
const EXIT_TIME = Math.floor(new Date('2026-03-06T08:30:13Z').getTime() / 1000);

async function fetchPythCandles(from: number, to: number): Promise<Tick[]> {
  const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.SOL/USD&resolution=1&from=${from}&to=${to}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Pyth API error: ${resp.status}`);
  const data = await resp.json() as { s: string; t: number[]; c: number[]; h: number[]; l: number[]; o: number[] };
  if (data.s !== 'ok') throw new Error(`Pyth returned: ${data.s}`);

  const ticks: Tick[] = [];
  // Print OHLC around the trade entry
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  1-MIN CANDLES AROUND R-FAST ENTRY (07:26:45 UTC)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Time              Open      High      Low       Close');
  console.log('  ─────────────────────────────────────────────────────────');

  for (let i = 0; i < data.t.length; i++) {
    ticks.push({ feedId: SOL_FEED_ID, price: data.c[i], publishTime: data.t[i] });

    // Print candles around the entry/exit times
    const ts = data.t[i];
    const showEntry = ts >= ENTRY_TIME - 30 * 60 && ts <= ENTRY_TIME + 10 * 60;
    const showExit = ts >= EXIT_TIME - 5 * 60 && ts <= EXIT_TIME + 5 * 60;
    if (showEntry || showExit) {
      const time = new Date(ts * 1000).toISOString().slice(11, 19);
      const marker = ts === Math.floor(ENTRY_TIME / 60) * 60 ? ' ← ENTRY' :
                     ts === Math.floor(EXIT_TIME / 60) * 60 ? ' ← EXIT' : '';
      const o = data.o?.[i]?.toFixed(2) ?? '?';
      const h = data.h?.[i]?.toFixed(2) ?? '?';
      const l = data.l?.[i]?.toFixed(2) ?? '?';
      const c = data.c[i].toFixed(2);
      console.log(`  ${time}  ${o.padStart(9)}  ${h.padStart(9)}  ${l.padStart(9)}  ${c.padStart(9)}${marker}`);
    }
  }

  return ticks;
}

async function main() {
  const ticks = await fetchPythCandles(WARMUP_START, NOW);
  console.log('');

  // Run R-fast and capture its thinking at the entry time
  const config = STRATEGIES.find(s => s.name === 'R-fast')!;
  const bankroll = new BankrollManager({ mode: 'paper', initialEquitySol: BALANCE_SOL });
  const strategy = new RegimeStrategy(config as any);
  if (strategy.setBankroll) strategy.setBankroll(bankroll);

  // Patch enter for leverage
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
  };

  // Run and capture state around entry time
  const origLog = console.log;
  console.log = () => {};

  let printedState = false;
  for (const tick of ticks) {
    bankroll.updateSolPrice(tick.price);
    strategy.onTick(tick);

    // Print strategy state right around the live entry time
    if (!printedState && tick.publishTime >= ENTRY_TIME - 60 && tick.publishTime <= ENTRY_TIME + 60) {
      console.log = origLog;
      const thinking = strategy.getThinking();
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('  R-FAST BACKTEST STATE @ ENTRY TIME');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log(`  Price: $${tick.price.toFixed(2)} at ${new Date(tick.publishTime * 1000).toISOString()}`);
      console.log(`  Status: ${thinking.status}`);
      console.log(`  Regime: ${thinking.regime}`);
      console.log(`  ATR%: ${thinking['ATR%']}`);
      if (thinking.deviation) console.log(`  Deviation: ${thinking.deviation}`);
      if (thinking.mean) console.log(`  Mean: ${thinking.mean}`);
      if (thinking.signal) console.log(`  Signal: ${thinking.signal}`);
      const levels = thinking._levels as any;
      if (levels) {
        console.log(`  Levels:`);
        console.log(`    Mean: $${levels.mean?.toFixed(2) ?? '?'}`);
        console.log(`    Entry Long: $${levels.entryLong?.toFixed(2) ?? '?'}`);
        console.log(`    Entry Short: $${levels.entryShort?.toFixed(2) ?? '?'}`);
      }
      console.log('');
      console.log('  Live bot entered SHORT @ $88.67 here.');
      console.log('  Backtest price at this tick: $' + tick.price.toFixed(4));
      console.log('  Did backtest enter? ' + (strategy as any).paper.inPosition);
      printedState = true;
      console.log = () => {};
    }
  }

  console.log = origLog;

  // Final metrics
  const metrics = strategy.getMetrics();
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  R-FAST FINAL BACKTEST METRICS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Trades: ${metrics.totalTrades} | W: ${metrics.wins} | L: ${metrics.losses}`);
  console.log(`  PnL: ${metrics.netPnlSol >= 0 ? '+' : ''}${metrics.netPnlSol.toFixed(6)} SOL`);
  console.log(`  Win Rate: ${metrics.winRate.toFixed(0)}%`);
  console.log('');
}

main().catch(console.error);
