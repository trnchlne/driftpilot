/**
 * Decode Drift Protocol events from recent transactions to understand trade history.
 *
 * Usage: cd bot && npx tsx src/decode-trades.ts
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
import * as anchor from '@coral-xyz/anchor';
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

const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const SUB_ACCOUNT_ID = 0;

initialize({ env: 'mainnet-beta' });

function formatBN(bn: any, decimals: number): string {
  if (!bn) return '0';
  const val = typeof bn.toNumber === 'function' ? bn.toNumber() : Number(bn);
  return (val / Math.pow(10, decimals)).toFixed(decimals === 6 ? 6 : 9);
}

function formatDirection(dir: any): string {
  if (!dir) return '?';
  if (typeof dir === 'object') return Object.keys(dir)[0];
  return String(dir);
}

function formatOrderType(ot: any): string {
  if (!ot) return '?';
  if (typeof ot === 'object') return Object.keys(ot)[0];
  return String(ot);
}

function formatAction(action: any): string {
  if (!action) return '?';
  if (typeof action === 'object') return Object.keys(action)[0];
  return String(action);
}

async function main() {
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    activeSubAccountId: SUB_ACCOUNT_ID,
    subAccountIds: [SUB_ACCOUNT_ID],
    accountSubscription: { type: 'websocket' },
  });

  await driftClient.subscribe();

  // Get the program for IDL event parsing
  const program = driftClient.program;

  const userAccountPubkey = getUserAccountPublicKeySync(
    DRIFT_PROGRAM_ID,
    wallet.publicKey,
    SUB_ACCOUNT_ID,
  );

  console.log(`Wallet:        ${wallet.publicKey.toBase58()}`);
  console.log(`Drift account: ${userAccountPubkey.toBase58()}\n`);

  // Fetch recent transactions
  console.log('Fetching recent transactions...\n');
  const signatures = await connection.getSignaturesForAddress(
    userAccountPubkey,
    { limit: 100 },
    'confirmed',
  );

  console.log(`Found ${signatures.length} transactions\n`);
  console.log('='.repeat(80));

  for (const sigInfo of signatures.reverse()) {
    const ts = sigInfo.blockTime
      ? new Date(sigInfo.blockTime * 1000).toISOString()
      : 'unknown';

    if (sigInfo.err) continue; // skip failed txs

    const tx = await connection.getParsedTransaction(sigInfo.signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.meta?.logMessages) continue;

    const logs = tx.meta.logMessages;

    // Extract "Program data:" entries which are Drift events
    const dataLogs = logs
      .filter((l) => l.startsWith('Program data: '))
      .map((l) => l.slice('Program data: '.length));

    if (dataLogs.length === 0) {
      // Check for interesting non-event logs
      const interesting = logs.filter(
        (l) =>
          l.includes('margin_ratio') ||
          l.includes('fulfillment') ||
          l.includes('cancel') ||
          l.includes('AMM cannot'),
      );
      if (interesting.length > 0) {
        console.log(`\n${ts} | ${sigInfo.signature.slice(0, 20)}...`);
        for (const l of interesting) {
          console.log(`  ${l}`);
        }
      }
      continue;
    }

    // Try to decode events using the Drift IDL
    const events: any[] = [];
    for (const data of dataLogs) {
      try {
        const decoded = program.coder.events.decode(data);
        if (decoded) {
          events.push(decoded);
        }
      } catch {
        // skip unparseable
      }
    }

    if (events.length === 0) continue;

    console.log(`\n${ts} | ${sigInfo.signature.slice(0, 20)}...`);

    for (const event of events) {
      const name = event.name;
      const d = event.data;

      if (name === 'OrderActionRecord') {
        const action = formatAction(d.action);
        const actionExplanation = d.actionExplanation
          ? formatAction(d.actionExplanation)
          : '';
        const marketIndex = d.marketIndex;
        const dir = formatDirection(d.takerOrderDirection || d.makerOrderDirection);
        const fillBase = d.baseAssetAmountFilled
          ? (d.baseAssetAmountFilled.toNumber() / 1e9).toFixed(4)
          : '0';
        const fillQuote = d.quoteAssetAmountFilled
          ? (d.quoteAssetAmountFilled.toNumber() / 1e6).toFixed(2)
          : '0';
        const takerOrderId = d.takerOrderId || 0;
        const makerOrderId = d.makerOrderId || 0;

        // Calculate fill price
        const baseNum = d.baseAssetAmountFilled ? d.baseAssetAmountFilled.toNumber() : 0;
        const quoteNum = d.quoteAssetAmountFilled ? d.quoteAssetAmountFilled.toNumber() : 0;
        const fillPrice = baseNum > 0 ? (quoteNum / 1e6) / (baseNum / 1e9) : 0;

        const isTaker = d.taker && d.taker.toBase58() === userAccountPubkey.toBase58();
        const isMaker = d.maker && d.maker.toBase58() === userAccountPubkey.toBase58();

        let role = '';
        if (isTaker) role = 'TAKER';
        if (isMaker) role = 'MAKER';
        if (isTaker && isMaker) role = 'SELF';

        console.log(
          `  [OrderAction] ${action} ${actionExplanation ? `(${actionExplanation})` : ''} | ` +
          `market=${marketIndex} ${dir} | ` +
          `filled=${fillBase} SOL @ $${fillPrice.toFixed(2)} ($${fillQuote}) | ` +
          `orderId: taker=#${takerOrderId} maker=#${makerOrderId} | ` +
          `${role}`,
        );
      } else if (name === 'OrderRecord') {
        const orderType = formatOrderType(d.order?.orderType);
        const dir = formatDirection(d.order?.direction);
        const orderId = d.order?.orderId || 0;
        const base = d.order?.baseAssetAmount
          ? (d.order.baseAssetAmount.toNumber() / 1e9).toFixed(4)
          : '0';
        const price = d.order?.price
          ? (d.order.price.toNumber() / 1e6).toFixed(2)
          : '0';
        const trigPrice = d.order?.triggerPrice
          ? (d.order.triggerPrice.toNumber() / 1e6).toFixed(2)
          : '0';
        const reduceOnly = d.order?.reduceOnly ? 'reduceOnly' : '';
        const status = d.order?.status ? formatOrderType(d.order.status) : '';

        console.log(
          `  [OrderRecord] #${orderId} ${status} ${orderType} ${dir} ${base} SOL | ` +
          `price=$${price} trig=$${trigPrice} ${reduceOnly}`,
        );
      } else if (name === 'SettlePnlRecord') {
        const pnl = d.pnl ? (d.pnl.toNumber() / 1e6).toFixed(4) : '0';
        console.log(`  [SettlePnl] PnL=$${pnl} market=${d.marketIndex}`);
      } else if (name === 'FundingPaymentRecord') {
        const payment = d.fundingPayment
          ? (d.fundingPayment.toNumber() / 1e6).toFixed(6)
          : '0';
        console.log(`  [Funding] payment=$${payment} market=${d.marketIndex}`);
      } else {
        // Generic event
        console.log(`  [${name}] ${JSON.stringify(d, (k, v) => {
          if (v && typeof v === 'object' && 'toNumber' in v) return v.toNumber();
          if (v && typeof v === 'object' && 'toBase58' in v) return v.toBase58();
          return v;
        }).slice(0, 200)}`);
      }
    }
  }

  console.log('\n' + '='.repeat(80));
  await driftClient.unsubscribe();
}

main().catch(console.error);
