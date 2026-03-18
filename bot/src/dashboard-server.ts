import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DASHBOARD_HTML } from './dashboard-html.js';
import { dashboardBus } from './dashboard-bus.js';
import type { PriceEvent, EntryEvent, TradeEvent, LeaderboardEvent, AccountEvent, MarketEvent } from './dashboard-bus.js';
import type { PriceFeed } from './feed.js';
import { decisionLog } from './decision-log.js';
import type { DecisionType } from './decision-log.js';
import { BOT_VERSION } from './version.js';

const PORT = 3000;
const MAX_RECENT_TRADES = 50;
const FEED_STALE_MS = 60_000; // feed considered stale after 60s without a tick

export class DashboardServer {
  private server: ReturnType<typeof createServer> | null = null;
  private clients: Set<ServerResponse> = new Set();
  private lastPrice: PriceEvent | null = null;
  private lastLeaderboard: LeaderboardEvent | null = null;
  private lastAccount: AccountEvent | null = null;
  private recentTrades: TradeEvent[] = [];
  private recentEntries: EntryEvent[] = [];
  private startTime = Date.now();
  private priceFeed: PriceFeed | null = null;

  /** Attach the price feed so health endpoint can report feed status */
  setFeed(feed: PriceFeed): void {
    this.priceFeed = feed;
  }

  start(): void {
    this.server = createServer((req, res) => this.handleRequest(req, res));

    // Listen to bus events and broadcast to all SSE clients
    dashboardBus.on('price', (event: PriceEvent) => {
      this.lastPrice = event;
      this.broadcast('price', event);
    });
    dashboardBus.on('entry', (event: EntryEvent) => {
      this.recentEntries.push(event);
      if (this.recentEntries.length > MAX_RECENT_TRADES) this.recentEntries.shift();
      this.broadcast('entry', event);
    });
    dashboardBus.on('trade', (event: TradeEvent) => {
      this.recentTrades.push(event);
      if (this.recentTrades.length > MAX_RECENT_TRADES) this.recentTrades.shift();
      this.broadcast('trade', event);
    });
    dashboardBus.on('leaderboard', (event: LeaderboardEvent) => {
      this.lastLeaderboard = event;
      this.broadcast('leaderboard', event);
    });
    dashboardBus.on('account', (event: AccountEvent) => {
      this.lastAccount = event;
      this.broadcast('account', event);
    });
    dashboardBus.on('market', (event: MarketEvent) => {
      this.broadcast('market', event);
    });

    this.server.listen(PORT, () => {
      console.log(`[dashboard] http://localhost:${PORT}`);
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';

    if (url === '/events') {
      this.handleSSE(res);
      return;
    }

    if (url === '/health') {
      this.handleHealth(res);
      return;
    }

    if (url === '/api/status') {
      this.handleApiStatus(res);
      return;
    }

    if (url.startsWith('/api/decisions')) {
      this.handleApiDecisions(req, res);
      return;
    }

    // Serve the HTML page for everything else
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(DASHBOARD_HTML);
  }

  private handleApiStatus(res: ServerResponse): void {
    const uptimeMs = Date.now() - this.startTime;
    const uptimeH = (uptimeMs / 3_600_000).toFixed(1);

    const strategies = (this.lastLeaderboard?.entries ?? []).map(e => ({
      name: e.name,
      type: e.type,
      market: e.market ?? 'SOL',
      subAccountId: e.subAccountId ?? null,
      metrics: e.metrics,
      state: e.thinking,
    }));

    const account = this.lastAccount ? {
      balanceUsdc: this.lastAccount.balanceUsdc,
      unrealizedPnl: this.lastAccount.unrealizedPnl,
      realizedPnl: this.lastAccount.realizedPnl,
      totalPnl: this.lastAccount.totalPnl,
      tradingPnl: this.lastAccount.tradingPnl ?? 0,
      depositUsdc: this.lastAccount.startBalanceUsdc,
      roi: this.lastAccount.startBalanceUsdc > 0
        ? ((this.lastAccount.totalPnl / this.lastAccount.startBalanceUsdc) * 100)
        : 0,
      tradingRoi: this.lastAccount.startBalanceUsdc > 0
        ? (((this.lastAccount.tradingPnl ?? 0) / this.lastAccount.startBalanceUsdc) * 100)
        : 0,
      perStrategy: this.lastAccount.perStrategy ?? null,
      lastUpdate: new Date(this.lastAccount.timestamp * 1000).toISOString(),
    } : null;

    const trades = this.recentTrades.map(t => ({
      tradeId: t.tradeId,
      strategy: t.strategyName,
      direction: t.direction,
      entry: t.entry,
      exit: t.exit,
      pnl: t.pnl,
      reason: t.reason,
      bestPrice: t.bestPrice,
      time: new Date(t.timestamp * 1000).toISOString(),
    }));

    const status = {
      botVersion: BOT_VERSION,
      uptime: `${uptimeH}h`,
      uptimeMs,
      timestamp: new Date().toISOString(),
      price: this.lastPrice ? {
        sol: this.lastPrice.sol,
        time: new Date(this.lastPrice.timestamp * 1000).toISOString(),
      } : null,
      account,
      strategies,
      recentTrades: trades,
      tradeCount: this.lastLeaderboard?.totalTrades ?? 0,
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(status, null, 2));
  }

  private handleApiDecisions(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const params = url.searchParams;

    const opts: {
      limit?: number;
      since?: number;
      strategy?: string;
      type?: DecisionType;
    } = {};

    if (params.has('limit')) opts.limit = parseInt(params.get('limit')!, 10);
    if (params.has('since')) opts.since = parseInt(params.get('since')!, 10);
    if (params.has('strategy')) opts.strategy = params.get('strategy')!;
    if (params.has('type')) opts.type = params.get('type') as DecisionType;

    // Default: last 200 entries
    if (!opts.limit && !opts.since) opts.limit = 200;

    const entries = decisionLog.query(opts);

    const result = {
      totalInLog: decisionLog.size,
      returned: entries.length,
      filters: { limit: opts.limit, since: opts.since, strategy: opts.strategy, type: opts.type },
      decisions: entries,
    };

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(result, null, 2));
  }

  private handleHealth(res: ServerResponse): void {
    const lastTickMs = this.priceFeed?.lastTickMs ?? 0;
    const silentMs = lastTickMs > 0 ? Date.now() - lastTickMs : -1;
    const feedAlive = silentMs >= 0 && silentMs < FEED_STALE_MS;
    const status = lastTickMs === 0 ? 'starting' : feedAlive ? 'ok' : 'stale';

    const health = {
      version: BOT_VERSION,
      status,
      feedSilentSeconds: silentMs >= 0 ? Math.round(silentMs / 1000) : null,
      lastTickTime: lastTickMs > 0 ? new Date(lastTickMs).toISOString() : null,
      uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
      price: this.lastPrice,
      leaderboard: this.lastLeaderboard,
    };

    const httpStatus = status === 'ok' || status === 'starting' ? 200 : 503;
    res.writeHead(httpStatus, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(health, null, 2));
  }

  private handleSSE(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });

    // Send initial comment to establish connection
    res.write(':ok\n\n');

    // Send current state immediately so dashboard doesn't show "--" until next event
    if (this.lastPrice) {
      res.write(`event: price\ndata: ${JSON.stringify(this.lastPrice)}\n\n`);
    }
    if (this.lastLeaderboard) {
      res.write(`event: leaderboard\ndata: ${JSON.stringify(this.lastLeaderboard)}\n\n`);
    }
    if (this.lastAccount) {
      res.write(`event: account\ndata: ${JSON.stringify(this.lastAccount)}\n\n`);
    }
    for (const entry of this.recentEntries) {
      res.write(`event: entry\ndata: ${JSON.stringify(entry)}\n\n`);
    }
    for (const trade of this.recentTrades) {
      res.write(`event: trade\ndata: ${JSON.stringify(trade)}\n\n`);
    }

    this.clients.add(res);

    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  private broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }

  stop(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
