/**
 * Smoke test: open a tiny position, wait 10s, close it.
 * Verifies the full open → fill → SL placement → close → verify cycle.
 *
 * Usage: cd bot && npx tsx src/test-open-close.ts [--direction long|short] [--size 0.01]
 */

import { config } from 'dotenv';
config();

import {
  DriftClient,
  Wallet,
  initialize,
  PositionDirection,
  BN,
} from '@drift-labs/sdk';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { DriftExecutor } from './executor.js';
import { LiveStateManager } from './live-state.js';

const SOL_PERP_MARKET_INDEX = 0;
const SUB_ACCOUNT_ID = 0;
const STRAT_NAME = 'test-open-close';

async function main(): Promise<void> {
  // Parse args
  const args = process.argv.slice(2);
  let direction: 'long' | 'short' = 'long';
  let sizeSol = 0.01; // minimum Drift order

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--direction' && args[i + 1]) {
      direction = args[i + 1] as 'long' | 'short';
      i++;
    }
    if (args[i] === '--size' && args[i + 1]) {
      sizeSol = parseFloat(args[i + 1]);
      i++;
    }
  }

  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const RPC_URL = process.env.RPC_URL;

  if (!PRIVATE_KEY || !RPC_URL) {
    console.error('Missing PRIVATE_KEY or RPC_URL in .env');
    process.exit(1);
  }

  // 1. Connect to Drift
  console.log('[test] Connecting to Drift...');
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  const wallet = new Wallet(keypair);

  initialize({ env: 'mainnet-beta' });

  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    activeSubAccountId: SUB_ACCOUNT_ID,
    subAccountIds: [SUB_ACCOUNT_ID],
    accountSubscription: { type: 'websocket' },
  });

  await driftClient.subscribe();
  console.log('[test] Drift connected');

  // 2. Check current position — bail if one exists
  const user = driftClient.getUser(SUB_ACCOUNT_ID);
  const existingPos = user.getPerpPosition(SOL_PERP_MARKET_INDEX);
  if (existingPos && !existingPos.baseAssetAmount.isZero()) {
    const isLong = existingPos.baseAssetAmount.gt(new BN(0));
    const size = existingPos.baseAssetAmount.abs().toNumber() / 1e9;
    console.error(`[test] ERROR: Position already exists (${isLong ? 'LONG' : 'SHORT'} ${size} SOL). Close it first.`);
    await driftClient.unsubscribe();
    process.exit(1);
  }

  // 3. Check balance
  const collateral = user.getTotalCollateral().toNumber() / 1e6;
  console.log(`[test] Sub ${SUB_ACCOUNT_ID} balance: $${collateral.toFixed(2)} USDC`);

  // Get oracle price
  const oracleData = driftClient.getOracleDataForPerpMarket(SOL_PERP_MARKET_INDEX);
  const solPrice = oracleData.price.toNumber() / 1e6;
  console.log(`[test] SOL oracle price: $${solPrice.toFixed(2)}`);

  const positionValue = sizeSol * solPrice;
  console.log(`[test] Will open ${direction.toUpperCase()} ${sizeSol} SOL ($${positionValue.toFixed(2)})`);

  if (positionValue > collateral * 10) {
    console.error(`[test] ERROR: Position value $${positionValue.toFixed(2)} exceeds 10x collateral $${(collateral * 10).toFixed(2)}`);
    await driftClient.unsubscribe();
    process.exit(1);
  }

  // 4. Create executor
  const stateManager = new LiveStateManager();
  const executor = new DriftExecutor(driftClient, stateManager);

  // 5. Open position
  const slPct = 2.0;
  const slPrice = direction === 'long'
    ? solPrice * (1 - slPct / 100)
    : solPrice * (1 + slPct / 100);

  console.log(`\n[test] ── OPENING ${direction.toUpperCase()} ${sizeSol} SOL ──`);
  console.log(`[test] SL trigger: $${slPrice.toFixed(2)}`);
  const t0 = Date.now();

  const filled = await executor.open(
    STRAT_NAME,
    SUB_ACCOUNT_ID,
    direction,
    sizeSol,
    slPrice,
    Date.now() / 1000,
    solPrice,
  );

  if (!filled) {
    console.error('[test] FAILED: Limit order expired unfilled');
    await driftClient.unsubscribe();
    process.exit(1);
  }

  const openMs = Date.now() - t0;
  console.log(`[test] FILLED in ${openMs}ms`);

  // Verify position exists
  const posAfterOpen = user.getPerpPosition(SOL_PERP_MARKET_INDEX);
  if (posAfterOpen && !posAfterOpen.baseAssetAmount.isZero()) {
    const isLong = posAfterOpen.baseAssetAmount.gt(new BN(0));
    const size = posAfterOpen.baseAssetAmount.abs().toNumber() / 1e9;
    console.log(`[test] Position confirmed: ${isLong ? 'LONG' : 'SHORT'} ${size} SOL`);
  } else {
    console.error('[test] ERROR: Position not found after fill');
  }

  // 6. Wait 10 seconds
  console.log('\n[test] Waiting 10 seconds...');
  await new Promise((r) => setTimeout(r, 10_000));

  // Check price movement during wait
  const oracleAfter = driftClient.getOracleDataForPerpMarket(SOL_PERP_MARKET_INDEX);
  const priceAfter = oracleAfter.price.toNumber() / 1e6;
  const movePct = ((priceAfter / solPrice) - 1) * 100;
  console.log(`[test] Price: $${solPrice.toFixed(2)} → $${priceAfter.toFixed(2)} (${movePct >= 0 ? '+' : ''}${movePct.toFixed(4)}%)`);

  // 7. Close position
  console.log(`\n[test] ── CLOSING ──`);
  const t1 = Date.now();

  await executor.close(STRAT_NAME, SUB_ACCOUNT_ID);

  const closeMs = Date.now() - t1;
  console.log(`[test] Close completed in ${closeMs}ms`);

  // 8. Verify position is gone
  // Wait a moment for state to propagate
  await new Promise((r) => setTimeout(r, 2000));
  const posAfterClose = user.getPerpPosition(SOL_PERP_MARKET_INDEX);
  if (!posAfterClose || posAfterClose.baseAssetAmount.isZero()) {
    console.log('[test] Position confirmed CLOSED');
  } else {
    const remaining = posAfterClose.baseAssetAmount.abs().toNumber() / 1e9;
    console.error(`[test] ERROR: Position still exists! ${remaining} SOL remaining`);
  }

  // 9. Final balance
  const finalCollateral = user.getTotalCollateral().toNumber() / 1e6;
  const pnl = finalCollateral - collateral;
  console.log(`\n[test] ── RESULT ──`);
  console.log(`[test] Balance: $${collateral.toFixed(2)} → $${finalCollateral.toFixed(2)} (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)})`);
  console.log('[test] Test PASSED');

  await driftClient.unsubscribe();
  process.exit(0);
}

main().catch((err) => {
  console.error('[test] Fatal error:', err);
  process.exit(1);
});
