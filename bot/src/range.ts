import { SOL_FEED_ID } from './feed.js';
import type { Tick } from './feed.js';
import type { BaseStrategy, PerformanceMetrics, Direction, PaperTrade } from './base-strategy.js';
import { PaperTrader } from './base-strategy.js';
import { dashboardBus } from './dashboard-bus.js';

const MAKER_FEE_RATE = 2 / 10_000; // 2 bps per side (limit orders)

interface PriceSample {
  time: number;
  price: number;
}

interface RangeConfig {
  name: string;
  lookbackSeconds: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  stopLossPct: number;
  minChannelPct: number;
  betSizeSol: number;
  maxHoldSeconds: number;
}

export class RangeStrategy implements BaseStrategy {
  readonly name: string;
  readonly type = 'range' as const;

  private readonly config: RangeConfig;
  private readonly paper: PaperTrader;
  private solBuffer: PriceSample[] = [];
  private lastSolPrice = 0;
  private entryDirection: Direction = 'long';
  private entryPrice = 0;
  private support = 0;
  private resistance = 0;
  private entryTickTime = 0;
  private lastExitReason = '';

  constructor(config: RangeConfig) {
    this.name = config.name;
    this.config = config;
    this.paper = new PaperTrader();

    this.paper.onTrade((trade: PaperTrade) => {
      dashboardBus.emitTrade({
        strategyName: this.name,
        type: 'range',
        direction: trade.direction,
        entry: trade.entryPrice,
        exit: trade.exitPrice,
        pnl: trade.netPnlSol,
        reason: this.lastExitReason,
        timestamp: trade.exitTime,
      });
    });
  }

  onTick(tick: Tick): void {
    if (tick.feedId !== SOL_FEED_ID) return;

    const now = tick.publishTime;

    // SOL tick
    this.lastSolPrice = tick.price;
    this.solBuffer.push({ time: now, price: tick.price });

    // Prune SOL buffer
    const cutoff = now - this.config.lookbackSeconds;
    while (this.solBuffer.length > 0 && this.solBuffer[0].time < cutoff) {
      this.solBuffer.shift();
    }

    // Check exit conditions if in position
    if (this.paper.inPosition) {
      if (tick.publishTime - this.entryTickTime >= this.config.maxHoldSeconds) {
        this.exit(tick.price, 'timeout');
        return;
      }
      this.checkExit(tick.price);
      return;
    }

    // Need enough data to compute channel
    if (this.solBuffer.length < 10) return;

    // Compute channel
    const prices = this.solBuffer.map(s => s.price);
    this.support = percentile(prices, 5);
    this.resistance = percentile(prices, 95);

    const channelWidth = this.resistance - this.support;
    const channelPct = this.support > 0 ? (channelWidth / this.support) * 100 : 0;

    // Skip if channel too narrow
    if (channelPct < this.config.minChannelPct) return;

    const channelPosition = channelWidth > 0
      ? (tick.price - this.support) / channelWidth
      : 0.5;

    // Entry logic
    if (channelPosition <= this.config.entryZoneLow) {
      this.enter('long', tick.price, tick.publishTime);
    } else if (channelPosition >= this.config.entryZoneHigh) {
      this.enter('short', tick.price, tick.publishTime);
    }
  }

  private enter(direction: Direction, price: number, tickTime: number): void {
    this.entryDirection = direction;
    this.entryPrice = price;
    this.entryTickTime = tickTime;

    console.log(
      `[${this.name}] ${direction.toUpperCase()} @ $${price.toFixed(2)} | ` +
      `channel $${this.support.toFixed(2)}-$${this.resistance.toFixed(2)} (PAPER)`,
    );

    this.paper.openPaper(direction, price, this.config.betSizeSol, MAKER_FEE_RATE);

    dashboardBus.emitEntry({
      strategyName: this.name, type: 'range', direction,
      price, size: this.config.betSizeSol, timestamp: Date.now(),
    });

  }

  private checkExit(price: number): void {
    // TP: opposite band
    if (this.entryDirection === 'long' && price >= this.resistance) {
      this.exit(price, 'TP');
      return;
    }
    if (this.entryDirection === 'short' && price <= this.support) {
      this.exit(price, 'TP');
      return;
    }

    // SL: fixed percentage
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const adverse = this.entryDirection === 'long' ? -movePct : movePct;
    if (adverse >= this.config.stopLossPct) {
      this.exit(price, 'SL');
    }
  }

  private exit(price: number, reason: string): void {
    this.lastExitReason = reason;
    const trade = this.paper.closePaper(price, MAKER_FEE_RATE);
    if (trade) {
      const sign = trade.netPnlSol >= 0 ? '+' : '';
      console.log(
        `[${this.name}] EXIT ${reason} | $${trade.entryPrice.toFixed(2)} → $${trade.exitPrice.toFixed(2)} | ` +
        `net ${sign}${trade.netPnlSol.toFixed(6)} SOL (PAPER)`,
      );
    }
  }

  getMetrics(): PerformanceMetrics {
    return this.paper.getMetrics();
  }

  getThinking(): Record<string, unknown> {
    const channelWidth = this.resistance - this.support;
    const channelPct = this.support > 0 ? (channelWidth / this.support) * 100 : 0;
    const channelPos = channelWidth > 0 && this.lastSolPrice > 0
      ? (this.lastSolPrice - this.support) / channelWidth
      : 0.5;

    let status: string;
    if (this.paper.inPosition) {
      status = this.entryDirection === 'long' ? 'IN LONG' : 'IN SHORT';
    } else if (channelPos <= this.config.entryZoneLow + 0.05) {
      status = 'NEAR SUPPORT';
    } else if (channelPos >= this.config.entryZoneHigh - 0.05) {
      status = 'NEAR RESISTANCE';
    } else {
      status = 'WATCHING';
    }

    return {
      status,
      support: this.support > 0 ? `$${this.support.toFixed(2)}` : '--',
      resistance: this.resistance > 0 ? `$${this.resistance.toFixed(2)}` : '--',
      'channel pos': channelPos.toFixed(2),
      'channel width': `${channelPct.toFixed(2)}%`,
      'sol samples': this.solBuffer.length,
    };
  }

  stop(): void {
    // No timers to clean up — exits are tick-time based
  }
}

function percentile(arr: number[], pct: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
