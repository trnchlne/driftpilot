import {
  DriftClient,
  Wallet,
  getMarketOrderParams,
  PositionDirection,
  BN,
  initialize,
} from '@drift-labs/sdk';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Direction } from './detector.js';

const SOL_PERP_MARKET_INDEX = 0;

export class DriftWrapper {
  private client: DriftClient;
  private dryRun: boolean;
  private mutexPromise: Promise<void> = Promise.resolve();

  constructor(client: DriftClient, dryRun: boolean) {
    this.client = client;
    this.dryRun = dryRun;
  }

  static async create(
    rpcUrl: string,
    privateKey: string,
    subAccountIds: number[],
    dryRun: boolean,
  ): Promise<DriftWrapper> {
    const connection = new Connection(rpcUrl, 'confirmed');
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
    const wallet = new Wallet(keypair);

    initialize({ env: 'mainnet-beta' });

    const client = new DriftClient({
      connection,
      wallet,
      env: 'mainnet-beta',
      activeSubAccountId: subAccountIds[0],
      subAccountIds,
      accountSubscription: { type: 'websocket' },
    });

    await client.subscribe();

    // Ensure subaccounts exist
    const existingIds = new Set(
      client.getUser()
        ? subAccountIds.filter((id) => {
            try {
              client.switchActiveUser(id);
              return true;
            } catch {
              return false;
            }
          })
        : [],
    );

    for (const id of subAccountIds) {
      if (!existingIds.has(id) && id !== 0) {
        try {
          if (!dryRun) {
            await client.initializeUserAccount(id);
            console.log(`[drift] Created subaccount ${id}`);
          } else {
            console.log(`[drift] Would create subaccount ${id} (DRY RUN)`);
          }
        } catch (err: any) {
          // Already exists is fine
          if (!err.message?.includes('already in use')) {
            console.error(`[drift] Failed to create subaccount ${id}:`, err);
          }
        }
      }
    }

    // Switch back to first subaccount
    client.switchActiveUser(subAccountIds[0]);

    return new DriftWrapper(client, dryRun);
  }

  async openPosition(
    subAccountId: number,
    direction: Direction,
    solAmount: number,
  ): Promise<void> {
    await this.withMutex(async () => {
      const posDir =
        direction === 'long'
          ? PositionDirection.LONG
          : PositionDirection.SHORT;

      const baseAmount = new BN(solAmount * 1e9);

      if (this.dryRun) {
        console.log(
          `[drift] DRY RUN: open ${direction.toUpperCase()} ${solAmount} SOL on sub ${subAccountId}`,
        );
        return;
      }

      this.client.switchActiveUser(subAccountId);

      const orderParams = getMarketOrderParams({
        marketIndex: SOL_PERP_MARKET_INDEX,
        direction: posDir,
        baseAssetAmount: baseAmount,
      });

      const tx = await this.client.placePerpOrder(orderParams);
      console.log(`[drift] Opened ${direction.toUpperCase()} on sub ${subAccountId} tx: ${tx}`);
    });
  }

  async closePosition(subAccountId: number): Promise<void> {
    await this.withMutex(async () => {
      if (this.dryRun) {
        console.log(`[drift] DRY RUN: close position on sub ${subAccountId}`);
        return;
      }

      this.client.switchActiveUser(subAccountId);

      const user = this.client.getUser();
      const position = user.getPerpPosition(SOL_PERP_MARKET_INDEX);

      if (!position || position.baseAssetAmount.isZero()) {
        console.log(`[drift] No position to close on sub ${subAccountId}`);
        return;
      }

      const isLong = position.baseAssetAmount.gt(new BN(0));
      const closeDir = isLong ? PositionDirection.SHORT : PositionDirection.LONG;
      const size = position.baseAssetAmount.abs();

      const orderParams = getMarketOrderParams({
        marketIndex: SOL_PERP_MARKET_INDEX,
        direction: closeDir,
        baseAssetAmount: size,
        reduceOnly: true,
      });

      const tx = await this.client.placePerpOrder(orderParams);
      console.log(`[drift] Closed position on sub ${subAccountId} tx: ${tx}`);
    });
  }

  async disconnect(): Promise<void> {
    await this.client.unsubscribe();
  }

  private async withMutex(fn: () => Promise<void>): Promise<void> {
    const prev = this.mutexPromise;
    let resolve: () => void;
    this.mutexPromise = new Promise<void>((r) => (resolve = r));
    await prev;
    try {
      await fn();
    } finally {
      resolve!();
    }
  }
}
