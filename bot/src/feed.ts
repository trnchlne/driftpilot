import { EventSource } from 'eventsource';

const SOL_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export interface Tick {
  feedId: string;
  price: number;
  publishTime: number;
}

export type TickCallback = (tick: Tick) => void;

export class PriceFeed {
  private readonly feedIds: string[];
  private readonly hermesUrl: string;
  private callbacks: TickCallback[] = [];
  private es: EventSource | null = null;
  private consecutiveFailures = 0;
  private stopped = false;
  private lastTickTime = 0;       // wall-clock ms of last received tick
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(feedIds?: string[]) {
    this.feedIds = feedIds ?? [SOL_FEED_ID];
    const idParams = this.feedIds.map(id => `ids[]=${id}`).join('&');
    this.hermesUrl = `https://hermes.pyth.network/v2/updates/price/stream?${idParams}&parsed=true`;
  }

  /** Wall-clock ms when the last tick was received (0 = never) */
  get lastTickMs(): number {
    return this.lastTickTime;
  }

  onTick(cb: TickCallback): void {
    this.callbacks.push(cb);
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.startWatchdog();
  }

  stop(): void {
    this.stopped = true;
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * Watchdog: if no tick arrives for STALE_THRESHOLD_MS, the SSE stream
   * has silently died (server stopped sending without closing). Force
   * reconnect so the bot doesn't sit idle for hours/days.
   */
  private startWatchdog(): void {
    const STALE_THRESHOLD_MS = 60_000; // 60 seconds without a tick → stale
    const CHECK_INTERVAL_MS = 15_000;  // check every 15 seconds

    this.watchdogTimer = setInterval(() => {
      if (this.stopped) return;
      if (this.lastTickTime === 0) return; // haven't received first tick yet

      const silentMs = Date.now() - this.lastTickTime;
      if (silentMs > STALE_THRESHOLD_MS) {
        console.warn(`[feed] Watchdog: no tick for ${Math.round(silentMs / 1000)}s — force reconnecting`);
        if (this.es) {
          this.es.close();
          this.es = null;
        }
        this.consecutiveFailures++;
        this.connect();
      }
    }, CHECK_INTERVAL_MS);
  }

  private connect(): void {
    if (this.stopped) return;

    this.es = new EventSource(this.hermesUrl);

    this.es.onopen = () => {
      this.consecutiveFailures = 0;
      console.log('[feed] Pyth SSE connected');
    };

    this.es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (!data.parsed || !Array.isArray(data.parsed)) return;

        for (const item of data.parsed) {
          const feedId: string = item.id;
          const priceData = item.price;
          if (!priceData) continue;

          const price = parseInt(priceData.price) * 10 ** parseInt(priceData.expo);
          const publishTime = parseInt(priceData.publish_time);

          this.lastTickTime = Date.now();

          const tick: Tick = { feedId, price, publishTime };
          for (const cb of this.callbacks) {
            try {
              cb(tick);
            } catch (err) {
              console.error('[feed] Callback error:', err);
            }
          }
        }
      } catch (err) {
        console.error('[feed] Parse error:', err);
      }
    };

    this.es.onerror = () => {
      if (this.stopped) return;

      this.consecutiveFailures++;
      if (this.es) {
        this.es.close();
        this.es = null;
      }

      const backoff = Math.min(INITIAL_BACKOFF_MS * 2 ** (this.consecutiveFailures - 1), MAX_BACKOFF_MS);
      console.log(`[feed] Reconnecting in ${backoff}ms (attempt ${this.consecutiveFailures})`);
      setTimeout(() => this.connect(), backoff);
    };
  }
}

/**
 * Fetch historical 1-minute candles from Pyth Benchmarks API.
 * Used for instant warmup on restart — no need to wait hours for buffers to fill.
 * Returns Tick[] sorted by time, one per minute.
 * Supports multiple markets — fetches each in parallel and merges by time.
 */
export async function fetchWarmupTicks(
  hours: number = 5,
  markets?: { feedId: string; pythSymbol: string }[],
): Promise<Tick[]> {
  const targets = markets ?? [{ feedId: SOL_FEED_ID, pythSymbol: 'Crypto.SOL/USD' }];

  const now = Math.floor(Date.now() / 1000);
  const from = now - hours * 3600;

  console.log(`[warmup] Fetching ${hours}h of historical data for ${targets.length} market(s)...`);

  const allTicks: Tick[] = [];

  await Promise.all(targets.map(async ({ feedId, pythSymbol }) => {
    const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=${pythSymbol}&resolution=1&from=${from}&to=${now}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(`[warmup] ${pythSymbol}: HTTP ${resp.status} — skipping`);
      return;
    }

    const data = await resp.json() as { s: string; t: number[]; c: number[] };
    if (data.s !== 'ok' || !data.t || !data.c) {
      console.warn(`[warmup] ${pythSymbol}: API returned ${data.s} — skipping`);
      return;
    }

    for (let i = 0; i < data.t.length; i++) {
      allTicks.push({ feedId, price: data.c[i], publishTime: data.t[i] });
    }
    console.log(`[warmup] ${pythSymbol}: ${data.t.length} candles | $${data.c[0]?.toFixed(2)} → $${data.c[data.c.length - 1]?.toFixed(2)}`);
  }));

  // Sort all ticks by time so strategies warm up chronologically
  allTicks.sort((a, b) => a.publishTime - b.publishTime);
  console.log(`[warmup] Total: ${allTicks.length} candles across ${targets.length} market(s)`);
  return allTicks;
}

export { SOL_FEED_ID };
