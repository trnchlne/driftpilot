/**
 * Download HYPE/USD historical 1-minute candles from Pyth Benchmarks API.
 * Downloads in chunks (Pyth limits response size) and writes to JSONL.
 */

import { writeFileSync, appendFileSync, existsSync } from 'node:fs';

const SYMBOL = 'Crypto.HYPE/USD';
const FEED_ID = '4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b';
const OUTPUT = new URL('../data/hype-history.jsonl', import.meta.url).pathname;

// HYPE launched ~Dec 5, 2024
const START_TS = 1733374800; // 2024-12-05
const END_TS = Math.floor(Date.now() / 1000);

// Pyth seems to limit to ~1 day per request for 1-min resolution
const CHUNK_SECONDS = 86400; // 1 day

async function fetchChunk(from: number, to: number): Promise<{ t: number[]; c: number[] } | null> {
  const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=${SYMBOL}&resolution=1&from=${from}&to=${to}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`  HTTP ${resp.status} for ${new Date(from * 1000).toISOString().slice(0, 10)}`);
    return null;
  }
  const data = await resp.json() as { s: string; t: number[]; c: number[] };
  if (data.s !== 'ok' || !data.t || data.t.length === 0) return null;
  return { t: data.t, c: data.c };
}

async function main() {
  console.log(`Downloading HYPE/USD 1-min candles`);
  console.log(`From: ${new Date(START_TS * 1000).toISOString().slice(0, 10)}`);
  console.log(`To:   ${new Date(END_TS * 1000).toISOString().slice(0, 10)}`);
  console.log(`Output: ${OUTPUT}\n`);

  // Clear output
  writeFileSync(OUTPUT, '');

  let totalCandles = 0;
  let from = START_TS;
  let lastPrice = 0;

  while (from < END_TS) {
    const to = Math.min(from + CHUNK_SECONDS, END_TS);
    const dateLabel = new Date(from * 1000).toISOString().slice(0, 10);

    const chunk = await fetchChunk(from, to);
    if (chunk && chunk.t.length > 0) {
      let lines = '';
      for (let i = 0; i < chunk.t.length; i++) {
        lines += JSON.stringify({ feedId: FEED_ID, price: chunk.c[i], publishTime: chunk.t[i] }) + '\n';
        lastPrice = chunk.c[i];
      }
      appendFileSync(OUTPUT, lines);
      totalCandles += chunk.t.length;
      process.stdout.write(`  ${dateLabel}: ${chunk.t.length} candles ($${chunk.c[chunk.c.length - 1].toFixed(2)}) | total: ${totalCandles}\r`);
    } else {
      process.stdout.write(`  ${dateLabel}: no data\r`);
    }

    from = to;

    // Rate limit — be nice to Pyth
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n\nDone! ${totalCandles} candles saved to ${OUTPUT}`);
  console.log(`Last price: $${lastPrice.toFixed(2)}`);
  console.log(`Days: ${((END_TS - START_TS) / 86400).toFixed(0)}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
