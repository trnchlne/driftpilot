import { EventEmitter } from 'node:events';

export interface PriceEvent {
  sol: number;
  timestamp: number;
  prices?: Record<string, number>; // per-market prices (e.g. { SOL: 89.5, HYPE: 41.2 })
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
  market?: string;
  subAccountId?: number;
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
  tradingPnl: number;
}

export interface MarketEvent {
  fundingRate: number;      // hourly funding rate %
  fundingRate24h: number;   // 24h avg funding rate %
  spreadBps: number;        // bid-ask spread in basis points
  markPrice: number;        // current mark price
  longOI: number;           // long open interest in SOL
  shortOI: number;          // short open interest in SOL
  maxOI: number;            // max allowed OI in SOL
  sqrtK: number;            // AMM liquidity depth
  userLpShares: number;     // user-provided LP shares
  usersWithPositions: number;
  totalUsers: number;
}

export interface AccountEvent {
  balanceUsdc: number;
  unrealizedPnl: number;
  startBalanceUsdc: number;
  realizedPnl: number;
  totalPnl: number;
  tradingPnl: number;
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

  emitMarket(event: MarketEvent): void {
    this.emit('market', event);
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
