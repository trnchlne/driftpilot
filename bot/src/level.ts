import { SOL_FEED_ID } from './feed.js';
import type { Tick } from './feed.js';
import type { BaseStrategy, PerformanceMetrics, Direction, PaperTrade } from './base-strategy.js';
import { PaperTrader } from './base-strategy.js';
import { dashboardBus } from './dashboard-bus.js';
import type { BankrollManager } from './bankroll.js';

const MAKER_FEE_RATE = 0; // 0% true resting maker orders on Drift

interface PriceSample {
  time: number;
  price: number;
}

export interface LevelConfig {
  name: string;
  lookbackSeconds: number;
  supportPct: number;
  resistancePct: number;
  recalcIntervalSeconds: number;
  touchTolerancePct: number;
  cooldownSeconds: number;
  stopLossPct: number;
  fundingLookbackSeconds: number;
  fundingBiasMinPct: number;
  betSizeSol: number;
  minSamplesForLevel: number;
  regimeFilterPct: number;       // max SOL move % in regime window to allow entries
  regimeFilterSeconds: number;   // lookback window for regime detection
}

export class LevelStrategy implements BaseStrategy {
  readonly name: string;
  readonly type = 'level' as const;

  private readonly config: LevelConfig;
  private readonly paper: PaperTrader;
  private bankroll: BankrollManager | null = null;
  private solBuffer: PriceSample[] = [];
  private lastSolPrice = 0;
  private entryPrice = 0;
  private entryDirection: Direction = 'long';
  private lastExitReason = '';
  private lastExitTickTime = 0;

  // Structural levels (recomputed periodically, not every tick)
  private support = 0;
  private resistance = 0;
  private lastRecalcTime = 0;

  // Funding bias: track SOL trend direction
  private fundingDirection: 'long' | 'short' | 'neutral' = 'neutral';

  constructor(config: LevelConfig, paper?: PaperTrader) {
    this.name = config.name;
    this.config = config;
    this.paper = paper ?? new PaperTrader();

    this.paper.onTrade((trade: PaperTrade) => {
      dashboardBus.emitTrade({
        strategyName: this.name,
        type: 'level',
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
    // SOL-only strategy — ignore BTC ticks
    if (tick.feedId !== SOL_FEED_ID) return;

    const now = tick.publishTime;
    this.lastSolPrice = tick.price;
    this.solBuffer.push({ time: now, price: tick.price });

    // Prune buffer to lookback window
    const cutoff = now - this.config.lookbackSeconds;
    while (this.solBuffer.length > 0 && this.solBuffer[0].time < cutoff) {
      this.solBuffer.shift();
    }

    // In position: check TP/SL
    if (this.paper.inPosition) {
      this.checkExit(tick.price);
      return;
    }

    // Not enough data yet
    if (this.solBuffer.length < this.config.minSamplesForLevel) return;

    // Recalculate levels periodically (not every tick)
    if (now - this.lastRecalcTime >= this.config.recalcIntervalSeconds) {
      this.recalcLevels(now);
      this.lastRecalcTime = now;
    }

    // No levels computed yet
    if (this.support <= 0 || this.resistance <= 0) return;

    // Cooldown after last exit
    if (this.lastExitTickTime > 0 && (now - this.lastExitTickTime) < this.config.cooldownSeconds) {
      return;
    }

    // Regime filter: don't enter level trades during trending markets
    if (this.isTrending(now)) return;

    // Check if price touches a level
    const supportDist = Math.abs((tick.price - this.support) / this.support) * 100;
    const resistanceDist = Math.abs((tick.price - this.resistance) / this.resistance) * 100;

    if (supportDist <= this.config.touchTolerancePct) {
      // Price at support → long (if funding doesn't block)
      if (this.fundingDirection !== 'short') {
        this.enter('long', tick.price);
      }
    } else if (resistanceDist <= this.config.touchTolerancePct) {
      // Price at resistance → short (if funding doesn't block)
      if (this.fundingDirection !== 'long') {
        this.enter('short', tick.price);
      }
    }
  }

  private isTrending(now: number): boolean {
    if (this.config.regimeFilterSeconds <= 0) return false;
    const cutoff = now - this.config.regimeFilterSeconds;
    const oldSample = this.solBuffer.find(s => s.time >= cutoff);
    if (!oldSample) return false;
    const movePct = Math.abs(((this.lastSolPrice / oldSample.price) - 1) * 100);
    return movePct > this.config.regimeFilterPct;
  }

  private recalcLevels(now: number): void {
    const prices = this.solBuffer.map(s => s.price);
    this.support = percentile(prices, this.config.supportPct);
    this.resistance = percentile(prices, this.config.resistancePct);

    // Update funding bias from SOL trend
    this.updateFundingBias(now);
  }

  private updateFundingBias(now: number): void {
    const fundingCutoff = now - this.config.fundingLookbackSeconds;
    const oldSample = this.solBuffer.find(s => s.time >= fundingCutoff);
    if (!oldSample) {
      this.fundingDirection = 'neutral';
      return;
    }

    const trendPct = ((this.lastSolPrice / oldSample.price) - 1) * 100;

    if (trendPct > this.config.fundingBiasMinPct) {
      // SOL trending up → funding likely positive → prefer shorts (earn funding)
      this.fundingDirection = 'short';
    } else if (trendPct < -this.config.fundingBiasMinPct) {
      // SOL trending down → funding likely negative → prefer longs (earn funding)
      this.fundingDirection = 'long';
    } else {
      this.fundingDirection = 'neutral';
    }
  }

  private enter(direction: Direction, price: number): void {
    this.entryDirection = direction;
    this.entryPrice = price;

    const target = direction === 'long' ? this.resistance : this.support;
    console.log(
      `[${this.name}] LEVEL ${direction.toUpperCase()} @ $${price.toFixed(2)} | ` +
      `S=$${this.support.toFixed(2)} R=$${this.resistance.toFixed(2)} | ` +
      `TP→$${target.toFixed(2)} funding=${this.fundingDirection} (PAPER)`,
    );

    const betSize = this.getBetSize();
    if (betSize <= 0) return; // bankroll cap reached
    this.bankroll?.reserveCapital(betSize);
    this.paper.openPaper(direction, price, betSize, MAKER_FEE_RATE);

    dashboardBus.emitEntry({
      strategyName: this.name, type: 'level', direction,
      price, size: betSize, timestamp: Date.now(),
    });
  }

  private checkExit(price: number): void {
    // TP: opposite level
    if (this.entryDirection === 'long' && price >= this.resistance) {
      this.exit(price, 'TP');
      return;
    }
    if (this.entryDirection === 'short' && price <= this.support) {
      this.exit(price, 'TP');
      return;
    }

    // SL: price breaks beyond entry level
    const movePct = ((price / this.entryPrice) - 1) * 100;
    const adverse = this.entryDirection === 'long' ? -movePct : movePct;
    if (adverse >= this.config.stopLossPct) {
      this.exit(price, 'SL');
    }
  }

  private exit(price: number, reason: string): void {
    this.lastExitReason = reason;
    this.lastExitTickTime = this.solBuffer.length > 0
      ? this.solBuffer[this.solBuffer.length - 1].time
      : 0;
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
    if (this.solBuffer.length < this.config.minSamplesForLevel) {
      return {
        status: 'WARMING UP',
        samples: this.solBuffer.length,
        need: this.config.minSamplesForLevel,
      };
    }

    let status: string;
    if (this.paper.inPosition) {
      const movePct = ((this.lastSolPrice / this.entryPrice) - 1) * 100;
      const favorable = this.entryDirection === 'long' ? movePct : -movePct;
      status = `HOLDING ${this.entryDirection.toUpperCase()} (${favorable >= 0 ? '+' : ''}${favorable.toFixed(2)}%)`;
    } else if (this.support > 0 && this.resistance > 0) {
      const supportDist = Math.abs((this.lastSolPrice - this.support) / this.support) * 100;
      const resistanceDist = Math.abs((this.lastSolPrice - this.resistance) / this.resistance) * 100;
      if (supportDist <= this.config.touchTolerancePct * 2 || resistanceDist <= this.config.touchTolerancePct * 2) {
        status = 'NEAR LEVEL';
      } else {
        status = 'POSTING';
      }
    } else {
      status = 'COMPUTING';
    }

    return {
      status,
      support: this.support > 0 ? `$${this.support.toFixed(2)}` : '--',
      resistance: this.resistance > 0 ? `$${this.resistance.toFixed(2)}` : '--',
      spread: this.support > 0 && this.resistance > 0
        ? `${(((this.resistance - this.support) / this.support) * 100).toFixed(2)}%`
        : '--',
      funding: this.fundingDirection,
      regime: this.solBuffer.length > 0 && this.isTrending(this.solBuffer[this.solBuffer.length - 1].time) ? 'TRENDING' : 'range',
      tolerance: `${this.config.touchTolerancePct}%`,
      'sol price': this.lastSolPrice > 0 ? `$${this.lastSolPrice.toFixed(2)}` : '--',
    };
  }

  setBankroll(bm: BankrollManager): void {
    this.bankroll = bm;
  }

  private getBetSize(): number {
    return this.bankroll?.getBetSize('level') ?? this.config.betSizeSol;
  }

  stop(): void {
    // No timers to clean up — exits are purely price-based
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
