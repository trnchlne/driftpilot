/**
 * Quick balance check: reads Drift subaccount balances.
 * Usage: npx tsx src/check-balance.ts [--sub 12]
 */

import { config } from 'dotenv';
config();

import { DriftClient, Wallet, initialize, BN } from '@drift-labs/sdk';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { SUBACCOUNT_MAP } from './strategies.js';

const SOL_PERP_MARKET_INDEX = 0;

async function main(): Promise<void> {
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const RPC_URL = process.env.RPC_URL;

  if (!PRIVATE_KEY || !RPC_URL) {
    console.error('Missing PRIVATE_KEY or RPC_URL in .env');
    process.exit(1);
  }

  // Parse --sub arg
  const args = process.argv.slice(2);
  let filterSub: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sub' && args[i + 1]) {
      filterSub = parseInt(args[i + 1], 10);
      i++;
    }
  }

  const connection = new Connection(RPC_URL, 'confirmed');
  const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  const wallet = new Wallet(keypair);

  // Check SOL balance
  const solBalance = await connection.getBalance(keypair.publicKey);
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`SOL balance: ${(solBalance / 1e9).toFixed(4)} SOL`);
  console.log('');

  // Determine which subs to check
  const allSubs = Object.entries(SUBACCOUNT_MAP);
  const subsToCheck = filterSub !== null
    ? allSubs.filter(([, id]) => id === filterSub)
    : allSubs;

  const subIds = subsToCheck.map(([, id]) => id);

  initialize({ env: 'mainnet-beta' });

  const driftClient = new DriftClient({
    connection,
    wallet,
    env: 'mainnet-beta',
    activeSubAccountId: subIds[0],
    subAccountIds: subIds,
    accountSubscription: { type: 'websocket' },
  });

  try {
    await driftClient.subscribe();
  } catch (err: any) {
    console.error('Failed to subscribe to Drift:', err.message);
    console.log('Subaccount(s) may not exist yet. Run: npx tsx src/setup-drift.ts');
    process.exit(1);
  }

  console.log('  Sub  Strategy         USDC Balance   Position');
  console.log('  ───  ───────────────  ────────────   ────────');

  let totalUsdc = 0;

  for (const [name, subId] of subsToCheck) {
    try {
      const user = driftClient.getUser(subId);
      const collateral = user.getTotalCollateral().toNumber() / 1e6;
      totalUsdc += collateral;

      const position = user.getPerpPosition(SOL_PERP_MARKET_INDEX);
      let posStr = 'none';
      if (position && !position.baseAssetAmount.isZero()) {
        const isLong = position.baseAssetAmount.gt(new BN(0));
        const size = position.baseAssetAmount.abs().toNumber() / 1e9;
        const quoteEntry = Math.abs(position.quoteEntryAmount.toNumber()) / 1e6;
        const baseEntry = position.baseAssetAmount.abs().toNumber() / 1e9;
        const entryPrice = baseEntry > 0 ? quoteEntry / baseEntry : 0;
        posStr = `${isLong ? 'LONG' : 'SHORT'} ${size.toFixed(4)} SOL @ $${entryPrice.toFixed(2)}`;
      }

      console.log(
        `  ${String(subId).padStart(3)}  ${name.padEnd(15)}  $${collateral.toFixed(2).padStart(11)}   ${posStr}`,
      );
    } catch (err: any) {
      console.log(`  ${String(subId).padStart(3)}  ${name.padEnd(15)}      -- ERROR    ${err.message?.slice(0, 40)}`);
    }
  }

  console.log('');
  console.log(`  Total USDC across checked subs: $${totalUsdc.toFixed(2)}`);

  await driftClient.unsubscribe();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
