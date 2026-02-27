import { PriceFeed } from './feed.js';
import { STRATEGIES } from './strategies.js';
import type { StrategyConfig } from './strategies.js';
import type { BaseStrategy } from './base-strategy.js';
import { MomentumStrategy } from './momentum.js';
import { RangeStrategy } from './range.js';
import { GridStrategy } from './grid.js';
import { FadeStrategy } from './fade.js';
import { SpreadStrategy } from './spread.js';
import { BreakoutStrategy } from './breakout.js';
import { TrendStrategy } from './trend.js';
import { LevelStrategy } from './level.js';
import { RegimeStrategy } from './regime.js';
import { Arena } from './arena.js';
import { DashboardServer } from './dashboard-server.js';
import { dashboardBus } from './dashboard-bus.js';
import { BankrollManager } from './bankroll.js';

function createStrategy(config: StrategyConfig): BaseStrategy {
  switch (config.type) {
    case 'momentum':
      return new MomentumStrategy(config);
    case 'range':
      return new RangeStrategy(config);
    case 'grid':
      return new GridStrategy(config);
    case 'fade':
      return new FadeStrategy(config);
    case 'spread':
      return new SpreadStrategy(config);
    case 'breakout':
      return new BreakoutStrategy(config);
    case 'trend':
      return new TrendStrategy(config);
    case 'level':
      return new LevelStrategy(config);
    case 'regime':
      return new RegimeStrategy(config);
  }
}

function main(): void {
  const startingEquity = parseFloat(process.env.BANKROLL_SOL ?? '10');
  console.log(`[boot] Paper Trading Arena | bankroll=${startingEquity} SOL (half-Kelly sizing)`);

  const bankroll = new BankrollManager({
    mode: 'paper',
    initialEquitySol: startingEquity,
  });

  const strategies = STRATEGIES.map(createStrategy);

  // Wire bankroll into all strategies that support it
  for (const s of strategies) {
    if (s.setBankroll) s.setBankroll(bankroll);
  }

  const arena = new Arena(strategies);

  // Start dashboard
  const dashboard = new DashboardServer();
  dashboard.start();

  // Track latest SOL price for dashboard
  let lastSol = 0;

  const feed = new PriceFeed();
  feed.onTick((tick) => {
    arena.onTick(tick);

    // Wire prices to dashboard bus + bankroll
    lastSol = tick.price;
    bankroll.updateSolPrice(tick.price);
    if (lastSol > 0) {
      dashboardBus.emitPrice({ sol: lastSol, timestamp: Date.now() });
    }
  });
  feed.start();
  arena.start();

  // Startup summary
  const byType: Record<string, number> = {};
  for (const s of strategies) byType[s.type] = (byType[s.type] || 0) + 1;

  const typeSummary = Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(', ');
  console.log(`[boot] ${strategies.length} strategies loaded | ${typeSummary}`);
  console.log(`[boot] Bankroll: ${startingEquity} SOL | trend=${bankroll.getBetSize('trend')} momentum=${bankroll.getBetSize('momentum')} level=${bankroll.getBetSize('level')} regime=${bankroll.getBetSize('regime')} SOL/trade`);
  console.log('');
  console.log('  Type       Name             Key params');
  console.log('  ─────────  ───────────────  ──────────────────────────────');
  for (const c of STRATEGIES) {
    switch (c.type) {
      case 'momentum':
        console.log(`  momentum   ${c.name.padEnd(15)}  thr=${c.threshold}% TP=${c.takeProfitPct}% SL=${c.stopLossPct}% hold=${c.holdSeconds}s bet=${c.betSizeSol}`);
        break;
      case 'range':
        console.log(`  range      ${c.name.padEnd(15)}  zone=${c.entryZoneLow}/${c.entryZoneHigh} SL=${c.stopLossPct}% lb=${c.lookbackSeconds}s bet=${c.betSizeSol}`);
        break;
      case 'grid':
        console.log(`  grid       ${c.name.padEnd(15)}  spc=${c.spacingPct}% lvl=${c.levelsPerSide} bet=${c.betPerLevel}/lvl recenter=${c.recenterPct}%`);
        break;
      case 'fade':
        console.log(`  fade       ${c.name.padEnd(15)}  thr=${c.fadeThresholdPct}% SL=${c.stopLossPct}% TP=${c.takeProfitPct}% win=${c.fadeWindowSeconds}s bet=${c.betSizeSol}`);
        break;
      case 'spread':
        console.log(`  spread     ${c.name.padEnd(15)}  dev=${c.deviationThreshold}σ TP=${c.takeProfitPct}% SL=${c.stopLossPct}% cd=${c.cooldownSeconds}s bet=${c.betSizeSol}`);
        break;
      case 'breakout':
        console.log(`  breakout   ${c.name.padEnd(15)}  brk=${c.breakoutPct}% trail=${c.trailingStopPct}% lb=${c.lookbackSeconds}s bet=${c.betSizeSol}`);
        break;
      case 'trend':
        console.log(`  trend      ${c.name.padEnd(15)}  thr=${c.threshold}% trail=${c.trailingStopPct}% delay=${c.trailDelaySeconds}s SL=${c.stopLossPct}% bet=${c.betSizeSol}`);
        break;
      case 'level':
        console.log(`  level      ${c.name.padEnd(15)}  lb=${c.lookbackSeconds / 3600}h tol=${c.touchTolerancePct}% SL=${c.stopLossPct}% bet=${c.betSizeSol} 0%fee`);
        break;
      case 'regime':
        console.log(`  regime     ${c.name.padEnd(15)}  atr=${c.atrPeriod}m trd=${c.trendThreshold}× rng=${c.rangeThreshold}× sig=${c.signalMultiple}× trail=${c.trailingAtrMultiple}× SL=${c.slAtrMultiple}× bet=${c.betSizeSol}`);
        break;
    }
  }
  console.log('');
  console.log('[boot] Waiting for Pyth price feed...');

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.log(`\n[boot] ${signal} received, shutting down...`);
    feed.stop();
    arena.stop();
    dashboard.stop();
    dashboardBus.shutdown();
    console.log('[boot] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
