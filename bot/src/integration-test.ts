/**
 * Integration test: connect to Drift, open a tiny SOL-PERP position, close it.
 * Run: npx tsx src/integration-test.ts
 * Reads PRIVATE_KEY and RPC_URL from .env
 */

import { config } from 'dotenv';
config();

import {
  DriftClient,
  Wallet,
  getMarketOrderParams,
  PositionDirection,
  BN,
  initialize,
  convertToNumber,
  QUOTE_PRECISION,
  BASE_PRECISION,
} from '@drift-labs/sdk';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const SOL_PERP_MARKET_INDEX = 0;
// Tiny test: 0.01 SOL (~$0.80)
const TEST_SIZE_SOL = 0.01;

async function main() {
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const RPC_URL = process.env.RPC_URL;

  if (!PRIVATE_KEY || !RPC_URL) {
    console.error('Missing PRIVATE_KEY or RPC_URL in .env');
    process.exit(1);
  }

  console.log('[test] Starting Drift integration test...');
  console.log(`[test] RPC: ${RPC_URL.slice(0, 40)}...`);

  // 1. Connect
  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  const wallet = new Wallet(keypair);

  console.log(`[test] Wallet: ${keypair.publicKey.toBase58()}`);

  // Check SOL balance
  const solBalance = await connection.getBalance(keypair.publicKey);
  console.log(`[test] SOL balance: ${solBalance / LAMPORTS_PER_SOL} SOL`);

  if (solBalance < 0.005 * LAMPORTS_PER_SOL) {
    console.error('[test] Need at least 0.005 SOL for tx fees');
    process.exit(1);
  }

  // 2. Init Drift
  console.log('[test] Initializing Drift client...');
  initialize({ env: 'mainnet-beta' });

  const client = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    activeSubAccountId: 0,
    subAccountIds: [0],
    accountSubscription: { type: 'websocket' },
  });

  await client.subscribe();
  console.log('[test] Drift subscribed');

  // 3. Check collateral
  const user = client.getUser();
  const freeCollateral = convertToNumber(user.getFreeCollateral(), QUOTE_PRECISION);
  const totalCollateral = convertToNumber(user.getTotalCollateral(), QUOTE_PRECISION);
  console.log(`[test] Collateral — total: $${totalCollateral.toFixed(2)}, free: $${freeCollateral.toFixed(2)}`);

  if (freeCollateral < 1) {
    console.error('[test] Need at least $1 free collateral on Drift subaccount 0');
    await client.unsubscribe();
    process.exit(1);
  }

  // 4. Check existing position
  const existingPos = user.getPerpPosition(SOL_PERP_MARKET_INDEX);
  if (existingPos && !existingPos.baseAssetAmount.isZero()) {
    console.log(`[test] WARNING: existing SOL-PERP position detected (${existingPos.baseAssetAmount.toString()} base units)`);
    console.log('[test] Aborting to avoid interfering with existing position');
    await client.unsubscribe();
    process.exit(1);
  }

  // 5. Open a tiny LONG
  const baseAmount = new BN(TEST_SIZE_SOL * 1e9);
  console.log(`\n[test] === OPENING LONG ${TEST_SIZE_SOL} SOL-PERP ===`);

  const openParams = getMarketOrderParams({
    marketIndex: SOL_PERP_MARKET_INDEX,
    direction: PositionDirection.LONG,
    baseAssetAmount: baseAmount,
  });

  const openTx = await client.placePerpOrder(openParams);
  console.log(`[test] Open tx: ${openTx}`);

  // Wait for position to settle
  console.log('[test] Waiting 5s for position to settle...');
  await new Promise((r) => setTimeout(r, 5000));

  // 6. Check position
  const posAfterOpen = user.getPerpPosition(SOL_PERP_MARKET_INDEX);
  if (posAfterOpen && !posAfterOpen.baseAssetAmount.isZero()) {
    const posSize = convertToNumber(posAfterOpen.baseAssetAmount, BASE_PRECISION);
    console.log(`[test] Position confirmed: ${posSize.toFixed(4)} SOL`);
  } else {
    console.log('[test] WARNING: position not visible yet (may still be filling)');
  }

  // 7. Close position
  console.log(`\n[test] === CLOSING POSITION ===`);

  const closeParams = getMarketOrderParams({
    marketIndex: SOL_PERP_MARKET_INDEX,
    direction: PositionDirection.SHORT,
    baseAssetAmount: baseAmount,
    reduceOnly: true,
  });

  const closeTx = await client.placePerpOrder(closeParams);
  console.log(`[test] Close tx: ${closeTx}`);

  // Wait and check final state
  console.log('[test] Waiting 5s for close to settle...');
  await new Promise((r) => setTimeout(r, 5000));

  const posAfterClose = user.getPerpPosition(SOL_PERP_MARKET_INDEX);
  const finalCollateral = convertToNumber(user.getTotalCollateral(), QUOTE_PRECISION);

  if (!posAfterClose || posAfterClose.baseAssetAmount.isZero()) {
    console.log('[test] Position closed successfully');
  } else {
    const remaining = convertToNumber(posAfterClose.baseAssetAmount, BASE_PRECISION);
    console.log(`[test] WARNING: position still open: ${remaining.toFixed(4)} SOL`);
  }

  const pnl = finalCollateral - totalCollateral;
  console.log(`\n[test] === RESULT ===`);
  console.log(`[test] Collateral before: $${totalCollateral.toFixed(4)}`);
  console.log(`[test] Collateral after:  $${finalCollateral.toFixed(4)}`);
  console.log(`[test] Net P&L:           $${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} (includes fees + slippage)`);

  // 8. Cleanup
  await client.unsubscribe();
  console.log('\n[test] Integration test complete!');
}

main().catch((err) => {
  console.error('[test] Fatal error:', err);
  process.exit(1);
});
