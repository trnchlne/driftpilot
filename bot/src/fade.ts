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

interface FadeConfig {
  name: string;
  fadeThresholdPct: number;
  fadeWindowSeconds: number;
  stopLossPct: number;
  takeProfitPct: number;
  divergenceMinPct: number;
  betSizeSol: number;
  maxHoldSeconds: number;
}

export class FadeStrategy implements BaseStrategy {
  readonly name: string;
  readonly type = 'fade' as const;

  private readonly config: FadeConfig;
  private readonly paper: PaperTrader;
  private solBuffer: PriceSample[] = [];
  private lastSolPrice = 0;
  private entryPrice = 0;
  private entryDirection: Direction = 'long';
  private entryTickTime = 0;
  private lastExitReason = '';
  private lastSolMove = 0;

  constructor(config: FadeConfig) {
    this.name = config.name;
    this.config = config;
    this.paper = new PaperTrader();

    this.paper.onTrade((trade: PaperTrade) => {
      dashboardBus.emitTrade({
        strategyName: this.name,
        type: 'fade',
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

    const cutoff = now - this.config.fadeWindowSeconds - 10;
    while (this.solBuffer.length > 0 && this.solBuffer[0].time < cutoff) {
      this.solBuffer.shift();
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

    // Need data for fade window
    if (this.solBuffer.length < 2) return;

    const solMove = this.getMove(this.solBuffer, this.config.fadeWindowSeconds, now);

    if (solMove === null) return;

    // Check threshold
    if (Math.abs(solMove) < this.config.fadeThresholdPct) return;

    // Fade when SOL moves past threshold alone
    if (Math.abs(solMove) < this.config.fadeThresholdPct + this.config.divergenceMinPct) return;

    // Fade: trade AGAINST the SOL move
    const direction: Direction = solMove > 0 ? 'short' : 'long';
    this.enter(direction, tick.price, solMove, tick.publishTime);
  }

  private getMove(buffer: PriceSample[], windowSec: number, now: number): number | null {
    const cutoff = now - windowSec;
    const old = buffer.find(s => s.time >= cutoff);
    if (!old) return null;
    const latest = buffer[buffer.length - 1];
    return ((latest.price / old.price) - 1) * 100;
  }

  private enter(direction: Direction, price: number, solMove: number, tickTime: number): void {
    this.entryDirection = direction;
    this.entryPrice = price;
    this.entryTickTime = tickTime;
    this.lastSolMove = solMove;

    console.log(
      `[${this.name}] FADE ${direction.toUpperCase()} @ $${price.toFixed(2)} | ` +
      `SOL ${solMove > 0 ? '+' : ''}${solMove.toFixed(2)}% (PAPER)`,
    );

    this.paper.openPaper(direction, price, this.config.betSizeSol, MAKER_FEE_RATE);

    dashboardBus.emitEntry({
      strategyName: this.name, type: 'fade', direction,
      price, size: this.config.betSizeSol, timestamp: Date.now(),
    });
  }

  private checkExit(price: number): void {
    const movePct = ((price / this.entryPrice) - 1) * 100;

    // TP: reversion in our favor
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;
    if (favorable >= this.config.takeProfitPct) {
      this.exit(price, 'TP');
      return;
    }

    // SL: continued against us
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
    const now = this.solBuffer.length > 0 ? this.solBuffer[this.solBuffer.length - 1].time : 0;
    const solMove = now > 0 ? this.getMove(this.solBuffer, this.config.fadeWindowSeconds, now) : null;

    let status: string;
    if (this.paper.inPosition) {
      status = 'FADING';
    } else if (solMove !== null && Math.abs(solMove) >= this.config.fadeThresholdPct * 0.7) {
      if (Math.abs(solMove) >= this.config.fadeThresholdPct + this.config.divergenceMinPct) {
        status = 'SIGNAL';
      } else if (Math.abs(solMove) >= this.config.fadeThresholdPct * 0.85) {
        status = 'BUILDING';
      } else {
        status = 'WATCHING';
      }
    } else {
      status = 'WATCHING';
    }

    const fmtMove = (m: number | null) => m !== null ? `${m >= 0 ? '+' : ''}${m.toFixed(2)}%` : '--';

    return {
      status,
      'sol move': fmtMove(solMove),
      threshold: `${this.config.fadeThresholdPct}%`,
      'sol price': this.lastSolPrice > 0 ? `$${this.lastSolPrice.toFixed(2)}` : '--',
    };
  }

  stop(): void {
    // No timers to clean up — exits are tick-time based
  }
}
