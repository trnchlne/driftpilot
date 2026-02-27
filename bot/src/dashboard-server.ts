import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DASHBOARD_HTML } from './dashboard-html.js';
import { dashboardBus } from './dashboard-bus.js';
import type { PriceEvent, EntryEvent, TradeEvent, LeaderboardEvent, AccountEvent } from './dashboard-bus.js';

const PORT = 3000;
const MAX_RECENT_TRADES = 50;

export class DashboardServer {
  private server: ReturnType<typeof createServer> | null = null;
  private clients: Set<ServerResponse> = new Set();
  private lastPrice: PriceEvent | null = null;
  private lastLeaderboard: LeaderboardEvent | null = null;
  private lastAccount: AccountEvent | null = null;
  private recentTrades: TradeEvent[] = [];
  private startTime = Date.now();

  start(): void {
    this.server = createServer((req, res) => this.handleRequest(req, res));

    // Listen to bus events and broadcast to all SSE clients
    dashboardBus.on('price', (event: PriceEvent) => {
      this.lastPrice = event;
      this.broadcast('price', event);
    });
    dashboardBus.on('entry', (event: EntryEvent) => {
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
      metrics: e.metrics,
      state: e.thinking,
    }));

    const account = this.lastAccount ? {
      balanceUsdc: this.lastAccount.balanceUsdc,
      unrealizedPnl: this.lastAccount.unrealizedPnl,
      realizedPnl: this.lastAccount.realizedPnl,
      totalPnl: this.lastAccount.totalPnl,
      depositUsdc: this.lastAccount.startBalanceUsdc,
      roi: this.lastAccount.startBalanceUsdc > 0
        ? ((this.lastAccount.totalPnl / this.lastAccount.startBalanceUsdc) * 100)
        : 0,
      lastUpdate: new Date(this.lastAccount.timestamp * 1000).toISOString(),
    } : null;

    const trades = this.recentTrades.map(t => ({
      strategy: t.strategyName,
      direction: t.direction,
      entry: t.entry,
      exit: t.exit,
      pnl: t.pnl,
      reason: t.reason,
      time: new Date(t.timestamp * 1000).toISOString(),
    }));

    const status = {
      botVersion: 'driftpilot',
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

  private handleHealth(res: ServerResponse): void {
    const health = {
      status: 'ok',
      price: this.lastPrice,
      leaderboard: this.lastLeaderboard,
    };
    res.writeHead(200, {
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
    });

    // Send initial comment to establish connection
    res.write(':ok\n\n');

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
