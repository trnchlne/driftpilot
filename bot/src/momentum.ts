import { Detector } from './detector.js';
import { SOL_FEED_ID } from './feed.js';
import type { Tick } from './feed.js';
import type { BaseStrategy, PerformanceMetrics, Direction, PaperTrade } from './base-strategy.js';
import { PaperTrader } from './base-strategy.js';
import { dashboardBus } from './dashboard-bus.js';
import type { BankrollManager } from './bankroll.js';

const MAKER_FEE_RATE = 2 / 10_000; // 2 bps per side (limit orders)

interface MomentumConfig {
  name: string;
  threshold: number;
  window: number;
  holdSeconds: number;
  betSizeSol: number;
  takeProfitPct: number;
  stopLossPct: number;
}

export class MomentumStrategy implements BaseStrategy {
  readonly name: string;
  readonly type = 'momentum' as const;

  private readonly config: MomentumConfig;
  private readonly detector: Detector;
  private readonly paper: PaperTrader;
  private bankroll: BankrollManager | null = null;
  private lastSolPrice = 0;
  private entryPrice = 0;
  private entryDirection: Direction = 'long';
  private entryTickTime = 0;
  private lastExitReason = '';

  constructor(config: MomentumConfig, paper?: PaperTrader) {
    this.name = config.name;
    this.config = config;
    this.detector = new Detector(config.threshold, config.window);
    this.paper = paper ?? new PaperTrader();

    this.paper.onTrade((trade: PaperTrade) => {
      dashboardBus.emitTrade({
        strategyName: this.name,
        type: 'momentum',
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

    // Active exit management on every SOL tick
    if (this.paper.inPosition) {
      // Max-hold check (disabled when holdSeconds is 0 — let TP/SL resolve)
      if (this.config.holdSeconds > 0 && tick.publishTime - this.entryTickTime >= this.config.holdSeconds) {
        this.exit(tick.price, 'timeout');
        return;
      }
      this.checkExit(tick.price);
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
      `${signal.direction.toUpperCase()} ${betSize} SOL @ $${this.lastSolPrice.toFixed(2)} (PAPER)`,
    );

    this.entryPrice = this.lastSolPrice;
    this.entryDirection = signal.direction;
    this.entryTickTime = tick.publishTime;
    this.bankroll?.reserveCapital(betSize);
    this.paper.openPaper(signal.direction, this.lastSolPrice, betSize, MAKER_FEE_RATE);

    dashboardBus.emitEntry({
      strategyName: this.name, type: 'momentum', direction: signal.direction,
      price: this.lastSolPrice, size: betSize, timestamp: Date.now(),
    });
  }

  private checkExit(price: number): void {
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const favorable = this.entryDirection === 'long' ? movePct : -movePct;

    if (favorable >= this.config.takeProfitPct) {
      this.exit(price, 'TP');
    } else if (favorable <= -this.config.stopLossPct) {
      this.exit(price, 'SL');
    }
  }

  private exit(price: number, reason: string): void {
    this.lastExitReason = reason;
    const trade = this.paper.closePaper(price, MAKER_FEE_RATE);
    if (trade) {
      this.bankroll?.releaseCapital(trade.sizeSol);
      this.bankroll?.recordPnl(trade.netPnlSol);
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
    const change = this.detector.getCurrentChange();
    const changeFmt = change !== null ? `${change >= 0 ? '+' : ''}${change.toFixed(3)}%` : 'n/a';

    let status: string;
    if (this.paper.inPosition) {
      const movePct = ((this.lastSolPrice / this.entryPrice) - 1) * 100;
      const favorable = this.entryDirection === 'long' ? movePct : -movePct;
      status = `HOLDING ${this.entryDirection.toUpperCase()} (${favorable >= 0 ? '+' : ''}${favorable.toFixed(2)}%)`;
    } else {
      status = 'SCANNING';
    }

    return {
      status,
      'sol change': changeFmt,
      threshold: `${this.config.threshold}%`,
      window: `${this.config.window}s`,
      'buffer size': this.detector.getBufferSize(),
      'TP/SL': `${this.config.takeProfitPct}%/${this.config.stopLossPct}%`,
      'sol price': this.lastSolPrice > 0 ? `$${this.lastSolPrice.toFixed(2)}` : '--',
      bet: `${this.config.betSizeSol} SOL`,
    };
  }

  setBankroll(bm: BankrollManager): void {
    this.bankroll = bm;
  }

  private getBetSize(): number {
    return this.bankroll?.getBetSize('momentum') ?? this.config.betSizeSol;
  }

  stop(): void {
    // No timers to clean up — exits are tick-time based
  }
}
