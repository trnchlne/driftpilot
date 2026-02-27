import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DASHBOARD_HTML } from './dashboard-html.js';
import { dashboardBus } from './dashboard-bus.js';
import type { PriceEvent, EntryEvent, TradeEvent, LeaderboardEvent, AccountEvent } from './dashboard-bus.js';

const PORT = 3000;

export class DashboardServer {
  private server: ReturnType<typeof createServer> | null = null;
  private clients: Set<ServerResponse> = new Set();
  private lastPrice: PriceEvent | null = null;
  private lastLeaderboard: LeaderboardEvent | null = null;

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
      this.broadcast('trade', event);
    });
    dashboardBus.on('leaderboard', (event: LeaderboardEvent) => {
      this.lastLeaderboard = event;
      this.broadcast('leaderboard', event);
    });
    dashboardBus.on('account', (event: AccountEvent) => {
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

    // Serve the HTML page for everything else
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(DASHBOARD_HTML);
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
