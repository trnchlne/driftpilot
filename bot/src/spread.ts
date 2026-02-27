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

interface SpreadConfig {
  name: string;
  lookbackSeconds: number;
  deviationThreshold: number; // in std devs
  stopLossPct: number;
  takeProfitPct: number;      // price-based TP
  maxHoldSeconds: number;
  betSizeSol: number;
  minSamples: number;
  cooldownSeconds: number;    // min seconds between trades
}

export class SpreadStrategy implements BaseStrategy {
  readonly name: string;
  readonly type = 'spread' as const;

  private readonly config: SpreadConfig;
  private readonly paper: PaperTrader;
  private priceBuffer: PriceSample[] = [];
  private lastSolPrice = 0;
  private lastTickTime = 0;
  private entryPrice = 0;
  private entryDirection: Direction = 'long';
  private priceMean = 0;
  private entryTickTime = 0;
  private lastExitReason = '';
  private lastExitTickTime = 0;

  constructor(config: SpreadConfig) {
    this.name = config.name;
    this.config = config;
    this.paper = new PaperTrader();

    this.paper.onTrade((trade: PaperTrade) => {
      dashboardBus.emitTrade({
        strategyName: this.name,
        type: 'spread',
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

    this.lastTickTime = tick.publishTime;
    this.lastSolPrice = tick.price;

    const now = tick.publishTime;

    this.priceBuffer.push({ time: now, price: tick.price });

    // Prune
    const cutoff = now - this.config.lookbackSeconds;
    while (this.priceBuffer.length > 0 && this.priceBuffer[0].time < cutoff) {
      this.priceBuffer.shift();
    }

    // Check exit if in position
    if (this.paper.inPosition) {
      // Max-hold check using tick time (works in both live and backtest)
      if (tick.publishTime - this.entryTickTime >= this.config.maxHoldSeconds) {
        this.exit(tick.price, 'timeout');
        return;
      }
      this.checkExit(tick.price);
      return;
    }

    // Cooldown after last exit to prevent rapid re-entry (tick-time based)
    if (this.lastExitTickTime > 0 && (tick.publishTime - this.lastExitTickTime) < this.config.cooldownSeconds) {
      return;
    }

    // Need enough samples
    if (this.priceBuffer.length < this.config.minSamples) return;

    // Compute mean and std dev of SOL price
    const prices = this.priceBuffer.map(s => s.price);
    const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
    const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;
    const std = Math.sqrt(variance);

    this.priceMean = mean;

    if (std <= 0) return;

    const zScore = (tick.price - mean) / std;

    // SOL price HIGH → momentum → LONG SOL (ride the breakout)
    if (zScore > this.config.deviationThreshold) {
      this.enter('long', tick.price, mean, zScore, tick.publishTime);
    }
    // SOL price LOW → momentum → SHORT SOL (ride the breakdown)
    else if (zScore < -this.config.deviationThreshold) {
      this.enter('short', tick.price, mean, zScore, tick.publishTime);
    }
  }

  private enter(direction: Direction, price: number, mean: number, zScore: number, tickTime: number): void {
    this.entryDirection = direction;
    this.entryPrice = price;
    this.entryTickTime = tickTime;

    console.log(
      `[${this.name}] SPREAD ${direction.toUpperCase()} @ $${price.toFixed(2)} | ` +
      `price $${price.toFixed(4)} vs mean $${mean.toFixed(4)} | ` +
      `z=${zScore > 0 ? '+' : ''}${zScore.toFixed(2)} (PAPER)`,
    );

    this.paper.openPaper(direction, price, this.config.betSizeSol, MAKER_FEE_RATE);

    dashboardBus.emitEntry({
      strategyName: this.name, type: 'spread', direction,
      price, size: this.config.betSizeSol, timestamp: Date.now(),
    });

  }

  private checkExit(price: number): void {
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;

    // TP: price-based (must move enough to cover fees + profit)
    if (favorable >= this.config.takeProfitPct) {
      this.exit(price, 'TP');
      return;
    }

    // SL: price-based
    if (favorable <= -this.config.stopLossPct) {
      this.exit(price, 'SL');
      return;
    }
  }

  private exit(price: number, reason: string): void {
    this.lastExitReason = reason;
    this.lastExitTickTime = this.lastTickTime;
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
    if (this.priceBuffer.length < 2) {
      return { status: 'WARMING UP', samples: this.priceBuffer.length, need: this.config.minSamples };
    }

    const prices = this.priceBuffer.map(s => s.price);
    const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
    const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;
    const std = Math.sqrt(variance);
    const zScore = std > 0 ? (this.lastSolPrice - mean) / std : 0;

    let status: string;
    if (this.paper.inPosition) {
      const movePct = ((this.lastSolPrice / this.entryPrice) - 1) * 100;
      const favorable = this.entryDirection === 'long' ? movePct : -movePct;
      status = `${this.entryDirection.toUpperCase()} (${favorable >= 0 ? '+' : ''}${favorable.toFixed(2)}%)`;
    } else if (this.lastExitTickTime > 0 && (this.lastTickTime - this.lastExitTickTime) < this.config.cooldownSeconds) {
      status = 'COOLDOWN';
    } else if (Math.abs(zScore) > this.config.deviationThreshold * 0.8) {
      status = 'NEAR SIGNAL';
    } else {
      status = 'WATCHING';
    }

    return {
      status,
      'price': `$${this.lastSolPrice.toFixed(4)}`,
      'mean': `$${mean.toFixed(4)}`,
      'z-score': `${zScore >= 0 ? '+' : ''}${zScore.toFixed(2)}`,
      threshold: `${this.config.deviationThreshold.toFixed(1)}σ`,
      samples: this.priceBuffer.length,
    };
  }

  stop(): void {
    // No timers to clean up — exits are tick-time based
  }
}
