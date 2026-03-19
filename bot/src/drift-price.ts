import WebSocket from 'ws';

export interface DriftPrice {
  market: string;       // "SOL-PERP"
  markPrice: number;
  oraclePrice: number;
  timestamp: number;
}

export type DriftPriceCallback = (price: DriftPrice) => void;

const DLOB_WS_URL = 'wss://dlob.drift.trade/ws';
const RECONNECT_DELAY_MS = 5_000;

export class DriftPriceStream {
  private readonly markets: string[];
  private callbacks: DriftPriceCallback[] = [];
  private ws: WebSocket | null = null;
  private stopped = false;
  private _lastPrices = new Map<string, DriftPrice>();

  constructor(markets: string[]) {
    this.markets = markets;
  }

  onPrice(cb: DriftPriceCallback): void {
    this.callbacks.push(cb);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get lastPrices(): Map<string, DriftPrice> {
    return this._lastPrices;
  }

  private connect(): void {
    if (this.stopped) return;

    const ws = new WebSocket(DLOB_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[drift-price] Connected to DLOB websocket');
      for (const market of this.markets) {
        const msg = JSON.stringify({
          type: 'subscribe',
          marketType: 'perp',
          channel: 'orderbook',
          market,
        });
        ws.send(msg);
        console.log(`[drift-price] Subscribed to ${market}`);
      }
    });

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Extract market name from the channel field (e.g. "orderbook_perp_SOL-PERP")
        const channel: string | undefined = msg.channel;
        if (!channel) return;

        const match = channel.match(/^orderbook_perp_(.+)$/);
        if (!match) return;
        const market = match[1];

        const markPrice = parseFloat(msg.data?.markPrice);
        const oraclePrice = parseFloat(msg.data?.oraclePrice);
        if (isNaN(markPrice) || isNaN(oraclePrice)) return;

        const price: DriftPrice = {
          market,
          markPrice,
          oraclePrice,
          timestamp: Date.now(),
        };

        this._lastPrices.set(market, price);

        for (const cb of this.callbacks) {
          try {
            cb(price);
          } catch (err) {
            console.error('[drift-price] Callback error:', err);
          }
        }
      } catch {
        // ignore non-JSON messages (pings, etc.)
      }
    });

    ws.on('ping', () => {
      ws.pong();
    });

    ws.on('close', () => {
      if (this.stopped) return;
      console.log(`[drift-price] Disconnected — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });

    ws.on('error', (err: Error) => {
      console.error('[drift-price] WebSocket error:', err.message);
      // close handler will trigger reconnect
      ws.close();
    });
  }
}
