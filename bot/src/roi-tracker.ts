/**
 * ROI Tracker — computes time-weighted daily returns from Drift data API.
 *
 * Fetches daily account snapshots + deposit/withdrawal history,
 * then calculates daily ROI, average daily ROI, annualized ROI,
 * and cumulative TWR (time-weighted return). Handles deposits
 * correctly so adding funds doesn't inflate ROI.
 *
 * No local state — everything is recomputed from API data on each refresh.
 */

import { getUserAccountPublicKeySync } from '@drift-labs/sdk';
import { PublicKey } from '@solana/web3.js';

const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const DATA_API = 'https://data.api.drift.trade';
const REFRESH_INTERVAL_MS = 5 * 60_000; // 5 minutes
const SNAPSHOT_DAYS = 100;

interface DailySnapshot {
  ts: number;
  accountBalance: number;
  unrealizedPnl: number;
}

interface DepositRecord {
  ts: number;
  amount: number;
  direction: 'deposit' | 'withdraw';
}

export interface SubRoi {
  dailyRoi: number;      // today's return %
  avgDailyRoi: number;   // geometric mean of daily returns %
  annualizedRoi: number;  // (1 + avgDaily)^365 - 1, as %
  cumulativeTwr: number;  // cumulative TWR since inception %
}

export interface RoiResult {
  aggregate: SubRoi;
  perSubAccount: Record<number, SubRoi>;
}

type RoiCallback = (data: RoiResult) => void;

export class RoiTracker {
  private readonly authority: PublicKey;
  private readonly subAccountIds: number[];
  private readonly accountIds: Map<number, string>; // subId → base58 account pubkey
  private readonly subToStrategy: Record<number, string>;
  private callback: RoiCallback | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    authority: PublicKey,
    subAccountIds: number[],
    subToStrategy: Record<number, string>,
  ) {
    this.authority = authority;
    this.subAccountIds = subAccountIds;
    this.subToStrategy = subToStrategy;

    // Derive Drift account pubkeys for each subaccount
    this.accountIds = new Map();
    for (const subId of subAccountIds) {
      const pubkey = getUserAccountPublicKeySync(DRIFT_PROGRAM_ID, authority, subId);
      this.accountIds.set(subId, pubkey.toBase58());
    }
  }

  onUpdate(cb: RoiCallback): void {
    this.callback = cb;
  }

  start(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async refresh(): Promise<void> {
    try {
      const authorityId = this.authority.toBase58();

      // Fetch snapshots for all subaccounts in one call
      const snapshotsByAccount = await this.fetchSnapshots(authorityId);

      // Fetch deposits per subaccount in parallel
      const depositsByAccount = new Map<number, DepositRecord[]>();
      await Promise.all(
        this.subAccountIds.map(async (subId) => {
          const accountId = this.accountIds.get(subId)!;
          const deposits = await this.fetchDeposits(accountId);
          depositsByAccount.set(subId, deposits);
        }),
      );

      // Compute ROI per subaccount
      const perSubAccount: Record<number, SubRoi> = {};
      for (const subId of this.subAccountIds) {
        const snapshots = snapshotsByAccount.get(subId) ?? [];
        const deposits = depositsByAccount.get(subId) ?? [];
        perSubAccount[subId] = this.computeSubRoi(snapshots, deposits);
      }

      // Compute aggregate (value-weighted daily returns)
      const aggregate = this.computeAggregate(snapshotsByAccount, depositsByAccount);

      const result: RoiResult = { aggregate, perSubAccount };
      if (this.callback) this.callback(result);
    } catch (err) {
      console.error('[roi-tracker] Refresh failed:', err);
    }
  }

  private async fetchSnapshots(authorityId: string): Promise<Map<number, DailySnapshot[]>> {
    const url = `${DATA_API}/authority/${authorityId}/snapshots/trading?days=${SNAPSHOT_DAYS}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Snapshots API returned ${res.status}`);

    const data = await res.json();
    const result = new Map<number, DailySnapshot[]>();
    const activeSet = new Set(this.subAccountIds);

    // The authority endpoint returns { accounts: [{ accountId, snapshots, metrics }] }
    const accounts = data.accounts ?? data;
    if (!Array.isArray(accounts)) return result;

    for (const acct of accounts) {
      // Match accountId to our subaccounts
      const accountId: string = acct.accountId ?? acct.user;
      let subId: number | null = null;
      for (const [sid, aid] of this.accountIds) {
        if (aid === accountId && activeSet.has(sid)) {
          subId = sid;
          break;
        }
      }
      if (subId === null) continue;

      const snapshots: DailySnapshot[] = [];
      for (const snap of (acct.snapshots ?? [])) {
        snapshots.push({
          ts: Number(snap.ts),
          accountBalance: parseFloat(snap.accountBalance ?? '0'),
          unrealizedPnl: parseFloat(snap.unrealizedPnl ?? '0'),
        });
      }
      snapshots.sort((a, b) => a.ts - b.ts);
      result.set(subId, snapshots);
    }

    return result;
  }

  private async fetchDeposits(accountId: string): Promise<DepositRecord[]> {
    const records: DepositRecord[] = [];
    let url: string | null = `${DATA_API}/user/${accountId}/deposits`;

    while (url) {
      const res: Response = await fetch(url);
      if (!res.ok) break;

      const data: any = await res.json();
      const items = data.records ?? data.data ?? data;
      if (!Array.isArray(items)) break;

      for (const item of items) {
        // Skip inter-subaccount transfers
        if (item.explanation === 'transfer') continue;

        records.push({
          ts: Number(item.ts),
          amount: parseFloat(item.amount ?? '0') / 1e6, // QUOTE_PRECISION
          direction: item.direction,
        });
      }

      // Pagination
      url = data.meta?.nextPage ? `${DATA_API}/user/${accountId}/deposits?page=${data.meta.nextPage}` : null;
    }

    return records;
  }

  private computeSubRoi(snapshots: DailySnapshot[], deposits: DepositRecord[]): SubRoi {
    const zero: SubRoi = { dailyRoi: 0, avgDailyRoi: 0, annualizedRoi: 0, cumulativeTwr: 0 };
    if (snapshots.length < 2) return zero;

    const dailyReturns: number[] = [];

    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1];
      const curr = snapshots[i];

      const startValue = prev.accountBalance + prev.unrealizedPnl;
      const endValue = curr.accountBalance + curr.unrealizedPnl;

      if (startValue <= 0) continue;

      // Sum deposits/withdrawals that happened between prev and curr snapshots
      let netDeposits = 0;
      for (const d of deposits) {
        if (d.ts > prev.ts && d.ts <= curr.ts) {
          netDeposits += d.direction === 'deposit' ? d.amount : -d.amount;
        }
      }

      const dailyReturn = (endValue - startValue - netDeposits) / startValue;
      dailyReturns.push(dailyReturn);
    }

    if (dailyReturns.length === 0) return zero;

    // Cumulative TWR = product of (1 + r_i) - 1
    let product = 1;
    for (const r of dailyReturns) {
      product *= Math.max(0, 1 + r); // clamp to prevent NaN
    }
    const cumulativeTwr = (product - 1) * 100;

    // Geometric mean daily return
    const avgDaily = Math.pow(product, 1 / dailyReturns.length) - 1;
    const annualized = (Math.pow(1 + avgDaily, 365) - 1) * 100;

    // Today's ROI = last daily return
    const todayRoi = dailyReturns[dailyReturns.length - 1] * 100;

    return {
      dailyRoi: todayRoi,
      avgDailyRoi: avgDaily * 100,
      annualizedRoi: annualized,
      cumulativeTwr,
    };
  }

  private computeAggregate(
    snapshotsByAccount: Map<number, DailySnapshot[]>,
    depositsByAccount: Map<number, DepositRecord[]>,
  ): SubRoi {
    // Collect all unique timestamps across all subaccounts
    const allTimestamps = new Set<number>();
    for (const [, snaps] of snapshotsByAccount) {
      for (const s of snaps) allTimestamps.add(s.ts);
    }
    const sortedTs = [...allTimestamps].sort((a, b) => a - b);

    if (sortedTs.length < 2) {
      return { dailyRoi: 0, avgDailyRoi: 0, annualizedRoi: 0, cumulativeTwr: 0 };
    }

    // Build lookup: ts → snapshot per sub
    const snapLookup = new Map<number, Map<number, DailySnapshot>>();
    for (const [subId, snaps] of snapshotsByAccount) {
      for (const s of snaps) {
        if (!snapLookup.has(s.ts)) snapLookup.set(s.ts, new Map());
        snapLookup.get(s.ts)!.set(subId, s);
      }
    }

    const dailyReturns: number[] = [];

    for (let i = 1; i < sortedTs.length; i++) {
      const prevTs = sortedTs[i - 1];
      const currTs = sortedTs[i];
      const prevSnaps = snapLookup.get(prevTs);
      const currSnaps = snapLookup.get(currTs);
      if (!prevSnaps || !currSnaps) continue;

      let totalStartValue = 0;
      let totalEndValue = 0;
      let totalNetDeposits = 0;

      for (const subId of this.subAccountIds) {
        const prev = prevSnaps.get(subId);
        const curr = currSnaps.get(subId);
        if (!prev || !curr) continue;

        totalStartValue += prev.accountBalance + prev.unrealizedPnl;
        totalEndValue += curr.accountBalance + curr.unrealizedPnl;

        const deposits = depositsByAccount.get(subId) ?? [];
        for (const d of deposits) {
          if (d.ts > prevTs && d.ts <= currTs) {
            totalNetDeposits += d.direction === 'deposit' ? d.amount : -d.amount;
          }
        }
      }

      if (totalStartValue <= 0) continue;

      const dailyReturn = (totalEndValue - totalStartValue - totalNetDeposits) / totalStartValue;
      dailyReturns.push(dailyReturn);
    }

    if (dailyReturns.length === 0) {
      return { dailyRoi: 0, avgDailyRoi: 0, annualizedRoi: 0, cumulativeTwr: 0 };
    }

    let product = 1;
    for (const r of dailyReturns) {
      product *= Math.max(0, 1 + r);
    }

    const cumulativeTwr = (product - 1) * 100;
    const avgDaily = Math.pow(product, 1 / dailyReturns.length) - 1;
    const annualized = (Math.pow(1 + avgDaily, 365) - 1) * 100;
    const todayRoi = dailyReturns[dailyReturns.length - 1] * 100;

    return {
      dailyRoi: todayRoi,
      avgDailyRoi: avgDaily * 100,
      annualizedRoi: annualized,
      cumulativeTwr,
    };
  }
}
