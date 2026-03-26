/**
 * Quick script: fetch daily snapshots from Drift and show per-day ROI for R-fast-SOL (sub 1).
 * Usage: npx tsx src/daily-breakdown.ts
 */

import { config } from 'dotenv';
config();

import { getUserAccountPublicKeySync } from '@drift-labs/sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const DRIFT_PROGRAM_ID = new PublicKey('dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH');
const DATA_API = 'https://data.api.drift.trade';

async function main() {
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  if (!PRIVATE_KEY) { console.error('Missing PRIVATE_KEY'); process.exit(1); }

  const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  const authority = keypair.publicKey;
  console.log(`Authority: ${authority.toBase58()}\n`);

  // Subaccount IDs: 0=R-base-SOL, 1=R-fast-SOL, 2=R-fast-HYPE
  const subs = [
    { id: 0, name: 'R-base-SOL' },
    { id: 1, name: 'R-fast-SOL' },
    { id: 2, name: 'R-fast-HYPE' },
  ];

  const accountMap = new Map<string, { id: number; name: string }>();
  for (const sub of subs) {
    const pubkey = getUserAccountPublicKeySync(DRIFT_PROGRAM_ID, authority, sub.id);
    accountMap.set(pubkey.toBase58(), sub);
  }

  const url = `${DATA_API}/authority/${authority.toBase58()}/snapshots/trading?days=100`;
  console.log(`Fetching: ${url}\n`);

  const res = await fetch(url);
  if (!res.ok) { console.error(`API error: ${res.status}`); process.exit(1); }

  const data: any = await res.json();
  const accounts = data.accounts ?? data;
  if (!Array.isArray(accounts)) { console.error('Unexpected response format'); process.exit(1); }

  for (const acct of accounts) {
    const accountId = acct.accountId ?? acct.user;
    const sub = accountMap.get(accountId);
    const label = sub ? `${sub.name} (sub ${sub.id})` : accountId;

    const snapshots = (acct.snapshots ?? []).sort((a: any, b: any) => Number(a.ts) - Number(b.ts));
    if (snapshots.length < 2) {
      console.log(`${label}: not enough snapshots (${snapshots.length})\n`);
      continue;
    }

    console.log(`══════════════════════════════════════════════════`);
    console.log(`  ${label}`);
    console.log(`══════════════════════════════════════════════════`);
    console.log(`  Date         Balance     SettledPnL   DayPnL    DayROI%   CumROI%`);
    console.log(`  ──────────   ─────────   ──────────   ───────   ───────   ───────`);

    let cumProduct = 1;

    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i];
      const ts = Number(snap.ts);
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      const balance = parseFloat(snap.accountBalance ?? '0');
      const unrealized = parseFloat(snap.unrealizedPnl ?? '0');
      const settled = parseFloat(snap.cumulativeSettledPnl ?? '0');

      if (i === 0) {
        console.log(`  ${date}   $${balance.toFixed(2).padStart(8)}   $${settled.toFixed(2).padStart(9)}       —         —         —`);
        continue;
      }

      const prev = snapshots[i - 1];
      const prevBalance = parseFloat(prev.accountBalance ?? '0');
      const prevUnrealized = parseFloat(prev.unrealizedPnl ?? '0');
      const prevSettled = parseFloat(prev.cumulativeSettledPnl ?? '0');

      const startValue = prevBalance + prevUnrealized;
      const tradingPnl = (settled + unrealized) - (prevSettled + prevUnrealized);

      const dayRoi = startValue > 0.01 ? (tradingPnl / startValue) * 100 : 0;
      cumProduct *= Math.max(0, 1 + dayRoi / 100);
      const cumRoi = (cumProduct - 1) * 100;

      const pnlStr = tradingPnl >= 0 ? `+$${tradingPnl.toFixed(2)}` : `-$${Math.abs(tradingPnl).toFixed(2)}`;
      const roiStr = dayRoi >= 0 ? `+${dayRoi.toFixed(2)}%` : `${dayRoi.toFixed(2)}%`;
      const cumStr = cumRoi >= 0 ? `+${cumRoi.toFixed(2)}%` : `${cumRoi.toFixed(2)}%`;

      console.log(`  ${date}   $${balance.toFixed(2).padStart(8)}   $${settled.toFixed(2).padStart(9)}   ${pnlStr.padStart(7)}   ${roiStr.padStart(7)}   ${cumStr.padStart(7)}`);
    }

    console.log('');
  }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
