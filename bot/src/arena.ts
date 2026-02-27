import type { Tick } from './feed.js';
import type { BaseStrategy, PerformanceMetrics } from './base-strategy.js';
import { dashboardBus } from './dashboard-bus.js';

const EVAL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DASH_INTERVAL_MS = 10 * 1000; // 10 seconds
const MIN_TRADES_FOR_RANKING = 5;

export class Arena {
  private readonly strategies: BaseStrategy[];
  private readonly startTime: number;
  private evalTimer: ReturnType<typeof setInterval> | null = null;
  private dashTimer: ReturnType<typeof setInterval> | null = null;

  constructor(strategies: BaseStrategy[]) {
    this.strategies = strategies;
    this.startTime = Date.now();
  }

  start(): void {
    this.evalTimer = setInterval(() => this.evaluateAll(), EVAL_INTERVAL_MS);
    this.dashTimer = setInterval(() => this.emitDashboard(), DASH_INTERVAL_MS);
  }

  onTick(tick: Tick): void {
    for (const s of this.strategies) {
      try {
        s.onTick(tick);
      } catch (err) {
        console.error(`[arena] Error in ${s.name}:`, err);
      }
    }
  }

  evaluateAll(): void {
    const uptimeMs = Date.now() - this.startTime;
    const uptimeMin = Math.floor(uptimeMs / 60_000);
    const hours = Math.floor(uptimeMin / 60);
    const mins = uptimeMin % 60;
    const uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    const results: { strategy: BaseStrategy; metrics: PerformanceMetrics }[] = [];

    for (const s of this.strategies) {
      results.push({ strategy: s, metrics: s.getMetrics() });
    }

    const totalTrades = results.reduce((sum, r) => sum + r.metrics.totalTrades, 0);

    // Split into ranked and warming up
    const ranked = results
      .filter(r => r.metrics.totalTrades >= MIN_TRADES_FOR_RANKING)
      .sort((a, b) => b.metrics.score - a.metrics.score);

    const warmingUp = results.filter(r => r.metrics.totalTrades < MIN_TRADES_FOR_RANKING);

    // Print leaderboard
    console.log('');
    console.log(`[arena] ═══ LEADERBOARD (${uptimeStr} uptime, ${totalTrades} total trades) ═══`);

    if (ranked.length === 0) {
      console.log('[arena]   No strategies with enough trades yet');
    }

    for (let i = 0; i < ranked.length; i++) {
      const { strategy, metrics } = ranked[i];
      const rank = `#${i + 1}`;
      const pnlSign = metrics.netPnlSol >= 0 ? '+' : '';
      console.log(
        `[arena]  ${rank.padStart(3)} ${strategy.name.padEnd(16)} ` +
        `${pnlSign}${metrics.netPnlSol.toFixed(4)} SOL | ` +
        `${String(metrics.totalTrades).padStart(3)} trades | ` +
        `WR ${metrics.winRate.toFixed(1)}% | ` +
        `Sharpe ${metrics.sharpe.toFixed(2)} | ` +
        `Score ${metrics.score.toFixed(2)}`,
      );
    }

    if (warmingUp.length > 0) {
      console.log('[arena]  --- Warming up (< 5 trades) ---');
      const parts: string[] = [];
      for (const { strategy, metrics } of warmingUp) {
        parts.push(`${strategy.name} ${metrics.totalTrades} trades`);
      }
      // Print in rows of 3
      for (let i = 0; i < parts.length; i += 3) {
        const row = parts.slice(i, i + 3).join(' | ');
        console.log(`[arena]  ${row}`);
      }
    }

    console.log('');
  }

  private emitDashboard(): void {
    const uptimeMs = Date.now() - this.startTime;
    const uptimeMin = Math.floor(uptimeMs / 60_000);
    const hours = Math.floor(uptimeMin / 60);
    const mins = uptimeMin % 60;
    const uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    const entries = [];
    let totalTrades = 0;

    for (const s of this.strategies) {
      const metrics = s.getMetrics();
      totalTrades += metrics.totalTrades;
      entries.push({
        name: s.name,
        type: s.type,
        metrics: {
          totalTrades: metrics.totalTrades,
          wins: metrics.wins,
          losses: metrics.losses,
          winRate: metrics.winRate,
          netPnlSol: metrics.netPnlSol,
          sharpe: metrics.sharpe,
          score: metrics.score,
        },
        thinking: s.getThinking(),
      });
    }

    // Sort by score descending
    entries.sort((a, b) => b.metrics.score - a.metrics.score);

    dashboardBus.emitLeaderboard({ uptime: uptimeStr, totalTrades, entries });
  }

  stop(): void {
    if (this.evalTimer) {
      clearInterval(this.evalTimer);
      this.evalTimer = null;
    }
    if (this.dashTimer) {
      clearInterval(this.dashTimer);
      this.dashTimer = null;
    }
    for (const s of this.strategies) {
      s.stop();
    }
  }
}
