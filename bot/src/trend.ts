import { Detector } from './detector.js';
import { SOL_FEED_ID } from './feed.js';
import type { Tick } from './feed.js';
import type { BaseStrategy, PerformanceMetrics, Direction, PaperTrade } from './base-strategy.js';
import { PaperTrader } from './base-strategy.js';
import { dashboardBus } from './dashboard-bus.js';
import type { BankrollManager } from './bankroll.js';

const MAKER_FEE_RATE = 2 / 10_000; // 2 bps per side (limit orders)

interface TrendConfig {
  name: string;
  threshold: number;           // SOL move % to trigger entry
  window: number;              // SOL lookback window seconds
  trailingStopPct: number;     // trailing stop distance from best price %
  trailDelaySeconds: number;   // grace period before trailing stop activates
  stopLossPct: number;         // hard stop loss from entry %
  betSizeSol: number;
}

export class TrendStrategy implements BaseStrategy {
  readonly name: string;
  readonly type = 'trend' as const;

  private readonly config: TrendConfig;
  private readonly detector: Detector;
  private readonly paper: PaperTrader;
  private bankroll: BankrollManager | null = null;
  private lastSolPrice = 0;
  private entryPrice = 0;
  private entryDirection: Direction = 'long';
  private entryTickTime = 0;
  private bestPriceSinceEntry = 0;
  private lastExitReason = '';

  constructor(config: TrendConfig, paper?: PaperTrader) {
    this.name = config.name;
    this.config = config;
    this.detector = new Detector(config.threshold, config.window);
    this.paper = paper ?? new PaperTrader();

    this.paper.onTrade((trade: PaperTrade) => {
      dashboardBus.emitTrade({
        strategyName: this.name,
        type: 'trend',
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

    this.lastSolPrice = tick.price;

    if (this.paper.inPosition) {
      this.checkExit(tick.price, tick.publishTime);
      return;
    }

    const signal = this.detector.onTick(tick.price, tick.publishTime);
    if (!signal) return;
    if (this.lastSolPrice <= 0) return;

    const betSize = this.getBetSize();
    if (betSize <= 0) return; // bankroll cap reached
    const dir = signal.direction === 'long' ? 'PUMP' : 'DUMP';
    console.log(
      `[${this.name}] SOL ${dir} ${signal.pctChange > 0 ? '+' : ''}${signal.pctChange.toFixed(2)}% → ` +
      `${signal.direction.toUpperCase()} ${betSize} SOL @ $${this.lastSolPrice.toFixed(2)} | ` +
      `trail=${this.config.trailingStopPct}% SL=${this.config.stopLossPct}% (PAPER)`,
    );

    this.entryPrice = this.lastSolPrice;
    this.entryDirection = signal.direction;
    this.entryTickTime = tick.publishTime;
    this.bestPriceSinceEntry = this.lastSolPrice;
    this.bankroll?.reserveCapital(betSize);
    this.paper.openPaper(signal.direction, this.lastSolPrice, betSize, MAKER_FEE_RATE);

    dashboardBus.emitEntry({
      strategyName: this.name, type: 'trend', direction: signal.direction,
      price: this.lastSolPrice, size: betSize, timestamp: Date.now(),
    });
    // No hold timer — position stays open until trail or SL hits
  }

  private checkExit(price: number, tickTime: number): void {
    // Hard stop loss from entry (always active)
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;

    if (favorable <= -this.config.stopLossPct) {
      this.exit(price, 'SL');
      return;
    }

    // Trail delay: let the position breathe before trailing kicks in
    const holdTime = tickTime - this.entryTickTime;
    if (holdTime < this.config.trailDelaySeconds) {
      // Still track best price during grace period
      if (this.entryDirection === 'long') {
        if (price > this.bestPriceSinceEntry) this.bestPriceSinceEntry = price;
      } else {
        if (price < this.bestPriceSinceEntry) this.bestPriceSinceEntry = price;
      }
      return;
    }

    // Trailing stop from best price (active after delay)
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
      this.bankroll?.releaseCapital(trade.sizeSol);
      this.bankroll?.recordPnl(trade.netPnlSol);
      const sign = trade.netPnlSol >= 0 ? '+' : '';
      const holdSec = ((trade.exitTime - trade.entryTime) / 1000).toFixed(0);
      console.log(
        `[${this.name}] EXIT ${reason} (${holdSec}s) | $${trade.entryPrice.toFixed(2)} → $${trade.exitPrice.toFixed(2)} | ` +
        `net ${sign}${trade.netPnlSol.toFixed(6)} SOL (PAPER)`,
      );
    }
  }

  getMetrics(): PerformanceMetrics {
    return this.paper.getMetrics();
  }

  getThinking(): Record<string, unknown> {
    const change = this.detector.getCurrentChange();
    const changeFmt = change !== null ? `${change >= 0 ? '+' : ''}${change.toFixed(3)}%` : 'n/a';

    let status: string;
    if (this.paper.inPosition) {
      const movePct = ((this.lastSolPrice / this.entryPrice) - 1) * 100;
      const favorable = this.entryDirection === 'long' ? movePct : -movePct;

      // Show trailing stop distance
      let trailDist: number;
      if (this.entryDirection === 'long') {
        trailDist = ((this.bestPriceSinceEntry - this.lastSolPrice) / this.bestPriceSinceEntry) * 100;
      } else {
        trailDist = ((this.lastSolPrice - this.bestPriceSinceEntry) / this.bestPriceSinceEntry) * 100;
      }

      status = `RIDING ${this.entryDirection.toUpperCase()} (${favorable >= 0 ? '+' : ''}${favorable.toFixed(2)}%) trail@${trailDist.toFixed(2)}%`;
    } else {
      status = 'SCANNING';
    }

    return {
      status,
      'sol change': changeFmt,
      threshold: `${this.config.threshold}%`,
      window: `${this.config.window}s`,
      'trail stop': `${this.config.trailingStopPct}%`,
      'hard SL': `${this.config.stopLossPct}%`,
      'best price': this.paper.inPosition ? `$${this.bestPriceSinceEntry.toFixed(2)}` : '--',
      'sol price': this.lastSolPrice > 0 ? `$${this.lastSolPrice.toFixed(2)}` : '--',
      bet: `${this.config.betSizeSol} SOL`,
    };
  }

  setBankroll(bm: BankrollManager): void {
    this.bankroll = bm;
  }

  private getBetSize(): number {
    return this.bankroll?.getBetSize('trend') ?? this.config.betSizeSol;
  }

  stop(): void {
    // No timers to clean up — exits are purely price-based
  }
}
