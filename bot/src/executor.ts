/**
 * DriftExecutor — places real orders on Drift Protocol.
 *
 * Each strategy gets its own subaccount for full isolation.
 * Uses post-only limit orders for entries (maker fees) and market orders for
 * exits (guaranteed fill). Trigger-market orders provide on-chain SL protection.
 *
 * The executor serializes all operations through a mutex to avoid
 * race conditions when switching active subaccount on the DriftClient.
 */

import {
  DriftClient,
  getMarketOrderParams,
  getLimitOrderParams,
  getTriggerMarketOrderParams,
  PositionDirection,
  PostOnlyParams,
  OrderTriggerCondition,
  BN,
  MarketType,
} from '@drift-labs/sdk';
import type { Direction } from './base-strategy.js';
import type { LiveStateManager } from './live-state.js';

const SOL_PERP_MARKET_INDEX = 0;
const LIMIT_ORDER_EXPIRY_SECONDS = 30;
const FILL_POLL_INTERVAL_MS = 2000;
const FILL_POLL_MAX_WAIT_MS = 35_000; // slightly longer than expiry

export interface DriftPosition {
  direction: Direction;
  size: number;       // base asset amount in SOL
  entryPrice: number; // USD
}

export class DriftExecutor {
  private client: DriftClient;
  private stateManager: LiveStateManager;
  private mutexPromise: Promise<void> = Promise.resolve();

  constructor(client: DriftClient, stateManager: LiveStateManager) {
    this.client = client;
    this.stateManager = stateManager;
  }

  /**
   * Open a position: post-only limit order (maker fee) + trigger-market SL.
   * Uses SLIDE mode to guarantee maker status. Polls for fill, then places SL.
   * Returns true if filled, false if the limit order expired unfilled.
   */
  async open(
    stratName: string,
    subAccountId: number,
    direction: Direction,
    sizeSol: number,
    slPrice: number,
    entryTickTime: number,
    entryPrice: number,
  ): Promise<boolean> {
    let filled = false;
    await this.withMutex(async () => {
      const posDir = direction === 'long' ? PositionDirection.LONG : PositionDirection.SHORT;
      const baseAmount = new BN(Math.round(sizeSol * 1e9)); // BASE_PRECISION = 1e9

      // 1. Switch to subaccount
      await this.client.switchActiveUser(subAccountId);

      // 2. Place post-only limit order (entry) — SLIDE ensures maker status
      const oracleData = this.client.getOracleDataForPerpMarket(SOL_PERP_MARKET_INDEX);
      const oraclePrice = oracleData.price; // BN in PRICE_PRECISION (1e6)

      // Price the limit at oracle — SLIDE will adjust to best maker price
      const limitPrice = oraclePrice;

      const maxTs = new BN(Math.floor(Date.now() / 1000) + LIMIT_ORDER_EXPIRY_SECONDS);

      const entryParams = getLimitOrderParams({
        marketIndex: SOL_PERP_MARKET_INDEX,
        direction: posDir,
        baseAssetAmount: baseAmount,
        price: limitPrice,
        postOnly: PostOnlyParams.SLIDE,
        maxTs,
      });

      const entryTx = await this.client.placePerpOrder(entryParams);
      console.log(`[executor] LIMIT ${direction.toUpperCase()} ${sizeSol} SOL @ oracle sub=${subAccountId} (${stratName}) tx=${entryTx}`);

      // 3. Poll for fill (releases mutex while waiting would be ideal, but
      //    for safety we hold it — no other ops should touch this sub mid-fill)
      filled = await this.waitForFill(subAccountId, baseAmount);

      if (!filled) {
        console.log(`[executor] LIMIT EXPIRED — entry skipped (${stratName})`);
        try {
          await this.client.cancelOrders(MarketType.PERP, SOL_PERP_MARKET_INDEX, undefined, undefined, subAccountId);
        } catch { /* order already expired */ }
        return;
      }

      console.log(`[executor] FILLED ${direction.toUpperCase()} ${sizeSol} SOL sub=${subAccountId} (${stratName})`);

      // 4. Place trigger-market SL order (reduceOnly, on-chain protection)
      const slDir = direction === 'long' ? PositionDirection.SHORT : PositionDirection.LONG;
      const triggerCondition = direction === 'long'
        ? OrderTriggerCondition.BELOW  // long → SL fires when price drops below
        : OrderTriggerCondition.ABOVE; // short → SL fires when price rises above

      const triggerPriceBN = new BN(Math.round(slPrice * 1e6)); // PRICE_PRECISION = 1e6

      const slParams = getTriggerMarketOrderParams({
        marketIndex: SOL_PERP_MARKET_INDEX,
        direction: slDir,
        baseAssetAmount: baseAmount,
        triggerCondition,
        triggerPrice: triggerPriceBN,
        reduceOnly: true,
      });

      const slTx = await this.client.placePerpOrder(slParams);
      console.log(`[executor] SL trigger @ $${slPrice.toFixed(2)} sub=${subAccountId} tx=${slTx}`);

      // 5. Save supplementary state
      this.stateManager.set(stratName, {
        entryTickTime,
        bestPriceSinceEntry: entryPrice,
      });
    });
    return filled;
  }

  /**
   * Poll until the user has a non-zero position (limit order filled)
   * or until timeout (order expired unfilled).
   */
  private async waitForFill(subAccountId: number, expectedBase: BN): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < FILL_POLL_MAX_WAIT_MS) {
      try {
        const user = this.client.getUser(subAccountId);
        const position = user.getPerpPosition(SOL_PERP_MARKET_INDEX);
        if (position && !position.baseAssetAmount.isZero()) {
          return true; // position exists → filled
        }
      } catch { /* ignore read errors during polling */ }
      await new Promise((r) => setTimeout(r, FILL_POLL_INTERVAL_MS));
    }
    return false;
  }

  /**
   * Close a position: cancel SL trigger + market close.
   */
  async close(stratName: string, subAccountId: number): Promise<void> {
    await this.withMutex(async () => {
      // 1. Switch to subaccount
      await this.client.switchActiveUser(subAccountId);

      // 2. Cancel all open orders (SL trigger)
      try {
        await this.client.cancelOrders(
          MarketType.PERP,
          SOL_PERP_MARKET_INDEX,
          undefined, // direction
          undefined, // txParams
          subAccountId,
        );
        console.log(`[executor] Cancelled orders sub=${subAccountId} (${stratName})`);
      } catch (err) {
        console.warn(`[executor] Cancel orders failed sub=${subAccountId}:`, err);
      }

      // 3. Read position from Drift
      const user = this.client.getUser(subAccountId);
      const position = user.getPerpPosition(SOL_PERP_MARKET_INDEX);

      if (!position || position.baseAssetAmount.isZero()) {
        console.log(`[executor] No position to close sub=${subAccountId} (${stratName})`);
        this.stateManager.clear(stratName);
        return;
      }

      // 4. Close position with market order (reduceOnly)
      const isLong = position.baseAssetAmount.gt(new BN(0));
      const closeDir = isLong ? PositionDirection.SHORT : PositionDirection.LONG;
      const size = position.baseAssetAmount.abs();

      const closeParams = getMarketOrderParams({
        marketIndex: SOL_PERP_MARKET_INDEX,
        direction: closeDir,
        baseAssetAmount: size,
        reduceOnly: true,
      });

      const tx = await this.client.placePerpOrder(closeParams);
      console.log(`[executor] CLOSE sub=${subAccountId} (${stratName}) tx=${tx}`);

      // 5. Clear state
      this.stateManager.clear(stratName);
    });
  }

  /**
   * Read all positions across subaccounts.
   * Used for recovery on restart.
   */
  async readAllPositions(
    subAccountMap: Record<string, number>,
  ): Promise<Map<string, DriftPosition>> {
    const result = new Map<string, DriftPosition>();

    await this.withMutex(async () => {
      for (const [stratName, subId] of Object.entries(subAccountMap)) {
        try {
          const user = this.client.getUser(subId);
          const position = user.getPerpPosition(SOL_PERP_MARKET_INDEX);

          if (!position || position.baseAssetAmount.isZero()) continue;

          const isLong = position.baseAssetAmount.gt(new BN(0));
          const size = position.baseAssetAmount.abs().toNumber() / 1e9; // BASE_PRECISION

          // Entry price = |quoteEntryAmount| / |baseAssetAmount|
          const quoteEntry = Math.abs(position.quoteEntryAmount.toNumber()) / 1e6; // QUOTE_PRECISION
          const baseEntry = position.baseAssetAmount.abs().toNumber() / 1e9;
          const entryPrice = baseEntry > 0 ? quoteEntry / baseEntry : 0;

          result.set(stratName, {
            direction: isLong ? 'long' : 'short',
            size,
            entryPrice,
          });
        } catch (err) {
          console.warn(`[executor] Failed to read sub=${subId} (${stratName}):`, err);
        }
      }
    });

    return result;
  }

  /**
   * Update the bestPriceSinceEntry in state file (for trailing stop recovery).
   */
  updateBestPrice(stratName: string, bestPrice: number): void {
    const existing = this.stateManager.get(stratName);
    if (existing) {
      this.stateManager.set(stratName, { ...existing, bestPriceSinceEntry: bestPrice });
    }
  }

  /**
   * Save the entry regime (TRENDING/RANGING/UNCERTAIN) for position recovery.
   */
  updateEntryRegime(stratName: string, regime: string): void {
    const existing = this.stateManager.get(stratName);
    if (existing) {
      this.stateManager.set(stratName, { ...existing, entryRegime: regime });
    }
  }

  /**
   * Read account balance for a subaccount (USDC values).
   */
  readAccountBalance(subAccountId: number): { totalCollateral: number; unrealizedPnl: number; allTimePnl: number } {
    try {
      const user = this.client.getUser(subAccountId);
      const totalCollateral = user.getTotalCollateral().toNumber() / 1e6;
      const unrealizedPnl = user.getUnrealizedPNL(true).toNumber() / 1e6;
      const allTimePnl = user.getTotalAllTimePnl().toNumber() / 1e6;
      return { totalCollateral, unrealizedPnl, allTimePnl };
    } catch {
      return { totalCollateral: 0, unrealizedPnl: 0, allTimePnl: 0 };
    }
  }

  /** Serialize all Drift operations */
  private async withMutex(fn: () => Promise<void>): Promise<void> {
    const prev = this.mutexPromise;
    let resolve: () => void;
    this.mutexPromise = new Promise<void>((r) => (resolve = r));
    await prev;
    try {
      await fn();
    } finally {
      resolve!();
    }
  }
}
