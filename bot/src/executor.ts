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

const DEFAULT_MARKET_INDEX = 0; // SOL-PERP
const LIMIT_ORDER_EXPIRY_SECONDS = 30;
const FILL_POLL_INTERVAL_MS = 2000;
const FILL_POLL_MAX_WAIT_MS = 35_000; // slightly longer than expiry

export interface DriftPosition {
  direction: Direction;
  size: number;       // base asset amount
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
    useMarketOrder = false,
    marketIndex = DEFAULT_MARKET_INDEX,
  ): Promise<boolean> {
    let filled = false;
    await this.withMutex(async () => {
      const posDir = direction === 'long' ? PositionDirection.LONG : PositionDirection.SHORT;
      const baseAmount = new BN(Math.round(sizeSol * 1e9)); // BASE_PRECISION = 1e9

      // 1. Switch to subaccount
      await this.client.switchActiveUser(subAccountId);

      // 1b. Guard: check for stale position from a failed close
      let priorBaseAmount = new BN(0);
      try {
        const user = this.client.getUser(subAccountId);
        const position = user.getPerpPosition(marketIndex);
        if (position) {
          priorBaseAmount = position.baseAssetAmount;
          if (!position.baseAssetAmount.isZero()) {
            console.error(
              `[executor] STALE POSITION DETECTED sub=${subAccountId} (${stratName}) ` +
              `size=${position.baseAssetAmount.toNumber() / 1e9} — aborting open to prevent double exposure`,
            );
            return; // filled stays false → LiveTrader will unwind paper
          }
        }
      } catch { /* clean start assumed */ }

      if (useMarketOrder) {
        // ── Market order (taker) — guaranteed fill for trending entries ──
        const entryParams = getMarketOrderParams({
          marketIndex,
          direction: posDir,
          baseAssetAmount: baseAmount,
        });

        const entryTx = await this.client.placePerpOrder(entryParams);
        console.log(`[executor] MARKET ${direction.toUpperCase()} ${sizeSol} sub=${subAccountId} mkt=${marketIndex} (${stratName}) tx=${entryTx}`);

        // Market orders fill immediately — brief poll to confirm
        filled = await this.waitForFill(subAccountId, priorBaseAmount, marketIndex);
        if (!filled) {
          console.log(`[executor] MARKET ORDER NOT FILLED — unexpected (${stratName})`);
          try {
            await this.client.cancelOrders(MarketType.PERP, marketIndex, undefined, undefined, subAccountId);
          } catch { /* nothing to cancel */ }
          return;
        }

        console.log(`[executor] FILLED ${direction.toUpperCase()} ${sizeSol} sub=${subAccountId} mkt=${marketIndex} (${stratName})`);
      } else {
        // ── Post-only limit order (maker) — for ranging/reversion entries ──
        const oracleData = this.client.getOracleDataForPerpMarket(marketIndex);
        const oraclePrice = oracleData.price; // BN in PRICE_PRECISION (1e6)

        const limitPrice = oraclePrice;
        const maxTs = new BN(Math.floor(Date.now() / 1000) + LIMIT_ORDER_EXPIRY_SECONDS);

        const entryParams = getLimitOrderParams({
          marketIndex,
          direction: posDir,
          baseAssetAmount: baseAmount,
          price: limitPrice,
          postOnly: PostOnlyParams.SLIDE,
          maxTs,
        });

        const entryTx = await this.client.placePerpOrder(entryParams);
        console.log(`[executor] LIMIT ${direction.toUpperCase()} ${sizeSol} @ oracle sub=${subAccountId} mkt=${marketIndex} (${stratName}) tx=${entryTx}`);

        // Poll for fill
        filled = await this.waitForFill(subAccountId, priorBaseAmount, marketIndex);

        if (!filled) {
          console.log(`[executor] LIMIT EXPIRED — entry skipped (${stratName})`);
          try {
            await this.client.cancelOrders(MarketType.PERP, marketIndex, undefined, undefined, subAccountId);
          } catch { /* order already expired */ }
          return;
        }

        console.log(`[executor] FILLED ${direction.toUpperCase()} ${sizeSol} sub=${subAccountId} mkt=${marketIndex} (${stratName})`);
      }

      // 4. Place trigger-market SL order (reduceOnly, on-chain protection)
      const slDir = direction === 'long' ? PositionDirection.SHORT : PositionDirection.LONG;
      const triggerCondition = direction === 'long'
        ? OrderTriggerCondition.BELOW  // long → SL fires when price drops below
        : OrderTriggerCondition.ABOVE; // short → SL fires when price rises above

      const triggerPriceBN = new BN(Math.round(slPrice * 1e6)); // PRICE_PRECISION = 1e6

      const slParams = getTriggerMarketOrderParams({
        marketIndex,
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
   * Poll until position size changes from pre-order snapshot (order filled)
   * or until timeout (order expired unfilled).
   */
  private async waitForFill(subAccountId: number, priorBaseAmount: BN, marketIndex = DEFAULT_MARKET_INDEX): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < FILL_POLL_MAX_WAIT_MS) {
      try {
        const user = this.client.getUser(subAccountId);
        const position = user.getPerpPosition(marketIndex);
        const currentBase = position ? position.baseAssetAmount : new BN(0);
        // Position size changed from pre-order snapshot → order filled
        if (!currentBase.eq(priorBaseAmount)) {
          return true;
        }
      } catch { /* ignore read errors during polling */ }
      await new Promise((r) => setTimeout(r, FILL_POLL_INTERVAL_MS));
    }
    return false;
  }

  /**
   * Close a position: cancel SL trigger + market close + verify.
   * Retries once if position remains after the first close attempt.
   */
  async close(stratName: string, subAccountId: number, marketIndex = DEFAULT_MARKET_INDEX): Promise<void> {
    await this.withMutex(async () => {
      // 1. Switch to subaccount
      await this.client.switchActiveUser(subAccountId);

      // 2. Cancel all open orders (SL trigger)
      try {
        await this.client.cancelOrders(
          MarketType.PERP,
          marketIndex,
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
      const position = user.getPerpPosition(marketIndex);

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
        marketIndex,
        direction: closeDir,
        baseAssetAmount: size,
        reduceOnly: true,
      });

      const tx = await this.client.placePerpOrder(closeParams);
      console.log(`[executor] CLOSE sub=${subAccountId} (${stratName}) tx=${tx}`);

      // 5. Verify close — retry once if position still exists
      await new Promise(r => setTimeout(r, 2000));
      try {
        const userAfter = this.client.getUser(subAccountId);
        const posAfter = userAfter.getPerpPosition(marketIndex);
        if (posAfter && !posAfter.baseAssetAmount.isZero()) {
          const remainingSize = posAfter.baseAssetAmount.abs().toNumber() / 1e9;
          console.error(
            `[executor] CLOSE INCOMPLETE sub=${subAccountId} (${stratName}) — ` +
            `${remainingSize.toFixed(4)} remaining, retrying...`,
          );
          const retryDir = posAfter.baseAssetAmount.gt(new BN(0))
            ? PositionDirection.SHORT
            : PositionDirection.LONG;
          const retryParams = getMarketOrderParams({
            marketIndex,
            direction: retryDir,
            baseAssetAmount: posAfter.baseAssetAmount.abs(),
            reduceOnly: true,
          });
          const retryTx = await this.client.placePerpOrder(retryParams);
          console.log(`[executor] RETRY CLOSE sub=${subAccountId} (${stratName}) tx=${retryTx}`);

          // Final check after retry
          await new Promise(r => setTimeout(r, 2000));
          const userFinal = this.client.getUser(subAccountId);
          const posFinal = userFinal.getPerpPosition(marketIndex);
          if (posFinal && !posFinal.baseAssetAmount.isZero()) {
            const ghostSize = posFinal.baseAssetAmount.abs().toNumber() / 1e9;
            console.error(
              `[executor] *** GHOST POSITION *** sub=${subAccountId} (${stratName}) — ` +
              `${ghostSize.toFixed(4)} still open after 2 close attempts! Manual intervention needed.`,
            );
          }
        }
      } catch (err) {
        console.error(`[executor] Close verification failed sub=${subAccountId} (${stratName}):`, err);
      }

      // 6. Clear state
      this.stateManager.clear(stratName);
    });
  }

  /**
   * Read all positions across subaccounts.
   * Used for recovery on restart. Checks the given marketIndex for each strategy.
   */
  async readAllPositions(
    subAccountMap: Record<string, number>,
    strategyMarketIndices?: Record<string, number>,
  ): Promise<Map<string, DriftPosition>> {
    const result = new Map<string, DriftPosition>();

    await this.withMutex(async () => {
      for (const [stratName, subId] of Object.entries(subAccountMap)) {
        try {
          const mktIdx = strategyMarketIndices?.[stratName] ?? DEFAULT_MARKET_INDEX;
          const user = this.client.getUser(subId);
          const position = user.getPerpPosition(mktIdx);

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
   * Save the locked entry rolling mean for reversion TP recovery.
   */
  updateEntryMean(stratName: string, mean: number): void {
    const existing = this.stateManager.get(stratName);
    if (existing) {
      this.stateManager.set(stratName, { ...existing, entryRollingMean: mean });
    }
  }

  /**
   * Read account balance for a subaccount (USDC values).
   * Uses getNetUsdValue() for the true account value (no margin haircuts)
   * so the dashboard matches Drift's UI.
   * Returns both total PnL (includes SOL spot appreciation) and
   * trading-only PnL (settledPerpPnl + unrealizedPerpPnl).
   */
  readAccountBalance(subAccountId: number): {
    totalCollateral: number; unrealizedPnl: number; allTimePnl: number; tradingPnl: number; settledPerpPnl: number;
  } {
    try {
      const user = this.client.getUser(subAccountId);
      const totalCollateral = user.getNetUsdValue().toNumber() / 1e6;
      const unrealizedPnl = user.getUnrealizedPNL(true).toNumber() / 1e6;
      const allTimePnl = user.getTotalAllTimePnl().toNumber() / 1e6;
      const settledPerpPnl = user.getUserAccount().settledPerpPnl.toNumber() / 1e6;
      const tradingPnl = settledPerpPnl + unrealizedPnl;
      return { totalCollateral, unrealizedPnl, allTimePnl, tradingPnl, settledPerpPnl };
    } catch {
      return { totalCollateral: 0, unrealizedPnl: 0, allTimePnl: 0, tradingPnl: 0, settledPerpPnl: 0 };
    }
  }

  /**
   * Read perp market data: funding, OI, spread, liquidity.
   * Uses BN string parsing to avoid overflow on large values.
   */
  readMarketData(marketIndex = DEFAULT_MARKET_INDEX): {
    fundingRate: number; fundingRate24h: number; spreadBps: number; markPrice: number;
    longOI: number; shortOI: number; maxOI: number; sqrtK: number; userLpShares: number;
    usersWithPositions: number; totalUsers: number;
  } | null {
    try {
      const market = this.client.getPerpMarketAccount(marketIndex);
      if (!market) {
        console.warn(`[executor] readMarketData: no market account for index ${marketIndex}`);
        return null;
      }

      const amm = market.amm;
      const oracleData = this.client.getOracleDataForPerpMarket(marketIndex);
      const oraclePrice = oracleData.price.toNumber() / 1e6; // PRICE_PRECISION

      // Safe BN → number for potentially large values (avoids toNumber() overflow)
      const bnToNum = (bn: BN, precision: number): number =>
        parseFloat(bn.abs().toString()) / precision;

      // Funding rates (FUNDING_RATE_PRECISION = 1e9, value is proportion not %)
      const fundingRate = (parseFloat(amm.lastFundingRate.toString()) / 1e9) * 100;
      const fundingRate24h = (parseFloat(amm.last24HAvgFundingRate.toString()) / 1e9) * 100;

      // Spread in basis points (BID_ASK_SPREAD_PRECISION = 1e6 = 100%)
      const spreadBps = (amm.longSpread + amm.shortSpread) / 1e6 * 10000;

      // Open interest (BASE_PRECISION = 1e9)
      const longOI = bnToNum(amm.baseAssetAmountLong, 1e9);
      const shortOI = bnToNum(amm.baseAssetAmountShort, 1e9);
      const maxOI = bnToNum(amm.maxOpenInterest, 1e9);

      // Liquidity
      const sqrtK = bnToNum(amm.sqrtK, 1e9);
      const userLpShares = bnToNum(amm.userLpShares, 1e9);

      return {
        fundingRate,
        fundingRate24h,
        spreadBps,
        markPrice: oraclePrice,
        longOI,
        shortOI,
        maxOI,
        sqrtK,
        userLpShares,
        usersWithPositions: market.numberOfUsersWithBase,
        totalUsers: market.numberOfUsers,
      };
    } catch (err) {
      console.error('[executor] readMarketData failed:', err);
      return null;
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
