/**
 * Fetch recent Drift trade history for sub-account 0 from Solana transaction logs.
 *
 * Usage: cd bot && npx tsx src/check-trades.ts
 */

import { config } from 'dotenv';
config();

import {
  DriftClient,
  Wallet,
  initialize,
  getUserAccountPublicKeySync,
  BN,
} from '@drift-labs/sdk';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
if (!PRIVATE_KEY || !RPC_URL) {
  console.error('Missing .env');
  process.exit(1);
}

const connection = new Connection(RPC_URL, 'confirmed');
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const wallet = new Wallet(keypair);

// Drift program ID on mainnet
const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');

initialize({ env: 'mainnet-beta' });

const SUB_ACCOUNT_ID = 0;

async function main() {
  // Get the user's Drift account PDA
  const userAccountPubkey = getUserAccountPublicKeySync(
    DRIFT_PROGRAM_ID,
    wallet.publicKey,
    SUB_ACCOUNT_ID,
  );

  console.log(`Wallet:        ${wallet.publicKey.toBase58()}`);
  console.log(`Drift account: ${userAccountPubkey.toBase58()}`);
  console.log(`Sub-account:   ${SUB_ACCOUNT_ID}`);
  console.log('');

  // Fetch recent transaction signatures for the Drift user account
  console.log('Fetching recent transactions...');
  const signatures = await connection.getSignaturesForAddress(
    userAccountPubkey,
    { limit: 50 },
    'confirmed',
  );

  console.log(`Found ${signatures.length} recent transactions\n`);

  // Fetch and parse each transaction
  for (const sigInfo of signatures) {
    const ts = sigInfo.blockTime
      ? new Date(sigInfo.blockTime * 1000).toISOString()
      : 'unknown';

    const status = sigInfo.err ? 'FAILED' : 'OK';

    // Get full transaction with logs
    const tx = await connection.getParsedTransaction(sigInfo.signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) continue;

    // Check if this involves Drift program
    const isDrift = tx.transaction.message.accountKeys.some(
      (key) => key.pubkey.toBase58() === DRIFT_PROGRAM_ID.toBase58(),
    );

    if (!isDrift) continue;

    // Look through logs for order/fill/cancel events
    const logs = tx.meta?.logMessages || [];
    const driftLogs = logs.filter(
      (l) =>
        l.includes('OrderActionRecord') ||
        l.includes('fill') ||
        l.includes('cancel') ||
        l.includes('place') ||
        l.includes('order') ||
        l.includes('perp') ||
        l.includes('position'),
    );

    // Extract instruction data from inner instructions
    const innerIxs = tx.meta?.innerInstructions || [];

    // Parse Drift event logs (they're base64-encoded after "Program data: ")
    const eventLogs = logs.filter((l) => l.startsWith('Program data: '));

    console.log(`─── ${ts} | ${status} ───`);
    console.log(`  sig: ${sigInfo.signature}`);

    // Print relevant log lines
    for (const log of logs) {
      // Skip noise
      if (log.startsWith('Program 11111111') || log.startsWith('Program log: Instruction:')) continue;
      if (log.includes('invoke') || log.includes('success') || log.includes('consumed')) continue;

      // Show remaining Drift-relevant logs
      if (
        log.includes('order') ||
        log.includes('fill') ||
        log.includes('cancel') ||
        log.includes('position') ||
        log.includes('perp') ||
        log.includes('Program data:')
      ) {
        console.log(`  ${log}`);
      }
    }

    // Show memo if present
    const memoLog = logs.find((l) => l.includes('Memo'));
    if (memoLog) {
      console.log(`  MEMO: ${memoLog}`);
    }

    console.log('');
  }

  // Also subscribe to get current account state
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    activeSubAccountId: SUB_ACCOUNT_ID,
    subAccountIds: [SUB_ACCOUNT_ID],
    accountSubscription: { type: 'websocket' },
  });

  await driftClient.subscribe();
  const user = driftClient.getUser(SUB_ACCOUNT_ID);
  const userAccount = user.getUserAccount();

  console.log('=== CURRENT ACCOUNT STATE ===');
  console.log(`  Next order ID:      ${userAccount.nextOrderId} (${userAccount.nextOrderId - 1} orders placed)`);
  console.log(`  Settled perp PnL:   $${(userAccount.settledPerpPnl.toNumber() / 1e6).toFixed(6)}`);
  console.log(`  Cumul. funding:     $${(userAccount.cumulativePerpFunding.toNumber() / 1e6).toFixed(6)}`);
  console.log(`  Total deposits:     $${(userAccount.totalDeposits.toNumber() / 1e6).toFixed(2)}`);
  console.log(`  Total withdraws:    $${(userAccount.totalWithdraws.toNumber() / 1e6).toFixed(2)}`);
  console.log(`  Current collateral: $${(user.getTotalCollateral().toNumber() / 1e6).toFixed(2)}`);

  // Check current position
  const pos = user.getPerpPosition(0); // SOL perp market index 0
  if (pos && !pos.baseAssetAmount.isZero()) {
    const isLong = pos.baseAssetAmount.gt(new BN(0));
    const size = pos.baseAssetAmount.abs().toNumber() / 1e9;
    const quoteEntry = Math.abs(pos.quoteEntryAmount.toNumber()) / 1e6;
    const entryPrice = quoteEntry / size;
    console.log(`  Position:           ${isLong ? 'LONG' : 'SHORT'} ${size} SOL @ $${entryPrice.toFixed(2)}`);
  } else {
    console.log('  Position:           NONE');
  }

  // Show all non-empty order slots
  const orders = userAccount.orders.filter((o) => o.orderId !== 0);
  if (orders.length > 0) {
    console.log(`\n  Active orders: ${orders.length}`);
    for (const o of orders.sort((a, b) => a.orderId - b.orderId)) {
      const statusKey = Object.keys(o.status)[0];
      const typeKey = Object.keys(o.orderType)[0];
      const dirKey = Object.keys(o.direction)[0];
      console.log(`    #${o.orderId} ${statusKey} ${typeKey} ${dirKey} ${(o.baseAssetAmount.toNumber() / 1e9).toFixed(4)} SOL`);
    }
  }

  await driftClient.unsubscribe();
}

main().catch(console.error);
