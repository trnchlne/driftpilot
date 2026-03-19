/**
 * ROI Tracker — computes time-weighted daily returns from Drift data API.
 *
 * Uses daily account snapshots (balance + cumulative PnL) to derive
 * net deposits per day: deposits = balanceChange - tradingPnlChange.
 * Then computes deposit-adjusted daily returns, TWR, and annualized ROI.
 *
 * No local state — everything is recomputed from API data on each refresh.
 * Single API call per refresh via the authority snapshots endpoint.
 */

import { getUserAccountPublicKeySync } from '@drift-labs/sdk';
import { PublicKey } from '@solana/web3.js';

const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const DATA_API = 'https://data.api.drift.trade';
const REFRESH_INTERVAL_MS = 5 * 60_000; // 5 minutes
const SNAPSHOT_DAYS = 100;

interface DailySnapshot {
  ts: number;
  accountBalance: number;   // USD total value
  unrealizedPnl: number;
  cumulativeSettledPnl: number;  // settled perp PnL only (not spot/SOL appreciation)
}

export interface SubRoi {
  dailyRoi: number;      // today's return % (live, since last UTC midnight snapshot)
  avgDailyRoi: number;   // geometric mean of daily returns %
  annualizedRoi: number;  // (1 + avgDaily)^365 - 1, as %
  cumulativeTwr: number;  // cumulative TWR since inception %
}

export interface RoiResult {
  aggregate: SubRoi;
  perSubAccount: Record<number, SubRoi>;
}

/** Live account value for computing today's real-time return */
export interface LiveValue {
  subAccountId: number;
  totalCollateral: number;  // USD
  unrealizedPnl: number;   // USD
  settledPerpPnl: number;  // USD cumulative
}

type RoiCallback = (data: RoiResult) => void;

export class RoiTracker {
  private readonly authority: PublicKey;
  private readonly subAccountIds: number[];
  private readonly accountIds: Map<number, string>; // subId → base58 account pubkey
  private callback: RoiCallback | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private liveValues: Map<number, LiveValue> = new Map();

  constructor(
    authority: PublicKey,
    subAccountIds: number[],
    _subToStrategy: Record<number, string>,
  ) {
    this.authority = authority;
    this.subAccountIds = subAccountIds;

    // Derive Drift account pubkeys for each subaccount
    this.accountIds = new Map();
    for (const subId of subAccountIds) {
      const pubkey = getUserAccountPublicKeySync(DRIFT_PROGRAM_ID, authority, subId);
      this.accountIds.set(subId, pubkey.toBase58());
    }
  }

  /** Feed live account values from the SDK (called from live.ts on each account emit) */
  updateLiveValue(lv: LiveValue): void {
    this.liveValues.set(lv.subAccountId, lv);
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
      const snapshotsByAccount = await this.fetchSnapshots(authorityId);

      // Compute ROI per subaccount
      const perSubAccount: Record<number, SubRoi> = {};
      for (const subId of this.subAccountIds) {
        const snapshots = snapshotsByAccount.get(subId) ?? [];
        perSubAccount[subId] = this.computeSubRoi(snapshots, subId);
      }

      // Compute aggregate
      const aggregate = this.computeAggregate(snapshotsByAccount);

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

    const data: any = await res.json();
    const result = new Map<number, DailySnapshot[]>();
    const activeSet = new Set(this.subAccountIds);

    // The authority endpoint returns { accounts: [{ accountId, snapshots, metrics }] }
    const accounts = data.accounts ?? data;
    if (!Array.isArray(accounts)) return result;

    for (const acct of accounts) {
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
          cumulativeSettledPnl: parseFloat(snap.cumulativeSettledPnl ?? '0'),
        });
      }
      snapshots.sort((a, b) => a.ts - b.ts);
      result.set(subId, snapshots);
    }

    return result;
  }

  /**
   * Compute daily returns for a single subaccount.
   *
   * Uses settledPnl + unrealizedPnl as the trading-only metric.
   * dailyReturn = tradingPnlChange / startValue
   * This ignores deposit/withdrawal flows and SOL spot price changes.
   *
   * For "today" (since last UTC midnight snapshot), uses live SDK values
   * instead of snapshot data so the dashboard shows real-time today's return.
   */
  private computeSubRoi(snapshots: DailySnapshot[], subId: number): SubRoi {
    const zero: SubRoi = { dailyRoi: 0, avgDailyRoi: 0, annualizedRoi: 0, cumulativeTwr: 0 };
    if (snapshots.length < 1) return zero;

    const dailyReturns: number[] = [];

    // Historical daily returns (completed days)
    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1];
      const curr = snapshots[i];

      const startValue = prev.accountBalance + prev.unrealizedPnl;
      if (startValue <= 0.01) continue;

      // Trading PnL = change in (settledPnl + unrealizedPnl)
      const tradingPnl = (curr.cumulativeSettledPnl + curr.unrealizedPnl)
                        - (prev.cumulativeSettledPnl + prev.unrealizedPnl);

      dailyReturns.push(tradingPnl / startValue);
    }

    // Today's live return (last snapshot → current SDK value)
    const lastSnap = snapshots[snapshots.length - 1];
    const live = this.liveValues.get(subId);
    let todayRoi = 0;

    if (live && lastSnap) {
      const startValue = lastSnap.accountBalance + lastSnap.unrealizedPnl;
      if (startValue > 0.01) {
        const tradingPnl = (live.settledPerpPnl + live.unrealizedPnl)
                          - (lastSnap.cumulativeSettledPnl + lastSnap.unrealizedPnl);
        todayRoi = (tradingPnl / startValue) * 100;
      }
    }

    const historical = this.chainReturns(dailyReturns);
    historical.dailyRoi = todayRoi;
    return historical;
  }

  /** Compute aggregate daily returns across all subaccounts (value-weighted). */
  private computeAggregate(snapshotsByAccount: Map<number, DailySnapshot[]>): SubRoi {
    // Collect all unique timestamps
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
      let totalPnlReturn = 0;

      for (const subId of this.subAccountIds) {
        const prev = prevSnaps.get(subId);
        const curr = currSnaps.get(subId);
        if (!prev || !curr) continue;

        const startValue = prev.accountBalance + prev.unrealizedPnl;
        if (startValue <= 0.01) continue;

        const tradingPnl = (curr.cumulativeSettledPnl + curr.unrealizedPnl)
                          - (prev.cumulativeSettledPnl + prev.unrealizedPnl);

        totalStartValue += startValue;
        totalPnlReturn += tradingPnl;
      }

      if (totalStartValue <= 0.01) continue;
      dailyReturns.push(totalPnlReturn / totalStartValue);
    }

    // Today's live return (aggregate)
    const lastTs = sortedTs[sortedTs.length - 1];
    const lastSnaps = snapLookup.get(lastTs);
    let todayStart = 0;
    let todayTradingPnl = 0;
    if (lastSnaps) {
      for (const subId of this.subAccountIds) {
        const snap = lastSnaps.get(subId);
        const live = this.liveValues.get(subId);
        if (!snap || !live) continue;
        const sv = snap.accountBalance + snap.unrealizedPnl;
        if (sv <= 0.01) continue;
        todayStart += sv;
        todayTradingPnl += (live.settledPerpPnl + live.unrealizedPnl)
                          - (snap.cumulativeSettledPnl + snap.unrealizedPnl);
      }
    }

    const historical = this.chainReturns(dailyReturns);
    historical.dailyRoi = todayStart > 0.01 ? (todayTradingPnl / todayStart) * 100 : 0;
    return historical;
  }

  /** Chain-multiply daily returns into TWR, avg daily, annualized. */
  private chainReturns(dailyReturns: number[]): SubRoi {
    const zero: SubRoi = { dailyRoi: 0, avgDailyRoi: 0, annualizedRoi: 0, cumulativeTwr: 0 };
    if (dailyReturns.length === 0) return zero;

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
