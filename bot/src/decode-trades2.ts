/**
 * Decode ALL Drift events from recent transactions — including OrderActionRecord.
 * Lists all known event discriminators and decodes everything.
 *
 * Usage: cd bot && npx tsx src/decode-trades2.ts
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

const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const RPC_URL = process.env.RPC_URL!;

const connection = new Connection(RPC_URL, 'confirmed');
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const wallet = new Wallet(keypair);

const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const SUB_ACCOUNT_ID = 0;

initialize({ env: 'mainnet-beta' });

async function main() {
  const driftClient = new DriftClient({
    connection, wallet, env: 'mainnet-beta',
    activeSubAccountId: SUB_ACCOUNT_ID,
    subAccountIds: [SUB_ACCOUNT_ID],
    accountSubscription: { type: 'websocket' },
  });

  await driftClient.subscribe();
  const program = driftClient.program;

  // List all known event types in the IDL
  const idl = program.idl;
  console.log('=== KNOWN EVENT TYPES ===');
  if (idl.events) {
    for (const evt of idl.events) {
      console.log(`  ${evt.name}`);
    }
  }
  console.log('');

  const userAccountPubkey = getUserAccountPublicKeySync(
    DRIFT_PROGRAM_ID, wallet.publicKey, SUB_ACCOUNT_ID,
  );

  console.log(`Drift account: ${userAccountPubkey.toBase58()}\n`);

  // Fetch 200 transactions
  const signatures = await connection.getSignaturesForAddress(
    userAccountPubkey, { limit: 200 }, 'confirmed',
  );

  console.log(`Found ${signatures.length} transactions\n`);

  // Process chronologically
  const txSigs = signatures.reverse();

  // Rate limiting
  let reqCount = 0;

  for (const sigInfo of txSigs) {
    if (sigInfo.err) continue;

    // Rate limit: pause every 20 requests
    reqCount++;
    if (reqCount % 20 === 0) {
      await new Promise(r => setTimeout(r, 2000));
    }

    const tx = await connection.getParsedTransaction(sigInfo.signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx?.meta?.logMessages) continue;

    const logs = tx.meta.logMessages;
    const dataLogs = logs
      .filter(l => l.startsWith('Program data: '))
      .map(l => l.slice('Program data: '.length));

    if (dataLogs.length === 0) continue;

    const ts = sigInfo.blockTime
      ? new Date(sigInfo.blockTime * 1000).toISOString()
      : '?';

    const events: any[] = [];
    const undecoded: string[] = [];

    for (const data of dataLogs) {
      try {
        const decoded = program.coder.events.decode(data);
        if (decoded) {
          events.push(decoded);
        } else {
          undecoded.push(data);
        }
      } catch {
        undecoded.push(data);
      }
    }

    // Only show transactions with events relevant to orders/fills
    // or undecoded events that might be OrderActionRecord
    const hasOrderEvents = events.some(e =>
      e.name === 'OrderActionRecord' ||
      e.name === 'OrderRecord' ||
      e.name === 'NewUserRecord' ||
      e.name.toLowerCase().includes('order') ||
      e.name.toLowerCase().includes('fill') ||
      e.name.toLowerCase().includes('trade'),
    );

    // Show ALL decoded events (brief summary for funding/settle, full for orders)
    let printed = false;
    for (const event of events) {
      const name = event.name;
      const d = event.data;

      // Skip funding and settle events unless they're large
      if (name === 'FundingPaymentRecord') continue;
      if (name === 'SpotInterestRecord') continue;

      if (!printed) {
        console.log(`\n${ts} | ${sigInfo.signature.slice(0, 24)}...`);
        printed = true;
      }

      if (name === 'SettlePnlRecord') {
        const pnl = d.pnl ? d.pnl.toNumber() / 1e6 : 0;
        if (Math.abs(pnl) > 0.1) {
          console.log(`  [SettlePnl] $${pnl.toFixed(4)} market=${d.marketIndex}`);
        }
        continue;
      }

      if (name === 'OrderActionRecord') {
        const action = d.action ? Object.keys(d.action)[0] : '?';
        const explanation = d.actionExplanation ? Object.keys(d.actionExplanation)[0] : '';
        const dir = d.takerOrderDirection ? Object.keys(d.takerOrderDirection)[0] : '?';
        const baseF = d.baseAssetAmountFilled ? d.baseAssetAmountFilled.toNumber() / 1e9 : 0;
        const quoteF = d.quoteAssetAmountFilled ? d.quoteAssetAmountFilled.toNumber() / 1e6 : 0;
        const price = baseF > 0 ? quoteF / baseF : 0;
        const takerOid = d.takerOrderId || 0;
        const makerOid = d.makerOrderId || 0;
        const isTaker = d.taker?.toBase58() === userAccountPubkey.toBase58();
        const isMaker = d.maker?.toBase58() === userAccountPubkey.toBase58();
        const role = isTaker ? 'TAKER' : (isMaker ? 'MAKER' : '');

        console.log(
          `  [OrderAction] ${action} ${explanation ? `(${explanation})` : ''} | ` +
          `${dir} ${baseF.toFixed(4)} SOL @ $${price.toFixed(2)} ($${quoteF.toFixed(2)}) | ` +
          `taker=#${takerOid} maker=#${makerOid} | ${role}`
        );
      } else if (name === 'OrderRecord') {
        const orderType = d.order?.orderType ? Object.keys(d.order.orderType)[0] : '?';
        const dir = d.order?.direction ? Object.keys(d.order.direction)[0] : '?';
        const orderId = d.order?.orderId || 0;
        const base = d.order?.baseAssetAmount ? d.order.baseAssetAmount.toNumber() / 1e9 : 0;
        const price = d.order?.price ? d.order.price.toNumber() / 1e6 : 0;
        const trigPrice = d.order?.triggerPrice ? d.order.triggerPrice.toNumber() / 1e6 : 0;
        const reduceOnly = d.order?.reduceOnly ? 'reduceOnly' : '';

        console.log(
          `  [OrderRecord] #${orderId} ${orderType} ${dir} ${base.toFixed(4)} SOL ` +
          `price=$${price.toFixed(2)} trig=$${trigPrice.toFixed(2)} ${reduceOnly}`
        );
      } else if (name === 'SignedMsgOrderRecord') {
        const dir = d.matchingOrderParams?.direction ? Object.keys(d.matchingOrderParams.direction)[0] : '?';
        const orderType = d.matchingOrderParams?.orderType ? Object.keys(d.matchingOrderParams.orderType)[0] : '?';
        const isOurUser = d.user?.toBase58() === userAccountPubkey.toBase58();
        console.log(
          `  [SignedMsg] ${orderType} ${dir} | our_user=${isOurUser}`
        );
      } else {
        console.log(`  [${name}] (data omitted)`);
      }
    }

    // Show undecoded events
    if (undecoded.length > 0 && !printed) {
      console.log(`\n${ts} | ${sigInfo.signature.slice(0, 24)}...`);
      printed = true;
    }
    for (const raw of undecoded) {
      // Show first 8 bytes (discriminator) as hex
      const buf = Buffer.from(raw, 'base64');
      const disc = buf.slice(0, 8).toString('hex');
      console.log(`  [UNDECODED disc=${disc}] ${buf.length} bytes`);
    }
  }

  await driftClient.unsubscribe();
}

main().catch(console.error);
