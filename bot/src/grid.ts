import { SOL_FEED_ID } from './feed.js';
import type { Tick } from './feed.js';
import type { BaseStrategy, PerformanceMetrics, PaperTrade } from './base-strategy.js';
import { PaperTrader } from './base-strategy.js';
import { dashboardBus } from './dashboard-bus.js';

const MAKER_FEE_RATE = 2 / 10_000; // 2 bps per side (limit orders)

interface GridConfig {
  name: string;
  spacingPct: number;
  levelsPerSide: number;
  betPerLevel: number;
  recenterPct: number;
  maxExposureSol: number;
}

interface GridFill {
  level: number;
  price: number;
  side: 'buy' | 'sell';
  sizeSol: number;
}

export class GridStrategy implements BaseStrategy {
  readonly name: string;
  readonly type = 'grid' as const;

  private readonly config: GridConfig;
  private readonly paper: PaperTrader;
  private center = 0;
  private levels: number[] = [];
  private lastPrice = 0;
  private initialized = false;
  private netPositionSol = 0;
  private fills: GridFill[] = [];

  constructor(config: GridConfig) {
    this.name = config.name;
    this.config = config;
    this.paper = new PaperTrader();

    this.paper.onTrade((trade: PaperTrade) => {
      dashboardBus.emitTrade({
        strategyName: this.name,
        type: 'grid',
        direction: trade.direction,
        entry: trade.entryPrice,
        exit: trade.exitPrice,
        pnl: trade.netPnlSol,
        reason: 'round-trip',
        timestamp: trade.exitTime,
      });
    });
  }

  onTick(tick: Tick): void {
    if (tick.feedId !== SOL_FEED_ID) return;

    const price = tick.price;

    if (!this.initialized) {
      this.center = price;
      this.buildGrid();
      this.lastPrice = price;
      this.initialized = true;
      console.log(
        `[${this.name}] Grid initialized @ $${price.toFixed(2)} | ` +
        `${this.levels.length} levels, spacing ${this.config.spacingPct}%`,
      );
      return;
    }

    // Check for level crossings
    const prev = this.lastPrice;
    this.lastPrice = price;

    for (const level of this.levels) {
      // Crossed down through level → buy
      if (prev > level && price <= level) {
        this.onCross(level, price, 'buy');
      }
      // Crossed up through level → sell
      else if (prev < level && price >= level) {
        this.onCross(level, price, 'sell');
      }
    }

    // Check recenter
    const drift = Math.abs((price / this.center - 1) * 100);
    if (drift > this.config.recenterPct) {
      this.center = price;
      this.buildGrid();
      console.log(`[${this.name}] Recentered grid @ $${price.toFixed(2)}`);
    }
  }

  private buildGrid(): void {
    this.levels = [];
    const n = this.config.levelsPerSide;
    for (let i = -n; i <= n; i++) {
      if (i === 0) continue; // skip center
      this.levels.push(this.center * (1 + (i * this.config.spacingPct) / 100));
    }
    this.levels.sort((a, b) => a - b);
  }

  private onCross(level: number, price: number, side: 'buy' | 'sell'): void {
    const size = this.config.betPerLevel;

    // Max exposure check
    const newNet = side === 'buy'
      ? this.netPositionSol + size
      : this.netPositionSol - size;

    if (Math.abs(newNet) > this.config.maxExposureSol) return;

    this.fills.push({ level, price, side, sizeSol: size });

    const prevNet = this.netPositionSol;
    this.netPositionSol = newNet;

    // Check for round-trip completion:
    // If net position crossed zero or returned to zero, record a paper trade
    if ((prevNet > 0 && newNet <= 0) || (prevNet < 0 && newNet >= 0)) {
      // A round-trip completed — find the matching fills
      this.recordRoundTrip(price);
    }

    console.log(
      `[${this.name}] ${side.toUpperCase()} ${size} SOL @ $${price.toFixed(2)} (level $${level.toFixed(2)}) | ` +
      `net ${this.netPositionSol >= 0 ? '+' : ''}${this.netPositionSol.toFixed(3)} SOL (PAPER)`,
    );
  }

  private recordRoundTrip(exitPrice: number): void {
    // Walk fills backwards to find the matching entry
    // Simple approach: each round-trip is one bet-per-level sized trade
    const size = this.config.betPerLevel;

    // Find the oldest un-matched fill on the opposite side
    let entryFill: GridFill | null = null;
    for (let i = 0; i < this.fills.length - 1; i++) {
      const f = this.fills[i];
      if (f.side === 'buy' && this.fills[this.fills.length - 1].side === 'sell') {
        entryFill = f;
        this.fills.splice(i, 1);
        break;
      }
      if (f.side === 'sell' && this.fills[this.fills.length - 1].side === 'buy') {
        entryFill = f;
        this.fills.splice(i, 1);
        break;
      }
    }

    if (!entryFill) return;
    // Remove the exit fill too
    this.fills.pop();

    const direction = entryFill.side === 'buy' ? 'long' : 'short';
    this.paper.openPaper(direction as 'long' | 'short', entryFill.price, size, MAKER_FEE_RATE);
    const trade = this.paper.closePaper(exitPrice, MAKER_FEE_RATE);

    if (trade) {
      const sign = trade.netPnlSol >= 0 ? '+' : '';
      console.log(
        `[${this.name}] ROUND-TRIP $${trade.entryPrice.toFixed(2)} → $${trade.exitPrice.toFixed(2)} | ` +
        `net ${sign}${trade.netPnlSol.toFixed(6)} SOL (PAPER)`,
      );
    }
  }

  getMetrics(): PerformanceMetrics {
    return this.paper.getMetrics();
  }

  getThinking(): Record<string, unknown> {
    if (!this.initialized) {
      return { status: 'INITIALIZING' };
    }

    const drift = this.center > 0 ? ((this.lastPrice / this.center - 1) * 100) : 0;
    const levelsAbove = this.levels.filter(l => l > this.lastPrice).length;
    const levelsBelow = this.levels.filter(l => l < this.lastPrice).length;

    const status = Math.abs(drift) > this.config.recenterPct * 0.8 ? 'NEAR RECENTER' : 'ACTIVE';

    return {
      status,
      center: `$${this.center.toFixed(2)}`,
      'drift': `${drift >= 0 ? '+' : ''}${drift.toFixed(2)}%`,
      'levels above': levelsAbove,
      'levels below': levelsBelow,
      'net exposure': `${this.netPositionSol >= 0 ? '+' : ''}${this.netPositionSol.toFixed(3)} SOL`,
      'open fills': this.fills.length,
      'recenter at': `${this.config.recenterPct}%`,
    };
  }

  stop(): void {
    // Grid has no timers to clear
  }
}
