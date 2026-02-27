/**
 * LiveTrader — extends PaperTrader to mirror trades to Drift.
 *
 * Strategies call openPaper()/closePaper() unchanged.
 * LiveTrader overrides both to ALSO fire async Drift orders via DriftExecutor.
 * Each strategy → its own subaccount → full isolation.
 *
 * On entry: calculates SL trigger price from strategy config and places
 * a trigger-market order on-chain (fires even if bot is offline).
 */

import { PaperTrader } from './base-strategy.js';
import type { Direction, PaperTrade } from './base-strategy.js';
import type { DriftExecutor } from './executor.js';

export class LiveTrader extends PaperTrader {
  private readonly strategyName: string;
  private readonly subAccountId: number;
  private readonly executor: DriftExecutor;
  private readonly slPct: number; // stop-loss % from entry

  private lastEntryDirection: Direction = 'long';
  private lastEntryPrice = 0;
  private lastEntryTickTime = 0;

  constructor(opts: {
    strategyName: string;
    subAccountId: number;
    executor: DriftExecutor;
    slPct: number;
  }) {
    super();
    this.strategyName = opts.strategyName;
    this.subAccountId = opts.subAccountId;
    this.executor = opts.executor;
    this.slPct = opts.slPct;
  }

  override openPaper(
    direction: Direction,
    price: number,
    sizeSol: number,
    feeRate: number,
    time?: number,
  ): void {
    // Paper side first (synchronous)
    super.openPaper(direction, price, sizeSol, feeRate, time);

    this.lastEntryDirection = direction;
    this.lastEntryPrice = price;
    this.lastEntryTickTime = time ?? Date.now() / 1000;

    // Calculate SL trigger price
    const slPrice = direction === 'long'
      ? price * (1 - this.slPct / 100)
      : price * (1 + this.slPct / 100);

    // Fire Drift limit order async (don't block the tick loop)
    this.executor
      .open(
        this.strategyName,
        this.subAccountId,
        direction,
        sizeSol,
        slPrice,
        this.lastEntryTickTime,
        price,
      )
      .then((filled) => {
        if (!filled) {
          // Limit order expired unfilled — unwind the paper position so
          // strategy doesn't think it's in a trade with no Drift backing
          console.log(`[live-trader] Unwinding paper position — limit unfilled (${this.strategyName})`);
          super.closePaper(price, 0, time); // 0 fee since no trade happened
        }
      })
      .catch((err) => {
        console.error(`[live-trader] DRIFT OPEN FAILED ${this.strategyName}:`, err);
        // Also unwind paper on error
        super.closePaper(price, 0, time);
      });
  }

  override saveEntryRegime(regime: string): void {
    this.executor.updateEntryRegime(this.strategyName, regime);
  }

  override closePaper(price: number, feeRate: number, time?: number): PaperTrade | null {
    // Paper side first (synchronous)
    const trade = super.closePaper(price, feeRate, time);

    // Fire Drift close async
    this.executor
      .close(this.strategyName, this.subAccountId)
      .catch((err) => {
        console.error(`[live-trader] DRIFT CLOSE FAILED ${this.strategyName}:`, err);
      });

    return trade;
  }
}
