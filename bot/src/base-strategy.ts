import type { Tick } from './feed.js';
import type { BankrollManager } from './bankroll.js';

export interface PerformanceMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnlSol: number;
  totalFeesSol: number;
  maxDrawdownSol: number;
  sharpe: number;
  profitFactor: number;
  avgPnlPerTrade: number;
  tradesPerHour: number;
  score: number;
}

export interface BaseStrategy {
  readonly name: string;
  readonly type: 'momentum' | 'range' | 'grid' | 'fade' | 'spread' | 'breakout' | 'trend' | 'level' | 'regime';
  onTick(tick: Tick): void;
  getMetrics(): PerformanceMetrics;
  getThinking(): Record<string, unknown>;
  stop(): void;
  setBankroll?(bm: BankrollManager): void;
  recoverPosition?(pos: { direction: Direction; size: number; entryPrice: number }, extras?: { entryTickTime?: number; bestPriceSinceEntry?: number; entryRegime?: string }): void;
}

export type Direction = 'long' | 'short';

export interface PaperTrade {
  tradeId: string;
  direction: Direction;
  entryPrice: number;
  exitPrice: number;
  sizeSol: number;
  entryFee: number;
  exitFee: number;
  pnlSol: number;
  netPnlSol: number;
  entryTime: number;
  exitTime: number;
}

export type OnTradeCallback = (trade: PaperTrade) => void;

export class PaperTrader {
  private trades: PaperTrade[] = [];
  private _inPosition = false;
  private _direction: Direction = 'long';
  private _entryPrice = 0;
  private _sizeSol = 0;
  private _entryFeeRate = 0;
  private _entryTime = 0;
  private _tradeId = '';
  private _tradeCounter = 0;
  private readonly startTime: number;
  private _onTrade: OnTradeCallback | null = null;

  constructor(startTime?: number) {
    this.startTime = startTime ?? Date.now();
  }

  onTrade(cb: OnTradeCallback): void {
    this._onTrade = cb;
  }

  get inPosition(): boolean {
    return this._inPosition;
  }

  /** Override in LiveTrader to persist entry regime to state file */
  saveEntryRegime(_regime: string): void {}

  /** Override in LiveTrader to use market orders for trending entries */
  setUseMarketEntry(_use: boolean): void {}

  openPaper(direction: Direction, price: number, sizeSol: number, feeRate: number, time?: number): void {
    if (this._inPosition) return;
    this._inPosition = true;
    this._direction = direction;
    this._entryPrice = price;
    this._sizeSol = sizeSol;
    this._entryFeeRate = feeRate;
    this._entryTime = time ?? Date.now();
    this._tradeId = `t${++this._tradeCounter}-${this._entryTime}`;
  }

  closePaper(price: number, feeRate: number, time?: number): PaperTrade | null {
    if (!this._inPosition) return null;
    this._inPosition = false;

    const entry = this._entryPrice;
    const size = this._sizeSol;

    // P&L in USD
    const pnlUsd = this._direction === 'long'
      ? size * (price - entry)
      : size * (entry - price);

    // Fees in USD
    const entryFeeUsd = size * entry * this._entryFeeRate;
    const exitFeeUsd = size * price * feeRate;

    // Convert to SOL at exit price
    const pnlSol = price > 0 ? pnlUsd / price : 0;
    const entryFeeSol = price > 0 ? entryFeeUsd / price : 0;
    const exitFeeSol = price > 0 ? exitFeeUsd / price : 0;
    const netPnlSol = pnlSol - entryFeeSol - exitFeeSol;

    const trade: PaperTrade = {
      tradeId: this._tradeId,
      direction: this._direction,
      entryPrice: entry,
      exitPrice: price,
      sizeSol: size,
      entryFee: entryFeeSol,
      exitFee: exitFeeSol,
      pnlSol,
      netPnlSol,
      entryTime: this._entryTime,
      exitTime: time ?? Date.now(),
    };

    this.trades.push(trade);
    if (this._onTrade) this._onTrade(trade);
    return trade;
  }

  getMetrics(now?: number): PerformanceMetrics {
    const total = this.trades.length;

    if (total === 0) {
      return {
        totalTrades: 0, wins: 0, losses: 0, winRate: 0,
        netPnlSol: 0, totalFeesSol: 0, maxDrawdownSol: 0,
        sharpe: 0, profitFactor: 0, avgPnlPerTrade: 0,
        tradesPerHour: 0, score: 0,
      };
    }

    const wins = this.trades.filter(t => t.netPnlSol > 0).length;
    const losses = total - wins;
    const winRate = total > 0 ? (wins / total) * 100 : 0;

    const netPnlSol = this.trades.reduce((s, t) => s + t.netPnlSol, 0);
    const totalFeesSol = this.trades.reduce((s, t) => s + t.entryFee + t.exitFee, 0);

    // Max drawdown: peak-to-trough of cumulative P&L
    let peak = 0;
    let cumPnl = 0;
    let maxDrawdown = 0;
    for (const t of this.trades) {
      cumPnl += t.netPnlSol;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Sharpe: mean(returns) / std(returns)
    const returns = this.trades.map(t => t.netPnlSol);
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? mean / std : 0;

    // Profit factor: gross wins / gross losses
    const grossWins = this.trades.filter(t => t.netPnlSol > 0).reduce((s, t) => s + t.netPnlSol, 0);
    const grossLosses = Math.abs(this.trades.filter(t => t.netPnlSol <= 0).reduce((s, t) => s + t.netPnlSol, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

    const avgPnlPerTrade = netPnlSol / total;

    const uptimeHours = ((now ?? Date.now()) - this.startTime) / 3_600_000;
    const tradesPerHour = uptimeHours > 0 ? total / uptimeHours : 0;

    // Score: netPnlPerHour / (maxDrawdown + 0.001)
    const netPnlPerHour = uptimeHours > 0 ? netPnlSol / uptimeHours : 0;
    const score = netPnlPerHour / (maxDrawdown + 0.001);

    return {
      totalTrades: total, wins, losses, winRate,
      netPnlSol, totalFeesSol, maxDrawdownSol: maxDrawdown,
      sharpe, profitFactor, avgPnlPerTrade, tradesPerHour, score,
    };
  }
}
