/**
 * Get all transactions SIGNED by our wallet (not crank/filler txs).
 * This shows only orders WE placed.
 *
 * Usage: cd bot && npx tsx src/wallet-history.ts
 */

import { config } from 'dotenv';
config();

import {
  DriftClient,
  Wallet,
  initialize,
  getUserAccountPublicKeySync,
} from '@drift-labs/sdk';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const RPC_URL = process.env.RPC_URL!;

const connection = new Connection(RPC_URL, 'confirmed');
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const wallet = new Wallet(keypair);

const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');

initialize({ env: 'mainnet-beta' });

async function main() {
  const driftClient = new DriftClient({
    connection, wallet, env: 'mainnet-beta',
    activeSubAccountId: 0,
    subAccountIds: [0],
    accountSubscription: { type: 'websocket' },
  });

  await driftClient.subscribe();
  const program = driftClient.program;

  const userAccountPubkey = getUserAccountPublicKeySync(
    DRIFT_PROGRAM_ID, wallet.publicKey, 0,
  );

  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`Drift:  ${userAccountPubkey.toBase58()}\n`);

  // Fetch wallet's recent transactions (only ones WE signed)
  const signatures = await connection.getSignaturesForAddress(
    wallet.publicKey, { limit: 100 }, 'confirmed',
  );

  console.log(`Found ${signatures.length} wallet transactions\n`);

  let reqCount = 0;

  for (const sigInfo of signatures.reverse()) {
    if (sigInfo.err) continue;

    reqCount++;
    if (reqCount % 15 === 0) {
      await new Promise(r => setTimeout(r, 2000));
    }

    const tx = await connection.getParsedTransaction(sigInfo.signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx?.meta?.logMessages) continue;

    const logs = tx.meta.logMessages;
    const ts = sigInfo.blockTime
      ? new Date(sigInfo.blockTime * 1000).toISOString()
      : '?';

    // Check if Drift program is involved
    const isDrift = tx.transaction.message.accountKeys.some(
      k => k.pubkey.toBase58() === DRIFT_PROGRAM_ID.toBase58(),
    );
    if (!isDrift) continue;

    // Decode events
    const dataLogs = logs
      .filter(l => l.startsWith('Program data: '))
      .map(l => l.slice('Program data: '.length));

    const events: any[] = [];
    for (const data of dataLogs) {
      try {
        const decoded = program.coder.events.decode(data);
        if (decoded) events.push(decoded);
      } catch {}
    }

    // Get instruction names from logs
    const ixNames = logs
      .filter(l => l.includes('Instruction:'))
      .map(l => l.split('Instruction: ')[1])
      .filter(Boolean);

    console.log(`${ts} | ${sigInfo.signature.slice(0, 30)}...`);
    if (ixNames.length > 0) {
      console.log(`  Instructions: ${ixNames.join(', ')}`);
    }

    // Show interesting log lines
    for (const log of logs) {
      if (log.includes('perp_position') ||
          log.includes('cancel') ||
          log.includes('fulfillment') ||
          log.includes('AMM cannot') ||
          log.includes('SignedMsg order')) {
        console.log(`  ${log}`);
      }
    }

    // Show decoded events
    for (const event of events) {
      const name = event.name;
      const d = event.data;

      if (name === 'FundingPaymentRecord' || name === 'SpotInterestRecord') continue;

      if (name === 'OrderRecord') {
        const orderType = d.order?.orderType ? Object.keys(d.order.orderType)[0] : '?';
        const dir = d.order?.direction ? Object.keys(d.order.direction)[0] : '?';
        const orderId = d.order?.orderId || 0;
        const base = d.order?.baseAssetAmount ? d.order.baseAssetAmount.toNumber() / 1e9 : 0;
        const price = d.order?.price ? d.order.price.toNumber() / 1e6 : 0;
        const trigPrice = d.order?.triggerPrice ? d.order.triggerPrice.toNumber() / 1e6 : 0;
        const reduceOnly = d.order?.reduceOnly ? 'reduceOnly' : '';
        console.log(
          `  >>> ORDER #${orderId} ${orderType} ${dir} ${base.toFixed(4)} SOL ` +
          `price=$${price.toFixed(2)} trig=$${trigPrice.toFixed(2)} ${reduceOnly}`
        );
      } else if (name === 'OrderActionRecord') {
        const action = d.action ? Object.keys(d.action)[0] : '?';
        const explanation = d.actionExplanation ? Object.keys(d.actionExplanation)[0] : '';
        const baseF = d.baseAssetAmountFilled ? d.baseAssetAmountFilled.toNumber() / 1e9 : 0;
        const quoteF = d.quoteAssetAmountFilled ? d.quoteAssetAmountFilled.toNumber() / 1e6 : 0;
        const price = baseF > 0 ? quoteF / baseF : 0;
        console.log(
          `  >>> ACTION: ${action} ${explanation ? `(${explanation})` : ''} ` +
          `${baseF.toFixed(4)} SOL @ $${price.toFixed(2)}`
        );
      } else if (name === 'SettlePnlRecord') {
        const pnl = d.pnl ? d.pnl.toNumber() / 1e6 : 0;
        console.log(`  >>> SETTLE PnL: $${pnl.toFixed(4)} market=${d.marketIndex}`);
      } else if (name === 'SignedMsgOrderRecord') {
        const dir = d.matchingOrderParams?.direction ? Object.keys(d.matchingOrderParams.direction)[0] : '?';
        const orderType = d.matchingOrderParams?.orderType ? Object.keys(d.matchingOrderParams.orderType)[0] : '?';
        console.log(`  >>> SIGNED_MSG: ${orderType} ${dir}`);
      } else {
        console.log(`  >>> [${name}]`);
      }
    }

    console.log('');
  }

  await driftClient.unsubscribe();
}

main().catch(console.error);
