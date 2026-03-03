import { EventSource } from 'eventsource';

const SOL_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

const HERMES_URL = `https://hermes.pyth.network/v2/updates/price/stream?ids[]=${SOL_FEED_ID}&parsed=true`;

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export interface Tick {
  feedId: string;
  price: number;
  publishTime: number;
}

export type TickCallback = (tick: Tick) => void;

export class PriceFeed {
  private callbacks: TickCallback[] = [];
  private es: EventSource | null = null;
  private consecutiveFailures = 0;
  private stopped = false;
  private lastTickTime = 0;       // wall-clock ms of last received tick
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

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

    this.es = new EventSource(HERMES_URL);

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
 */
export async function fetchWarmupTicks(hours: number = 5): Promise<Tick[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - hours * 3600;

  const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=Crypto.SOL/USD&resolution=1&from=${from}&to=${now}`;

  console.log(`[warmup] Fetching ${hours}h of historical data from Pyth Benchmarks...`);

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`[warmup] Benchmarks API error: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as {
    s: string;
    t: number[];
    c: number[];
  };

  if (data.s !== 'ok' || !data.t || !data.c) {
    throw new Error(`[warmup] Benchmarks API returned: ${data.s}`);
  }

  const ticks: Tick[] = [];
  for (let i = 0; i < data.t.length; i++) {
    ticks.push({
      feedId: SOL_FEED_ID,
      price: data.c[i],
      publishTime: data.t[i],
    });
  }

  console.log(`[warmup] Got ${ticks.length} candles (${(ticks.length / 60).toFixed(1)}h) | $${ticks[0]?.price.toFixed(2)} → $${ticks[ticks.length - 1]?.price.toFixed(2)}`);
  return ticks;
}

export { SOL_FEED_ID };
