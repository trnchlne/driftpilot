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

interface BreakoutConfig {
  name: string;
  lookbackSeconds: number;
  breakoutPct: number;       // % above high / below low to trigger
  trailingStopPct: number;   // trailing stop distance
  maxHoldSeconds: number;
  betSizeSol: number;
  minConsolidationPct: number; // range must be at least this narrow to be "consolidation"
}

export class BreakoutStrategy implements BaseStrategy {
  readonly name: string;
  readonly type = 'breakout' as const;

  private readonly config: BreakoutConfig;
  private readonly paper: PaperTrader;
  private solBuffer: PriceSample[] = [];
  private lastSolPrice = 0;
  private entryDirection: Direction = 'long';
  private bestPriceSinceEntry = 0;
  private entryTickTime = 0;
  private lastExitReason = '';
  private rangeHigh = 0;
  private rangeLow = 0;

  constructor(config: BreakoutConfig) {
    this.name = config.name;
    this.config = config;
    this.paper = new PaperTrader();

    this.paper.onTrade((trade: PaperTrade) => {
      dashboardBus.emitTrade({
        strategyName: this.name,
        type: 'breakout',
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

    const cutoff = now - this.config.lookbackSeconds;
    while (this.solBuffer.length > 0 && this.solBuffer[0].time < cutoff) {
      this.solBuffer.shift();
    }

    // In position: check max-hold then trailing stop
    if (this.paper.inPosition) {
      if (tick.publishTime - this.entryTickTime >= this.config.maxHoldSeconds) {
        this.exit(tick.price, 'timeout');
        return;
      }
      this.checkExit(tick.price);
      return;
    }

    // Need enough data
    if (this.solBuffer.length < 20) return;

    // Compute range (excluding most recent few samples to avoid breakout itself)
    const lookbackPrices = this.solBuffer.slice(0, -3).map(s => s.price);
    if (lookbackPrices.length < 10) return;

    this.rangeHigh = Math.max(...lookbackPrices);
    this.rangeLow = Math.min(...lookbackPrices);

    const rangeWidth = this.rangeHigh - this.rangeLow;
    const rangePct = this.rangeLow > 0 ? (rangeWidth / this.rangeLow) * 100 : 0;

    // Range must be narrow enough to be "consolidation"
    if (rangePct > this.config.minConsolidationPct) return;

    const breakAbove = this.rangeHigh * (1 + this.config.breakoutPct / 100);
    const breakBelow = this.rangeLow * (1 - this.config.breakoutPct / 100);

    if (tick.price > breakAbove) {
      this.enter('long', tick.price, rangePct, tick.publishTime);
    } else if (tick.price < breakBelow) {
      this.enter('short', tick.price, rangePct, tick.publishTime);
    }
  }

  private enter(direction: Direction, price: number, rangePct: number, tickTime: number): void {
    this.entryDirection = direction;
    this.bestPriceSinceEntry = price;
    this.entryTickTime = tickTime;

    console.log(
      `[${this.name}] BREAKOUT ${direction.toUpperCase()} @ $${price.toFixed(2)} | ` +
      `range ${rangePct.toFixed(2)}% ($${this.rangeLow.toFixed(2)}-$${this.rangeHigh.toFixed(2)}) (PAPER)`,
    );

    this.paper.openPaper(direction, price, this.config.betSizeSol, MAKER_FEE_RATE);

    dashboardBus.emitEntry({
      strategyName: this.name, type: 'breakout', direction,
      price, size: this.config.betSizeSol, timestamp: Date.now(),
    });

  }

  private checkExit(price: number): void {
    // Update best price (for trailing stop)
    if (this.entryDirection === 'long') {
      if (price > this.bestPriceSinceEntry) this.bestPriceSinceEntry = price;
      const drawdown = ((this.bestPriceSinceEntry - price) / this.bestPriceSinceEntry) * 100;
      if (drawdown >= this.config.trailingStopPct) {
        this.exit(price, 'trail');
        return;
      }
    } else {
      if (price < this.bestPriceSinceEntry) this.bestPriceSinceEntry = price;
      const drawup = ((price - this.bestPriceSinceEntry) / this.bestPriceSinceEntry) * 100;
      if (drawup >= this.config.trailingStopPct) {
        this.exit(price, 'trail');
        return;
      }
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
    if (this.solBuffer.length < 10) {
      return { status: 'WARMING UP', samples: this.solBuffer.length };
    }

    const rangePct = this.rangeLow > 0
      ? ((this.rangeHigh - this.rangeLow) / this.rangeLow) * 100
      : 0;

    let status: string;
    if (this.paper.inPosition) {
      const trail = this.entryDirection === 'long'
        ? ((this.bestPriceSinceEntry - this.lastSolPrice) / this.bestPriceSinceEntry) * 100
        : ((this.lastSolPrice - this.bestPriceSinceEntry) / this.bestPriceSinceEntry) * 100;
      status = `RIDING (trail ${trail.toFixed(2)}%)`;
    } else if (rangePct <= this.config.minConsolidationPct) {
      status = 'CONSOLIDATING';
    } else {
      status = 'WATCHING';
    }

    return {
      status,
      high: this.rangeHigh > 0 ? `$${this.rangeHigh.toFixed(2)}` : '--',
      low: this.rangeLow > 0 ? `$${this.rangeLow.toFixed(2)}` : '--',
      'range width': `${rangePct.toFixed(2)}%`,
      'consol max': `${this.config.minConsolidationPct}%`,
      samples: this.solBuffer.length,
    };
  }

  stop(): void {
    // No timers to clean up — exits are tick-time based
  }
}
