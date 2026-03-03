import { config } from 'dotenv';
config();
import { DriftClient, Wallet, initialize } from '@drift-labs/sdk';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
if (!PRIVATE_KEY || !RPC_URL) { console.error('Missing .env'); process.exit(1); }

const connection = new Connection(RPC_URL, 'confirmed');
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const wallet = new Wallet(keypair);
initialize({ env: 'mainnet-beta' });

const driftClient = new DriftClient({
  connection, wallet, env: 'mainnet-beta',
  activeSubAccountId: 0, subAccountIds: [0],
  accountSubscription: { type: 'websocket' },
});

async function main() {
  await driftClient.subscribe();
  const user = driftClient.getUser(0);
  const userAccount = user.getUserAccount();

  console.log('=== ALL ORDERS (non-empty, sorted by ID) ===\n');
  const orders = userAccount.orders.filter(o => o.orderId !== 0);
  for (const o of orders.sort((a, b) => a.orderId - b.orderId)) {
    const statusKey = Object.keys(o.status)[0];
    const typeKey = Object.keys(o.orderType)[0];
    const dirKey = Object.keys(o.direction)[0];
    const trigKey = Object.keys(o.triggerCondition)[0];
    const base = o.baseAssetAmount.toNumber() / 1e9;
    const price = o.price.toNumber() / 1e6;
    const trigPrice = o.triggerPrice.toNumber() / 1e6;
    const maxTs = o.maxTs.toNumber();
    const maxTsDate = maxTs > 0 ? new Date(maxTs * 1000).toISOString() : 'none';

    console.log(
      `  #${String(o.orderId).padStart(3)} | ` +
      `${statusKey.padEnd(10)} | ` +
      `${typeKey.padEnd(14)} | ` +
      `${dirKey.padEnd(6)} | ` +
      `${base.toFixed(4)} SOL | ` +
      `price=${price > 0 ? '$' + price.toFixed(2) : '-'.padStart(7)} | ` +
      `trig=${trigPrice > 0 ? '$' + trigPrice.toFixed(2) : '-'.padStart(7)} ${trigKey} | ` +
      `${o.reduceOnly ? 'reduceOnly' : '          '} | ` +
      `maxTs=${maxTsDate}`
    );
  }

  console.log('\n=== ACCOUNT SUMMARY ===');
  console.log(`  Total deposits:     $${(userAccount.totalDeposits.toNumber() / 1e6).toFixed(2)}`);
  console.log(`  Total withdraws:    $${(userAccount.totalWithdraws.toNumber() / 1e6).toFixed(2)}`);
  console.log(`  Settled perp PnL:   $${(userAccount.settledPerpPnl.toNumber() / 1e6).toFixed(4)}`);
  console.log(`  Cumul. funding:     $${(userAccount.cumulativePerpFunding.toNumber() / 1e6).toFixed(4)}`);
  console.log(`  Next order ID:      ${userAccount.nextOrderId} (${userAccount.nextOrderId - 1} orders placed total)`);
  console.log(`  Liquidations:       ${userAccount.nextLiquidationId - 1}`);
  console.log(`  Current collateral: $${(user.getTotalCollateral().toNumber() / 1e6).toFixed(2)}`);

  await driftClient.unsubscribe();
}
main().catch(console.error);
