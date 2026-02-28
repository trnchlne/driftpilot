/**
 * Open a tiny position and exit immediately (leaving it on Drift for recovery testing).
 *
 * Usage: cd bot && npx tsx src/test-open-only.ts
 */

import { config } from 'dotenv';
config();

import { DriftClient, Wallet, initialize, BN } from '@drift-labs/sdk';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { DriftExecutor } from './executor.js';
import { LiveStateManager } from './live-state.js';

const SOL_PERP_MARKET_INDEX = 0;
const SUB_ACCOUNT_ID = 0;

async function main(): Promise<void> {
  const PRIVATE_KEY = process.env.PRIVATE_KEY!;
  const RPC_URL = process.env.RPC_URL!;

  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  const wallet = new Wallet(keypair);

  initialize({ env: 'mainnet-beta' });

  const driftClient = new DriftClient({
    connection, wallet, env: 'mainnet-beta',
    activeSubAccountId: SUB_ACCOUNT_ID,
    subAccountIds: [SUB_ACCOUNT_ID],
    accountSubscription: { type: 'websocket' },
  });

  await driftClient.subscribe();

  const user = driftClient.getUser(SUB_ACCOUNT_ID);
  const existingPos = user.getPerpPosition(SOL_PERP_MARKET_INDEX);
  if (existingPos && !existingPos.baseAssetAmount.isZero()) {
    const size = existingPos.baseAssetAmount.abs().toNumber() / 1e9;
    console.log(`Position already exists (${size} SOL) — good for recovery test`);
    await driftClient.unsubscribe();
    process.exit(0);
  }

  const stateManager = new LiveStateManager();
  const executor = new DriftExecutor(driftClient, stateManager);

  const oracleData = driftClient.getOracleDataForPerpMarket(SOL_PERP_MARKET_INDEX);
  const solPrice = oracleData.price.toNumber() / 1e6;
  const slPrice = solPrice * (1 + 0.02); // 2% SL for short

  console.log(`Opening LONG 0.01 SOL @ $${solPrice.toFixed(2)} for recovery test...`);
  const filled = await executor.open('R-base', SUB_ACCOUNT_ID, 'long', 0.01, solPrice * (1 - 0.02), Date.now() / 1000, solPrice);

  if (filled) {
    console.log('Position open — now start the bot to test recovery');
  } else {
    console.log('FAILED to fill — try again');
  }

  await driftClient.unsubscribe();
  process.exit(0);
}

main().catch(console.error);
