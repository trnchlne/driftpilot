/**
 * Focused backtest: Test R-base with different minAtrPct filters and UNCERTAIN SL values.
 *
 * Goal: Find settings that reduce chop trades (short-duration losers in low vol)
 * without sacrificing the big winning trades.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tick } from './feed.js';
import { RegimeStrategy, type RegimeConfig } from './regime.js';
import { BankrollManager } from './bankroll.js';

/* ─── Data Loading ─────────────────────────────────────── */

function loadTicks(filePath: string): Tick[] {
  const raw = readFileSync(filePath, 'utf-8');
  const ticks: Tick[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      ticks.push({ feedId: obj.feedId, price: obj.price, publishTime: obj.publishTime });
    } catch { /* skip */ }
  }
  ticks.sort((a, b) => a.publishTime - b.publishTime);
  return ticks;
}

/* ─── Trade Tracker (patches into PaperTrader onTrade) ── */

interface TradeRecord {
  direction: string;
  entryPrice: number;
  exitPrice: number;
  netPnlSol: number;
  holdSeconds: number;
  entryTime: number;
}

/* ─── Run a single config and collect detailed trade data ─ */

function runConfig(
  config: RegimeConfig,
  ticks: Tick[],
  equitySol: number,
): { trades: TradeRecord[]; finalEquity: number; roi: number } {
  const bankroll = new BankrollManager({
    mode: 'paper',
    initialEquitySol: equitySol,
  });
  const strategy = new RegimeStrategy(config);
  strategy.setBankroll(bankroll);

  const trades: TradeRecord[] = [];

  // Hook into the strategy's PaperTrader to capture trade details
  // We'll extract trades from metrics diffs
  let lastTradeCount = 0;

  const origLog = console.log;
  console.log = () => {};

  for (const tick of ticks) {
    bankroll.updateSolPrice(tick.price);
    strategy.onTick(tick);

    const m = strategy.getMetrics();
    if (m.totalTrades > lastTradeCount) {
      // A trade just closed — we can't get exact details from metrics alone
      // but we track the count
      lastTradeCount = m.totalTrades;
    }
  }

  console.log = origLog;

  const metrics = strategy.getMetrics();
  const finalEquity = bankroll.getEquity();

  return {
    trades,
    finalEquity,
    roi: ((finalEquity / equitySol) - 1) * 100,
  };
}

/* ─── Enhanced run that captures per-trade data ───────── */

function runConfigDetailed(
  config: RegimeConfig,
  ticks: Tick[],
  equitySol: number,
): {
  totalTrades: number;
  wins: number;
  winRate: number;
  netPnlSol: number;
  roi: number;
  sharpe: number;
  profitFactor: number;
  maxDdPct: number;
  avgHoldMin: number;
  shortTradesCount: number;  // trades < 15 min
  shortTradesPnl: number;
  longTradesCount: number;   // trades >= 1 hour
  longTradesPnl: number;
} {
  const bankroll = new BankrollManager({
    mode: 'paper',
    initialEquitySol: equitySol,
  });
  const strategy = new RegimeStrategy(config);
  strategy.setBankroll(bankroll);

  // Capture trades via the dashboard bus
  const tradeHolds: number[] = [];
  const tradePnls: number[] = [];
  let shortCount = 0, shortPnl = 0;
  let longCount = 0, longPnl = 0;

  // Monkey-patch to capture trade data from console output
  const origLog = console.log;
  const holdPattern = /EXIT \w+ \((\d+)s\).*net ([+-]?\d+\.\d+) SOL/;
  console.log = (...args: unknown[]) => {
    const msg = String(args[0] ?? '');
    const match = holdPattern.exec(msg);
    if (match) {
      const holdSec = parseInt(match[1], 10);
      const pnl = parseFloat(match[2]);
      tradeHolds.push(holdSec);
      tradePnls.push(pnl);
      if (holdSec < 900) { shortCount++; shortPnl += pnl; }
      if (holdSec >= 3600) { longCount++; longPnl += pnl; }
    }
  };

  let peakEquity = equitySol;
  let maxDdPct = 0;
  let lastSnapTime = 0;

  for (const tick of ticks) {
    bankroll.updateSolPrice(tick.price);
    strategy.onTick(tick);

    if (tick.publishTime - lastSnapTime >= 60) {
      const eq = bankroll.getEquity();
      if (eq > peakEquity) peakEquity = eq;
      const dd = peakEquity > 0 ? ((peakEquity - eq) / peakEquity) * 100 : 0;
      if (dd > maxDdPct) maxDdPct = dd;
      lastSnapTime = tick.publishTime;
    }
  }

  console.log = origLog;

  const metrics = strategy.getMetrics();
  const finalEquity = bankroll.getEquity();
  const avgHold = tradeHolds.length > 0 ? tradeHolds.reduce((a, b) => a + b, 0) / tradeHolds.length : 0;

  return {
    totalTrades: metrics.totalTrades,
    wins: metrics.wins,
    winRate: metrics.winRate,
    netPnlSol: metrics.netPnlSol,
    roi: ((finalEquity / equitySol) - 1) * 100,
    sharpe: metrics.sharpe,
    profitFactor: metrics.profitFactor,
    maxDdPct,
    avgHoldMin: avgHold / 60,
    shortTradesCount: shortCount,
    shortTradesPnl: shortPnl,
    longTradesCount: longCount,
    longTradesPnl: longPnl,
  };
}

/* ─── Main ─────────────────────────────────────────────── */

function main(): void {
  const args = process.argv.slice(2);
  let dataPath = '';
  let equitySol = 3.0; // per-strategy equity (same as grid search)

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data' && args[i + 1]) { dataPath = args[i + 1]; i++; }
    if (args[i] === '--equity' && args[i + 1]) { equitySol = parseFloat(args[i + 1]); i++; }
  }

  if (!dataPath) {
    console.error('Usage: npx tsx src/backtest_atr_filter.ts --data <path-to-jsonl> [--equity 3]');
    process.exit(1);
  }

  const resolvedPath = resolve(dataPath);
  console.log(`Loading ticks from ${resolvedPath}...`);

  const ticks = loadTicks(resolvedPath);
  const firstTs = ticks[0].publishTime;
  const lastTs = ticks[ticks.length - 1].publishTime;
  const totalHours = (lastTs - firstTs) / 3600;

  console.log(`${ticks.length.toLocaleString()} ticks (${totalHours.toFixed(0)}h)`);
  console.log(`Equity per config: ${equitySol} SOL`);
  console.log('');

  // Base R-base config (current winning config from grid search #2)
  const baseConfig: RegimeConfig = {
    type: 'regime', name: 'R-base',
    atrPeriod: 60, regimeWindowSeconds: 4 * 3600,
    trendThreshold: 1.5, rangeThreshold: 0.5,
    signalWindowSeconds: 30 * 60, signalMultiple: 4.0,
    trailingAtrMultiple: 7.0, slAtrMultiple: 10.0,
    trailDelaySeconds: 480,
    meanWindowSeconds: 2 * 3600, entryBandMultiple: 2.5,
    reversionSlMultiple: 4.0,
    cooldownSeconds: 300, betSizeSol: 1.0,
  };

  // Test matrix: combinations of minAtrPct and uncertainSlMultiple
  const minAtrValues = [0, 0.002, 0.003, 0.005, 0.008];
  const uncertainSlValues = [1.0, 3.0, 5.0, 10.0]; // 10.0 = same as TRENDING

  interface TestCase {
    label: string;
    config: RegimeConfig;
  }

  const tests: TestCase[] = [];

  // First: test minAtrPct values (with default uncertain SL=1.0)
  for (const minAtr of minAtrValues) {
    tests.push({
      label: `atr≥${minAtr.toFixed(3)} uSL=1.0`,
      config: { ...baseConfig, name: `test`, minAtrPct: minAtr || undefined },
    });
  }

  // Then: test uncertainSl values (with no ATR filter)
  for (const uSl of uncertainSlValues) {
    if (uSl === 1.0) continue; // already tested above
    tests.push({
      label: `atr≥0     uSL=${uSl.toFixed(1)}`,
      config: { ...baseConfig, name: `test`, uncertainSlMultiple: uSl },
    });
  }

  // Combinations: best ATR filters × best uncertain SL
  for (const minAtr of [0.003, 0.005]) {
    for (const uSl of [3.0, 5.0, 10.0]) {
      tests.push({
        label: `atr≥${minAtr.toFixed(3)} uSL=${uSl.toFixed(1)}`,
        config: { ...baseConfig, name: `test`, minAtrPct: minAtr, uncertainSlMultiple: uSl },
      });
    }
  }

  // Run all tests
  console.log('Running comparison...');
  console.log('');

  const W = 150;
  console.log('═'.repeat(W));
  console.log('  R-BASE ATR FILTER & UNCERTAIN SL COMPARISON');
  console.log('═'.repeat(W));
  console.log('');
  console.log('  Config                  Trades  Wins   WR%     ROI%  NetPnL SOL  Sharpe    PF   MaxDD%  AvgHold  <15m trades  <15m PnL  ≥1h trades  ≥1h PnL');
  console.log('  ──────────────────────  ──────  ─────  ─────  ─────  ─────────  ──────  ─────  ──────  ───────  ──────────  ────────  ──────────  ───────');

  for (const test of tests) {
    const r = runConfigDetailed(test.config, ticks, equitySol);

    const label = test.label.padEnd(22);
    const trades = String(r.totalTrades).padStart(6);
    const wins = String(r.wins).padStart(5);
    const wr = `${r.winRate.toFixed(1)}%`.padStart(5);
    const roi = `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`.padStart(6);
    const pnl = `${r.netPnlSol >= 0 ? '+' : ''}${r.netPnlSol.toFixed(4)}`.padStart(9);
    const sharpe = r.sharpe.toFixed(3).padStart(6);
    const pf = r.profitFactor === Infinity ? '   Inf' : r.profitFactor.toFixed(2).padStart(5);
    const dd = `${r.maxDdPct.toFixed(1)}%`.padStart(6);
    const avgH = `${r.avgHoldMin.toFixed(0)}m`.padStart(7);
    const shortC = String(r.shortTradesCount).padStart(10);
    const shortP = `${r.shortTradesPnl >= 0 ? '+' : ''}${r.shortTradesPnl.toFixed(4)}`.padStart(8);
    const longC = String(r.longTradesCount).padStart(10);
    const longP = `${r.longTradesPnl >= 0 ? '+' : ''}${r.longTradesPnl.toFixed(4)}`.padStart(7);

    console.log(`  ${label}  ${trades}  ${wins}  ${wr}  ${roi}  ${pnl}  ${sharpe}  ${pf}  ${dd}  ${avgH}  ${shortC}  ${shortP}  ${longC}  ${longP}`);
  }

  console.log('');
  console.log('Notes:');
  console.log('  - "<15m trades" = trades held less than 15 minutes (likely chop)');
  console.log('  - "≥1h trades" = trades held 1+ hours (likely real signals)');
  console.log('  - uSL = UNCERTAIN regime SL multiplier (default 1.0× = very tight)');
  console.log('  - minAtrPct = skip entries when per-minute ATR% is below threshold');
  console.log('  - Higher minAtrPct → fewer chop trades → slot free for good signals');
  console.log('');

  // Now run time-period breakdown for the top 3 configs
  console.log('═'.repeat(W));
  console.log('  TIME-PERIOD BREAKDOWN — Top configs');
  console.log('═'.repeat(W));

  // Run baseline + a few promising combos across time windows
  const periodDefs = [
    { label: 'Full 2Y', seconds: lastTs - firstTs },
    { label: 'Last 1Y', seconds: 365 * 24 * 3600 },
    { label: 'Last 6M', seconds: 182 * 24 * 3600 },
    { label: 'Last 3M', seconds: 91 * 24 * 3600 },
  ];

  // Configs to compare across periods
  const periodConfigs: { label: string; config: RegimeConfig }[] = [
    { label: 'BASELINE (no filter)', config: baseConfig },
    { label: 'atr≥0.003', config: { ...baseConfig, name: 'test', minAtrPct: 0.003 } },
    { label: 'atr≥0.005', config: { ...baseConfig, name: 'test', minAtrPct: 0.005 } },
    { label: 'uSL=5.0', config: { ...baseConfig, name: 'test', uncertainSlMultiple: 5.0 } },
    { label: 'atr≥0.003+uSL=5', config: { ...baseConfig, name: 'test', minAtrPct: 0.003, uncertainSlMultiple: 5.0 } },
    { label: 'atr≥0.005+uSL=5', config: { ...baseConfig, name: 'test', minAtrPct: 0.005, uncertainSlMultiple: 5.0 } },
    { label: 'atr≥0.003+uSL=10', config: { ...baseConfig, name: 'test', minAtrPct: 0.003, uncertainSlMultiple: 10.0 } },
    { label: 'atr≥0.005+uSL=10', config: { ...baseConfig, name: 'test', minAtrPct: 0.005, uncertainSlMultiple: 10.0 } },
  ];

  console.log('');
  let header = '  Config'.padEnd(26);
  for (const pd of periodDefs) header += pd.label.padStart(12);
  console.log(header);
  console.log('  ' + '─'.repeat(24 + periodDefs.length * 12));

  for (const pc of periodConfigs) {
    let row = `  ${pc.label}`.padEnd(26);
    for (const pd of periodDefs) {
      const startTs = Math.max(firstTs, lastTs - pd.seconds);
      const periodTicks = ticks.filter(t => t.publishTime >= startTs && t.publishTime <= lastTs);
      const r = runConfigDetailed(pc.config, periodTicks, equitySol);
      row += `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%`.padStart(12);
    }
    console.log(row);
  }

  console.log('');
}

main();
