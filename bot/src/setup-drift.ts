/**
 * One-time Drift setup: create subaccounts and optionally distribute USDC.
 *
 * Usage: npx tsx src/setup-drift.ts [--fund]
 * Requires: .env with PRIVATE_KEY and RPC_URL
 *
 * What it does:
 *   1. Creates all 12 subaccounts (sub 0 already exists)
 *   2. With --fund: distributes USDC from sub 0 to trend subs (equal split)
 *   3. Prints summary of all subaccount balances
 *
 * To activate more strategies later, deposit USDC into their subs via Drift UI.
 *
 * Prerequisites:
 *   - ~0.35 SOL in wallet for subaccount rent
 *   - USDC deposited in sub 0 (for --fund)
 */

import { config } from 'dotenv';
config();

import {
  DriftClient,
  Wallet,
  initialize,
  BN,
} from '@drift-labs/sdk';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

import { STRATEGIES, SUBACCOUNT_MAP, ALL_SUB_ACCOUNT_IDS } from './strategies.js';

const USDC_SPOT_MARKET_INDEX = 0;

// Phase 1: only fund trend strategies
const FUNDED_TYPES = new Set(['trend']);

async function main(): Promise<void> {
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const RPC_URL = process.env.RPC_URL;
  const shouldFund = process.argv.includes('--fund');

  if (!PRIVATE_KEY || !RPC_URL) {
    console.error('[setup] Missing PRIVATE_KEY or RPC_URL in .env');
    process.exit(1);
  }

  console.log('[setup] Drift Subaccount Setup');
  console.log(`[setup] Creating ${ALL_SUB_ACCOUNT_IDS.length} subaccounts`);
  if (shouldFund) {
    console.log('[setup] --fund: will distribute USDC to trend subs');
  } else {
    console.log('[setup] Run with --fund to distribute USDC after creating subs');
  }
  console.log('');

  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  const wallet = new Wallet(keypair);

  // Check SOL balance for rent
  const balance = await connection.getBalance(keypair.publicKey);
  const solBalance = balance / 1e9;
  console.log(`[setup] Wallet SOL: ${solBalance.toFixed(4)}`);
  if (solBalance < 0.35) {
    console.warn(`[setup] WARNING: Need ~0.35 SOL for subaccount rent, you have ${solBalance.toFixed(4)}`);
  }

  initialize({ env: 'mainnet-beta' });

  // Start with just sub 0
  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    activeSubAccountId: 0,
    subAccountIds: [0],
    accountSubscription: { type: 'websocket' },
  });

  await driftClient.subscribe();
  console.log('[setup] Drift connected\n');

  // Step 1: Create subaccounts 1–11
  console.log('[setup] ── Creating subaccounts ──');
  for (const subId of ALL_SUB_ACCOUNT_IDS) {
    if (subId === 0) {
      console.log(`  Sub  0: exists (default)`);
      continue;
    }

    try {
      const [tx] = await driftClient.initializeUserAccount(subId);
      console.log(`  Sub ${String(subId).padStart(2)}: created (tx=${tx.slice(0, 16)}...)`);
    } catch (err: any) {
      if (err.message?.includes('already in use')) {
        console.log(`  Sub ${String(subId).padStart(2)}: already exists`);
      } else {
        console.error(`  Sub ${String(subId).padStart(2)}: FAILED`, err.message);
      }
    }
  }

  // Re-subscribe with all subaccounts
  await driftClient.unsubscribe();

  const fullClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    activeSubAccountId: 0,
    subAccountIds: ALL_SUB_ACCOUNT_IDS,
    accountSubscription: { type: 'websocket' },
  });

  await fullClient.subscribe();

  // Step 2: Distribute USDC (only with --fund)
  if (shouldFund) {
    const user0 = fullClient.getUser(0);
    const collateral0 = user0.getTotalCollateral().toNumber() / 1e6;
    console.log(`\n[setup] Sub 0 collateral: $${collateral0.toFixed(2)} USDC`);

    // Find funded strategies (trend only for now)
    const fundedStrats = STRATEGIES.filter(cfg => FUNDED_TYPES.has(cfg.type));
    const fundedSubs = fundedStrats
      .map(cfg => ({ name: cfg.name, subId: SUBACCOUNT_MAP[cfg.name]! }))
      .filter(s => s.subId !== 0); // sub 0 keeps its share in place

    if (collateral0 < 10) {
      console.log('[setup] Not enough USDC to distribute (need $10+). Deposit USDC into sub 0 first.');
    } else {
      // Equal split across funded subs, keeping sub 0's share for T-champion
      const numFunded = fundedStrats.length; // includes sub 0
      const perSub = (collateral0 * 0.95) / numFunded; // 95% distributed, 5% buffer in sub 0

      console.log(`[setup] Splitting across ${numFunded} trend subs: $${perSub.toFixed(2)} each\n`);

      console.log('[setup] ── Transferring USDC ──');
      console.log(`  Sub  0 (T-champion     ): keeping ~$${perSub.toFixed(2)} in place`);

      for (const { subId, name } of fundedSubs) {
        const amountBN = new BN(Math.floor(perSub * 1e6));
        try {
          const tx = await fullClient.transferDeposit(
            amountBN,
            USDC_SPOT_MARKET_INDEX,
            0,     // from sub 0
            subId, // to
          );
          console.log(`  Sub ${String(subId).padStart(2)} (${name.padEnd(15)}): $${perSub.toFixed(2)} transferred (tx=${tx.slice(0, 16)}...)`);
        } catch (err: any) {
          console.error(`  Sub ${String(subId).padStart(2)} (${name.padEnd(15)}): TRANSFER FAILED`, err.message);
        }
      }
    }
  }

  // Step 3: Print all balances
  console.log('\n[setup] ── All subaccounts ──');
  console.log('  Sub  Strategy         Balance    Status');
  console.log('  ───  ───────────────  ─────────  ──────');
  for (const subId of ALL_SUB_ACCOUNT_IDS) {
    const stratName = Object.entries(SUBACCOUNT_MAP).find(([, id]) => id === subId)?.[0] || '??';
    const cfg = STRATEGIES.find(s => s.name === stratName);
    try {
      const user = fullClient.getUser(subId);
      const collateral = user.getTotalCollateral().toNumber() / 1e6;
      const status = collateral > 0.01 ? 'FUNDED' : 'empty';
      const phase = cfg && FUNDED_TYPES.has(cfg.type) ? '' : ' (activate later)';
      console.log(
        `  ${String(subId).padStart(3)}  ${stratName.padEnd(15)}  $${collateral.toFixed(2).padStart(8)}  ${status}${phase}`,
      );
    } catch {
      console.log(`  ${String(subId).padStart(3)}  ${stratName.padEnd(15)}      --    unable to read`);
    }
  }

  await fullClient.unsubscribe();
  console.log('\n[setup] Done!');
  if (!shouldFund) {
    console.log('[setup] To distribute USDC: npx tsx src/setup-drift.ts --fund');
  }
  console.log('[setup] To activate more strategies: deposit USDC into their subs via app.drift.trade');
  console.log('[setup] To start live trading: npx tsx src/live.ts');
}

main().catch((err) => {
  console.error('[setup] Fatal error:', err);
  process.exit(1);
});
