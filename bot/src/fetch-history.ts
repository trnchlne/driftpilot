import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

const SOL_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

interface CandleResponse {
  s: string;
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

const CHUNK_HOURS = 48; // fetch in 48h chunks (API limit ~5000 1-min candles)

async function fetchCandles(symbol: string, from: number, to: number): Promise<CandleResponse> {
  const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=${encodeURIComponent(symbol)}&resolution=1&from=${from}&to=${to}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
  return res.json() as Promise<CandleResponse>;
}

async function fetchChunked(symbol: string, from: number, to: number): Promise<{ times: number[]; closes: number[] }> {
  const times: number[] = [];
  const closes: number[] = [];
  let cursor = from;

  while (cursor < to) {
    const chunkEnd = Math.min(cursor + CHUNK_HOURS * 3600, to);
    const data = await fetchCandles(symbol, cursor, chunkEnd);
    if (data.s !== 'ok') throw new Error(`${symbol} API error: ${data.s} (range ${cursor}-${chunkEnd})`);
    for (let i = 0; i < data.t.length; i++) {
      times.push(data.t[i]);
      closes.push(data.c[i]);
    }
    const pct = (((chunkEnd - from) / (to - from)) * 100).toFixed(0);
    process.stdout.write(`\r[fetch] ${symbol}: ${times.length} candles (${pct}%)`);
    cursor = chunkEnd;
  }
  console.log('');
  return { times, closes };
}

async function main() {
  const hours = parseInt(process.argv[2] || '48');
  const now = Math.floor(Date.now() / 1000);
  const from = now - hours * 3600;
  const output = process.argv[3] || `data/history-${hours}h.jsonl`;
  const outPath = resolve(output);

  console.log(`[fetch] Fetching ${hours}h of history (${new Date(from * 1000).toISOString()} → ${new Date(now * 1000).toISOString()})`);

  const solData = await fetchChunked('Crypto.SOL/USD', from, now);

  console.log(`[fetch] SOL: ${solData.times.length} candles`);

  // Convert to ticks
  interface Tick { feedId: string; price: number; publishTime: number }
  const ticks: Tick[] = [];

  for (let i = 0; i < solData.times.length; i++) {
    ticks.push({ feedId: SOL_FEED_ID, price: solData.closes[i], publishTime: solData.times[i] });
  }

  // Deduplicate by feedId+publishTime (chunk boundaries may overlap)
  const seen = new Set<string>();
  const deduped = ticks.filter(t => {
    const key = `${t.feedId}:${t.publishTime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort chronologically
  deduped.sort((a, b) => a.publishTime - b.publishTime);

  // Write JSON-lines
  mkdirSync(dirname(outPath), { recursive: true });
  const lines = deduped.map(t => JSON.stringify(t)).join('\n') + '\n';
  writeFileSync(outPath, lines);

  const spanHours = deduped.length > 0
    ? ((deduped[deduped.length - 1].publishTime - deduped[0].publishTime) / 3600).toFixed(1)
    : '0';

  console.log(`[fetch] ${deduped.length} ticks written to ${outPath} (${spanHours}h span)`);
}

main().catch(err => { console.error(err); process.exit(1); });
