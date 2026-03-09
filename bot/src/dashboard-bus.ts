import { EventEmitter } from 'node:events';

export interface PriceEvent {
  sol: number;
  timestamp: number;
}

export interface EntryEvent {
  strategyName: string;
  type: string;
  direction: string;
  price: number;
  size: number;
  timestamp: number;
}

export interface TradeEvent {
  tradeId?: string;
  strategyName: string;
  type: string;
  direction: string;
  entry: number;
  exit: number;
  pnl: number;
  reason: string;
  bestPrice?: number;
  timestamp: number;
}

export interface LeaderboardEntry {
  name: string;
  type: string;
  metrics: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    netPnlSol: number;
    sharpe: number;
    score: number;
  };
  thinking: Record<string, unknown>;
}

export interface LeaderboardEvent {
  uptime: string;
  totalTrades: number;
  entries: LeaderboardEntry[];
}

export interface SubAccountPnl {
  balanceUsdc: number;
  unrealizedPnl: number;
  startBalanceUsdc: number;
  realizedPnl: number;
  totalPnl: number;
}

export interface AccountEvent {
  balanceUsdc: number;
  unrealizedPnl: number;
  startBalanceUsdc: number;
  realizedPnl: number;
  totalPnl: number;
  timestamp: number;
  perStrategy?: Record<string, SubAccountPnl>;
}

class DashboardBus extends EventEmitter {
  private lastPriceEmit = 0;
  private pendingPrice: PriceEvent | null = null;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  emitPrice(event: PriceEvent): void {
    const now = Date.now();
    const elapsed = now - this.lastPriceEmit;

    if (elapsed >= 500) {
      this.lastPriceEmit = now;
      this.emit('price', event);
      return;
    }

    // Throttle: buffer the latest and schedule emission
    this.pendingPrice = event;
    if (!this.throttleTimer) {
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        if (this.pendingPrice) {
          this.lastPriceEmit = Date.now();
          this.emit('price', this.pendingPrice);
          this.pendingPrice = null;
        }
      }, 500 - elapsed);
    }
  }

  emitEntry(event: EntryEvent): void {
    // Pyth publishTime is in seconds; JS Date expects milliseconds
    if (event.timestamp < 1e12) event.timestamp *= 1000;
    this.emit('entry', event);
  }

  emitTrade(event: TradeEvent): void {
    if (event.timestamp < 1e12) event.timestamp *= 1000;
    this.emit('trade', event);
  }

  emitLeaderboard(event: LeaderboardEvent): void {
    this.emit('leaderboard', event);
  }

  emitAccount(event: AccountEvent): void {
    this.emit('account', event);
  }

  shutdown(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.removeAllListeners();
  }
}

export const dashboardBus = new DashboardBus();
