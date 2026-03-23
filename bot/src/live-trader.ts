/**
 * LiveTrader — extends PaperTrader to mirror trades to Drift.
 *
 * Strategies call openPaper()/closePaper() unchanged.
 * LiveTrader overrides both to ALSO fire async Drift orders via DriftExecutor.
 * Each strategy → its own subaccount → full isolation.
 *
 * On entry: calculates SL trigger price from strategy config and places
 * a trigger-market order on-chain (fires even if bot is offline).
 *
 * Position sync: syncWithDrift() checks if the Drift position still exists.
 * If it was closed externally (SL trigger, manual close, liquidation), the
 * paper state is updated and the strategy is notified for cooldown/bankroll.
 */

import { PaperTrader } from './base-strategy.js';
import type { Direction, PaperTrade } from './base-strategy.js';
import type { DriftExecutor } from './executor.js';
import { dashboardBus } from './dashboard-bus.js';

export class LiveTrader extends PaperTrader {
  private readonly strategyName: string;
  private readonly subAccountId: number;
  private readonly executor: DriftExecutor;
  private readonly slPct: number; // stop-loss % from entry
  private readonly marketIndex: number;

  private lastEntryDirection: Direction = 'long';
  private lastEntryPrice = 0;
  private lastEntryTickTime = 0;
  private _useMarketEntry = false;
  private _pendingClose = false;
  private _pendingOpen = false;
  private _skipDriftClose = false;

  constructor(opts: {
    strategyName: string;
    subAccountId: number;
    executor: DriftExecutor;
    slPct: number;
    marketIndex?: number;
  }) {
    super();
    this.strategyName = opts.strategyName;
    this.subAccountId = opts.subAccountId;
    this.executor = opts.executor;
    this.slPct = opts.slPct;
    this.marketIndex = opts.marketIndex ?? 0;
  }

  override setUseMarketEntry(use: boolean): void {
    this._useMarketEntry = use;
  }

  override openPaper(
    direction: Direction,
    price: number,
    sizeSol: number,
    feeRate: number,
    time?: number,
  ): void {
    // Block opens while a previous close is still settling on Drift
    if (this._pendingClose) {
      console.warn(`[live-trader] BLOCKED OPEN — close still pending on Drift (${this.strategyName})`);
      dashboardBus.emitActivity({
        strategyName: this.strategyName,
        level: 'warn',
        message: 'Open blocked — close still pending on Drift',
        timestamp: Date.now() / 1000,
      });
      return;
    }

    // Paper side first (synchronous)
    super.openPaper(direction, price, sizeSol, feeRate, time);

    this.lastEntryDirection = direction;
    this.lastEntryPrice = price;
    this.lastEntryTickTime = time ?? Date.now() / 1000;

    // Calculate SL trigger price
    const slPrice = direction === 'long'
      ? price * (1 - this.slPct / 100)
      : price * (1 + this.slPct / 100);

    // Fire Drift order async (don't block the tick loop)
    // Trending/uncertain entries use market orders for guaranteed fill;
    // ranging entries use post-only limits for maker fees.
    const useMarket = this._useMarketEntry;
    this._pendingOpen = true;
    this.executor
      .open(
        this.strategyName,
        this.subAccountId,
        direction,
        sizeSol,
        slPrice,
        this.lastEntryTickTime,
        price,
        useMarket,
        this.marketIndex,
      )
      .then((filled) => {
        this._pendingOpen = false;
        if (!filled) {
          // Order not filled — cancel paper position without recording a trade
          console.log(`[live-trader] Open not filled — cancelling paper position (${this.strategyName})`);
          dashboardBus.emitActivity({
            strategyName: this.strategyName,
            level: 'warn',
            message: 'Open not filled — order expired, position cancelled',
            timestamp: Date.now() / 1000,
          });
          super.cancelOpen(time);
        }
      })
      .catch((err) => {
        this._pendingOpen = false;
        console.error(`[live-trader] DRIFT OPEN FAILED ${this.strategyName}:`, err);
        dashboardBus.emitActivity({
          strategyName: this.strategyName,
          level: 'error',
          message: `Drift open failed — ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now() / 1000,
        });
        super.cancelOpen(time);
      });
  }

  /** Recovery-only: reconstruct paper state without placing a Drift order */
  recoverPaper(direction: Direction, price: number, sizeSol: number, time: number): void {
    super.openPaper(direction, price, sizeSol, 0, time);
  }

  override saveEntryRegime(regime: string): void {
    this.executor.updateEntryRegime(this.strategyName, regime);
  }

  override saveEntryMean(mean: number): void {
    this.executor.updateEntryMean(this.strategyName, mean);
  }

  override closePaper(price: number, feeRate: number, time?: number): PaperTrade | null {
    // Paper side first (synchronous)
    const trade = super.closePaper(price, feeRate, time);

    // Skip Drift close when called from syncWithDrift (position already gone)
    if (this._skipDriftClose) {
      this._skipDriftClose = false;
      return trade;
    }

    // Block new opens until Drift close settles
    this._pendingClose = true;

    // Fire Drift close async (with retry + verification in executor)
    this.executor
      .close(this.strategyName, this.subAccountId, this.marketIndex)
      .then(() => {
        this._pendingClose = false;
        dashboardBus.emitActivity({
          strategyName: this.strategyName,
          level: 'info',
          message: 'Drift position closed successfully',
          timestamp: Date.now() / 1000,
        });
      })
      .catch((err) => {
        console.error(`[live-trader] DRIFT CLOSE FAILED ${this.strategyName}:`, err);
        // Keep _pendingClose=true to block all new opens — position is still on Drift with SL protection
        console.error(
          `[live-trader] *** STRATEGY HALTED *** ${this.strategyName} — ` +
          `Drift position not closed. Restart bot to recover.`,
        );
        dashboardBus.emitActivity({
          strategyName: this.strategyName,
          level: 'error',
          message: 'STRATEGY HALTED — close failed after all retries, SL preserved. Restart bot to recover.',
          timestamp: Date.now() / 1000,
        });
      });

    return trade;
  }

  /**
   * Check if the Drift position still matches paper state.
   * Detects external closes (SL trigger fired, manual close, liquidation).
   * Called periodically from live.ts (~every 10s).
   */
  async syncWithDrift(): Promise<void> {
    // Only check when paper thinks we're in position and no operations in flight
    if (!this.inPosition || this._pendingClose || this._pendingOpen) return;

    const driftPos = this.executor.readPositionSync(this.subAccountId, this.marketIndex);

    // Read error → assume position still exists (safe default)
    if (driftPos === 'error') return;

    // Position still exists on Drift → all good
    if (driftPos !== null) return;

    // ── Position gone on Drift but paper still open ──
    // Could be: SL trigger fired, manual close on Drift UI, or liquidation
    const oraclePrice = this.executor.getOraclePrice(this.marketIndex);
    const exitPrice = oraclePrice ?? this.lastEntryPrice;
    const now = Date.now() / 1000;

    console.log(
      `[live-trader] EXTERNAL CLOSE DETECTED — Drift position gone (${this.strategyName}). ` +
      `Using oracle price $${exitPrice.toFixed(2)} as estimated exit.`,
    );

    dashboardBus.emitActivity({
      strategyName: this.strategyName,
      level: 'warn',
      message: `External close detected — position closed outside bot (SL trigger / manual / liquidation). Exit ≈ $${exitPrice.toFixed(2)}`,
      timestamp: now,
    });

    // Close paper without triggering Drift close (position already gone)
    this._skipDriftClose = true;
    this._pendingClose = true; // block new opens until cleanup done
    const trade = this.closePaper(exitPrice, 0, now);

    // Notify strategy for cooldown + bankroll release
    if (trade) {
      this.notifyExternalClose(trade, 'external-close');
    }

    // Cleanup: cancel any stale orders (SL trigger might already be gone) + clear state
    this.executor
      .cleanupOrders(this.strategyName, this.subAccountId, this.marketIndex)
      .then(() => {
        this._pendingClose = false;
      })
      .catch((err) => {
        console.error(`[live-trader] Cleanup after external close failed (${this.strategyName}):`, err);
        this._pendingClose = false; // allow new opens — position is confirmed gone
      });
  }
}
