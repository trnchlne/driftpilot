/**
 * Backtest: Should we dynamically swap collateral between SOL and USDC
 * based on the regime classifier?
 *
 * Strategy:
 *   TRENDING UP / UNCERTAIN  → hold SOL (benefit from appreciation)
 *   TRENDING DOWN / RANGING   → hold USDC (protect from drawdown)
 *
 * Compares vs:
 *   1. Always hold SOL (buy-and-hold)
 *   2. Always hold USDC (no spot exposure)
 *
 * Uses R-base regime classifier config.
 */

import { readFileSync } from 'node:fs';

// ── Config (R-base params) ──
const ATR_PERIOD = 90;
const REGIME_WINDOW_SECONDS = 4 * 3600;
const TREND_THRESHOLD = 1.2;
const RANGE_THRESHOLD = 1.0;
const MIN_ATR_PCT = 0.035;

// ── Load ticks ──
interface Tick {
  price: number;
  publishTime: number;
}

function loadTicks(file: string): Tick[] {
  const raw = readFileSync(file, 'utf-8');
  const ticks: Tick[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = JSON.parse(trimmed);
    ticks.push({ price: obj.price, publishTime: obj.publishTime });
  }
  ticks.sort((a, b) => a.publishTime - b.publishTime);
  return ticks;
}

// ── Regime Classifier (standalone, extracted from regime.ts) ──
interface PriceSample { time: number; price: number; }

class RegimeClassifier {
  private atrBuffer: number[] = [];
  private priceBuffer: PriceSample[] = [];
  private lastAtrPrice = 0;
  private lastAtrSampleTime = 0;
  private atrPct = 0;
  private warmedUp = false;

  currentRegime: 'TRENDING' | 'RANGING' | 'UNCERTAIN' = 'UNCERTAIN';
  trendDirection: 'UP' | 'DOWN' = 'UP';

  onTick(price: number, time: number): boolean {
    // ATR update (once per minute)
    if (this.lastAtrPrice > 0) {
      if (time - this.lastAtrSampleTime >= 60) {
        const delta = Math.abs(price - this.lastAtrPrice);
        const deltaPct = (delta / this.lastAtrPrice) * 100;
        this.atrBuffer.push(deltaPct);
        if (this.atrBuffer.length > ATR_PERIOD) this.atrBuffer.shift();
        this.lastAtrSampleTime = time;
        this.lastAtrPrice = price;

        if (this.atrBuffer.length > 0) {
          const sum = this.atrBuffer.reduce((a, b) => a + b, 0);
          this.atrPct = sum / this.atrBuffer.length;
        }
      }
    } else {
      this.lastAtrSampleTime = time;
      this.lastAtrPrice = price;
    }

    // Price buffer
    this.priceBuffer.push({ time, price });
    const cutoff = time - REGIME_WINDOW_SECONDS;
    while (this.priceBuffer.length > 0 && this.priceBuffer[0].time < cutoff) {
      this.priceBuffer.shift();
    }

    // Warmup
    if (!this.warmedUp) {
      const atrFull = this.atrBuffer.length >= ATR_PERIOD;
      const bufferSpan = this.priceBuffer.length > 0
        ? time - this.priceBuffer[0].time : 0;
      if (atrFull && bufferSpan >= REGIME_WINDOW_SECONDS * 0.9) {
        this.warmedUp = true;
      } else {
        return false;
      }
    }

    // Classify
    const windowStart = time - REGIME_WINDOW_SECONDS;
    let oldest: PriceSample | null = null;
    for (const s of this.priceBuffer) {
      if (s.time >= windowStart) { oldest = s; break; }
    }
    if (!oldest) return true;

    const changePct = ((price / oldest.price) - 1) * 100;
    const absChange = Math.abs(changePct);
    const regimeAtr = this.atrPct * Math.sqrt(REGIME_WINDOW_SECONDS / 60);

    if (absChange > TREND_THRESHOLD * regimeAtr) {
      this.currentRegime = 'TRENDING';
      this.trendDirection = changePct > 0 ? 'UP' : 'DOWN';
    } else if (absChange < RANGE_THRESHOLD * regimeAtr) {
      this.currentRegime = 'RANGING';
    } else {
      this.currentRegime = 'UNCERTAIN';
    }

    return true;
  }
}

// ── Run simulation ──
function simulate(ticks: Tick[], label: string) {
  const classifier = new RegimeClassifier();
  const startPrice = ticks[0].price;
  const endPrice = ticks[ticks.length - 1].price;

  // Track collateral state
  let holdingSOL = true; // start in SOL
  let solAmount = 1.0;   // start with 1 SOL
  let usdcAmount = 0;
  let swapCount = 0;
  let lastSwapTime = 0;
  const MIN_SWAP_INTERVAL = 300; // don't swap more than every 5 min

  // For comparison
  const startUsdValue = startPrice; // 1 SOL worth

  // Track regime time
  let trendUpTicks = 0;
  let trendDownTicks = 0;
  let rangingTicks = 0;
  let uncertainTicks = 0;
  let totalTicks = 0;

  // Track per-month performance
  const monthlySnaps: { month: string; swapValue: number; holdValue: number; usdcValue: number }[] = [];
  let lastMonth = '';

  for (const tick of ticks) {
    const ready = classifier.onTick(tick.price, tick.publishTime);
    if (!ready) continue;

    totalTicks++;
    const regime = classifier.currentRegime;
    const dir = classifier.trendDirection;

    if (regime === 'TRENDING' && dir === 'UP') trendUpTicks++;
    else if (regime === 'TRENDING' && dir === 'DOWN') trendDownTicks++;
    else if (regime === 'RANGING') rangingTicks++;
    else uncertainTicks++;

    // Swap logic: hold SOL when bullish, USDC when bearish/ranging
    const wantSOL = (regime === 'TRENDING' && dir === 'UP') || regime === 'UNCERTAIN';

    if (wantSOL && !holdingSOL && (tick.publishTime - lastSwapTime > MIN_SWAP_INTERVAL)) {
      // Swap USDC → SOL
      solAmount = usdcAmount / tick.price;
      usdcAmount = 0;
      holdingSOL = true;
      swapCount++;
      lastSwapTime = tick.publishTime;
    } else if (!wantSOL && holdingSOL && (tick.publishTime - lastSwapTime > MIN_SWAP_INTERVAL)) {
      // Swap SOL → USDC
      usdcAmount = solAmount * tick.price;
      solAmount = 0;
      holdingSOL = false;
      swapCount++;
      lastSwapTime = tick.publishTime;
    }

    // Monthly snapshot
    const date = new Date(tick.publishTime * 1000);
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (month !== lastMonth) {
      const swapValue = holdingSOL ? solAmount * tick.price : usdcAmount;
      monthlySnaps.push({
        month,
        swapValue,
        holdValue: tick.price, // 1 SOL at current price
        usdcValue: startUsdValue, // always the same
      });
      lastMonth = month;
    }
  }

  // Final values
  const lastPrice = ticks[ticks.length - 1].price;
  const swapFinalUsd = holdingSOL ? solAmount * lastPrice : usdcAmount;
  const holdFinalUsd = lastPrice; // 1 SOL
  const usdcFinalUsd = startUsdValue; // never changed

  const swapRoi = ((swapFinalUsd - startUsdValue) / startUsdValue) * 100;
  const holdRoi = ((holdFinalUsd - startUsdValue) / startUsdValue) * 100;

  const durationDays = (ticks[ticks.length - 1].publishTime - ticks[0].publishTime) / 86400;

  console.log(`\n═══ ${label} (${Math.round(durationDays)} days) ═══`);
  console.log(`SOL price: $${startPrice.toFixed(2)} → $${endPrice.toFixed(2)} (${holdRoi >= 0 ? '+' : ''}${holdRoi.toFixed(1)}%)`);
  console.log(`\nRegime distribution:`);
  console.log(`  TRENDING UP:   ${((trendUpTicks / totalTicks) * 100).toFixed(1)}%`);
  console.log(`  TRENDING DOWN: ${((trendDownTicks / totalTicks) * 100).toFixed(1)}%`);
  console.log(`  RANGING:       ${((rangingTicks / totalTicks) * 100).toFixed(1)}%`);
  console.log(`  UNCERTAIN:     ${((uncertainTicks / totalTicks) * 100).toFixed(1)}%`);
  console.log(`\nResults (starting with 1 SOL = $${startUsdValue.toFixed(2)}):`);
  console.log(`  Always SOL:     $${holdFinalUsd.toFixed(2)}  (${holdRoi >= 0 ? '+' : ''}${holdRoi.toFixed(1)}%)`);
  console.log(`  Always USDC:    $${usdcFinalUsd.toFixed(2)}  (0.0%)`);
  console.log(`  Regime Swap:    $${swapFinalUsd.toFixed(2)}  (${swapRoi >= 0 ? '+' : ''}${swapRoi.toFixed(1)}%)`);
  console.log(`  Swaps executed: ${swapCount}`);

  const alpha = swapRoi - holdRoi;
  console.log(`\n  Alpha vs hold SOL: ${alpha >= 0 ? '+' : ''}${alpha.toFixed(1)}%`);
  console.log(`  Alpha vs USDC:     ${swapRoi >= 0 ? '+' : ''}${swapRoi.toFixed(1)}%`);

  // Monthly breakdown
  console.log(`\nMonthly value (regime-swap strategy):`);
  for (const snap of monthlySnaps) {
    const roi = ((snap.swapValue - startUsdValue) / startUsdValue) * 100;
    const holdRoiM = ((snap.holdValue - startUsdValue) / startUsdValue) * 100;
    console.log(`  ${snap.month}: $${snap.swapValue.toFixed(2)} (${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%) vs hold $${snap.holdValue.toFixed(2)} (${holdRoiM >= 0 ? '+' : ''}${holdRoiM.toFixed(1)}%)`);
  }

  return { swapRoi, holdRoi, alpha, swapCount };
}

// Also test: swap only on TRENDING DOWN (more conservative)
function simulateConservative(ticks: Tick[], label: string) {
  const classifier = new RegimeClassifier();
  const startPrice = ticks[0].price;

  let holdingSOL = true;
  let solAmount = 1.0;
  let usdcAmount = 0;
  let swapCount = 0;
  let lastSwapTime = 0;
  const MIN_SWAP_INTERVAL = 300;
  const startUsdValue = startPrice;

  for (const tick of ticks) {
    const ready = classifier.onTick(tick.price, tick.publishTime);
    if (!ready) continue;

    const regime = classifier.currentRegime;
    const dir = classifier.trendDirection;

    // Conservative: only swap to USDC during confirmed downtrend
    const wantUSDC = regime === 'TRENDING' && dir === 'DOWN';

    if (!wantUSDC && !holdingSOL && (tick.publishTime - lastSwapTime > MIN_SWAP_INTERVAL)) {
      solAmount = usdcAmount / tick.price;
      usdcAmount = 0;
      holdingSOL = true;
      swapCount++;
      lastSwapTime = tick.publishTime;
    } else if (wantUSDC && holdingSOL && (tick.publishTime - lastSwapTime > MIN_SWAP_INTERVAL)) {
      usdcAmount = solAmount * tick.price;
      solAmount = 0;
      holdingSOL = false;
      swapCount++;
      lastSwapTime = tick.publishTime;
    }
  }

  const lastPrice = ticks[ticks.length - 1].price;
  const swapFinalUsd = holdingSOL ? solAmount * lastPrice : usdcAmount;
  const swapRoi = ((swapFinalUsd - startUsdValue) / startUsdValue) * 100;
  const holdRoi = ((lastPrice - startUsdValue) / startUsdValue) * 100;
  const alpha = swapRoi - holdRoi;

  console.log(`\n── ${label} (conservative: only hedge downtrends) ──`);
  console.log(`  Regime Swap:    $${swapFinalUsd.toFixed(2)}  (${swapRoi >= 0 ? '+' : ''}${swapRoi.toFixed(1)}%)`);
  console.log(`  Swaps executed: ${swapCount}`);
  console.log(`  Alpha vs hold:  ${alpha >= 0 ? '+' : ''}${alpha.toFixed(1)}%`);

  return { swapRoi, holdRoi, alpha, swapCount };
}

// ── Main ──
const DATA_DIR = new URL('../data/', import.meta.url).pathname;

// Test on multiple timeframes
for (const file of ['history-90d.jsonl', 'history-180d.jsonl', 'history-365d.jsonl', 'history-2y.jsonl']) {
  try {
    const ticks = loadTicks(`${DATA_DIR}${file}`);
    if (ticks.length < 1000) continue;
    simulate(ticks, file.replace('.jsonl', ''));
    simulateConservative(ticks, file.replace('.jsonl', ''));
  } catch (err) {
    console.log(`Skipping ${file}: ${(err as Error).message}`);
  }
}
