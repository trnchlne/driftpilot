/**
 * Dynamic bet sizing based on account equity.
 *
 * Reads equity from Drift (live) or tracks virtual equity (paper).
 * Applies half-Kelly fractions per strategy type to size bets.
 * As equity grows → bets grow. As equity shrinks → bets shrink.
 *
 * Tracks deployed capital: when positions are open, that capital is
 * "committed" and unavailable for new bets. This prevents over-allocation
 * when multiple strategies have concurrent positions.
 *
 * Kelly fractions derived from 365-day backtest:
 *   trend:    ~6.0% half-Kelly (best edge per trade)
 *   momentum: ~1.8% half-Kelly
 *   level:    ~1.0% half-Kelly
 */

import type { DriftClient } from '@drift-labs/sdk';

// 2x Kelly fractions per strategy type (optimal from 365d ablation test)
// These are the % of available bankroll to risk per trade
const KELLY_FRACTIONS: Record<string, number> = {
  trend:    0.120,  // 12.0% — strong edge, high W/L ratio
  momentum: 0.036,  // 3.6% — moderate edge
  level:    0.020,  // 2.0% — weakest per-trade edge, high volume
  regime:   0.300,  // 30.0% — aggressive Kelly from grid search #2 (55%+ ROI over 2Y)
};

// Safety: never risk more than this % of equity on a single trade
const MAX_BET_FRACTION = 0.30; // 30% — raised for regime strategies (grid search #2 aggressive)

// Never deploy more than this % of equity across all open positions
const MAX_DEPLOYED_FRACTION = 0.80; // 80% — keep 20% as margin buffer

// Minimum bet (Drift has minimum order sizes)
const MIN_BET_SOL = 0.01;

export type BankrollMode = 'paper' | 'drift';

export class BankrollManager {
  private mode: BankrollMode;
  private equity: number;          // current equity in SOL (realized balance)
  private initialEquity: number;
  private deployed: number = 0;    // capital committed to open positions
  private driftClient: DriftClient | null;
  private subAccountIds: number[];
  private lastSolPrice: number = 0;
  private lastRefreshTime: number = 0;
  private refreshIntervalMs: number = 30_000; // refresh from Drift every 30s
  private kellyOverride: number | null;
  private maxBetOverride: number | null;

  constructor(opts: {
    mode: BankrollMode;
    initialEquitySol: number;
    driftClient?: DriftClient;
    subAccountIds?: number[];
    kellyOverride?: number;   // override Kelly fraction for all strategy types
    maxBetOverride?: number;  // override max bet fraction cap
  }) {
    this.mode = opts.mode;
    this.equity = opts.initialEquitySol;
    this.initialEquity = opts.initialEquitySol;
    this.driftClient = opts.driftClient || null;
    this.subAccountIds = opts.subAccountIds || [0];
    this.kellyOverride = opts.kellyOverride ?? null;
    this.maxBetOverride = opts.maxBetOverride ?? null;
  }

  /** Update SOL price (called from feed ticks) */
  updateSolPrice(price: number): void {
    this.lastSolPrice = price;
  }

  /** Get current equity in SOL */
  getEquity(): number {
    return this.equity;
  }

  /** Get capital deployed in open positions */
  getDeployed(): number {
    return this.deployed;
  }

  /** Available equity = total equity minus deployed capital */
  getAvailable(): number {
    return Math.max(0, this.equity - this.deployed);
  }

  /** Get the bet size in SOL for a given strategy type */
  getBetSize(strategyType: string): number {
    // No equity → no bet (unfunded subaccount)
    if (this.equity < MIN_BET_SOL) return 0;

    const fraction = this.kellyOverride ?? KELLY_FRACTIONS[strategyType] ?? 0.01;
    const capped = Math.min(fraction, this.maxBetOverride ?? MAX_BET_FRACTION);

    // Size based on available equity, not total — prevents over-allocation
    const available = this.getAvailable();
    const bet = available * capped;

    // Don't open if we'd exceed max deployed fraction
    if ((this.deployed + bet) > this.equity * MAX_DEPLOYED_FRACTION) {
      // Scale down to fit within limit
      const room = Math.max(0, this.equity * MAX_DEPLOYED_FRACTION - this.deployed);
      if (room < MIN_BET_SOL) return 0; // signal: skip this trade
      return Math.floor(Math.min(bet, room) * 100) / 100;
    }

    // Enforce minimum
    if (bet < MIN_BET_SOL) return MIN_BET_SOL;

    // Round to reasonable precision (0.01 SOL increments)
    return Math.floor(bet * 100) / 100;
  }

  /** Reserve capital when opening a position */
  reserveCapital(amount: number): void {
    this.deployed += amount;
  }

  /** Release capital when closing a position */
  releaseCapital(amount: number): void {
    this.deployed -= amount;
    if (this.deployed < 0) this.deployed = 0; // safety
  }

  /** Record a trade PnL (paper mode: adjusts equity directly) */
  recordPnl(pnlSol: number): void {
    if (this.mode === 'paper') {
      this.equity += pnlSol;
      // Floor at 0 — can't go negative
      if (this.equity < 0) this.equity = 0;
    }
    // In drift mode, equity is read from the chain — PnL is reflected automatically
  }

  /** Refresh equity from Drift (live mode) — sums across all subaccounts */
  async refreshFromDrift(): Promise<void> {
    if (this.mode !== 'drift' || !this.driftClient) return;

    const now = Date.now();
    if (now - this.lastRefreshTime < this.refreshIntervalMs) return;
    this.lastRefreshTime = now;

    try {
      let totalUsdc = 0;
      for (const subId of this.subAccountIds) {
        try {
          const user = this.driftClient.getUser(subId);
          // getTotalCollateral returns BN in USDC (6 decimals)
          totalUsdc += user.getTotalCollateral().toNumber() / 1e6;
        } catch {
          // Subaccount may not exist yet
        }
      }

      // Convert USDC to SOL for bet sizing
      if (this.lastSolPrice > 0) {
        this.equity = totalUsdc / this.lastSolPrice;
      }
    } catch (err) {
      console.error('[bankroll] Failed to read Drift equity:', err);
    }
  }

  /** Get status for dashboard / logging */
  getStatus(): Record<string, unknown> {
    return {
      mode: this.mode,
      equity: `${this.equity.toFixed(4)} SOL`,
      deployed: `${this.deployed.toFixed(4)} SOL`,
      available: `${this.getAvailable().toFixed(4)} SOL`,
      initialEquity: `${this.initialEquity.toFixed(2)} SOL`,
      pnl: `${(this.equity - this.initialEquity).toFixed(4)} SOL`,
      pnlPct: `${(((this.equity / this.initialEquity) - 1) * 100).toFixed(2)}%`,
      trendBet: `${this.getBetSize('trend')} SOL`,
      momentumBet: `${this.getBetSize('momentum')} SOL`,
      levelBet: `${this.getBetSize('level')} SOL`,
      solPrice: this.lastSolPrice > 0 ? `$${this.lastSolPrice.toFixed(2)}` : '--',
    };
  }
}
