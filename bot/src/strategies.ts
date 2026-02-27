export type StrategyConfig =
  | {
      type: 'momentum'; name: string; threshold: number;
      window: number; holdSeconds: number; betSizeSol: number;
      takeProfitPct: number; stopLossPct: number;
    }
  | {
      type: 'range'; name: string; lookbackSeconds: number;
      entryZoneLow: number; entryZoneHigh: number; stopLossPct: number;
      minChannelPct: number; betSizeSol: number; maxHoldSeconds: number;
    }
  | {
      type: 'grid'; name: string; spacingPct: number;
      levelsPerSide: number; betPerLevel: number;
      recenterPct: number; maxExposureSol: number;
    }
  | {
      type: 'fade'; name: string; fadeThresholdPct: number;
      fadeWindowSeconds: number; stopLossPct: number;
      takeProfitPct: number; divergenceMinPct: number;
      betSizeSol: number; maxHoldSeconds: number;
    }
  | {
      type: 'spread'; name: string; lookbackSeconds: number;
      deviationThreshold: number; stopLossPct: number;
      takeProfitPct: number; cooldownSeconds: number;
      maxHoldSeconds: number; betSizeSol: number; minSamples: number;
    }
  | {
      type: 'breakout'; name: string; lookbackSeconds: number;
      breakoutPct: number; trailingStopPct: number;
      maxHoldSeconds: number; betSizeSol: number;
      minConsolidationPct: number;
    }
  | {
      type: 'trend'; name: string; threshold: number;
      window: number; trailingStopPct: number; trailDelaySeconds: number;
      stopLossPct: number; betSizeSol: number;
    }
  | {
      type: 'level'; name: string; lookbackSeconds: number;
      supportPct: number; resistancePct: number;
      recalcIntervalSeconds: number; touchTolerancePct: number;
      cooldownSeconds: number; stopLossPct: number;
      fundingLookbackSeconds: number; fundingBiasMinPct: number;
      betSizeSol: number; minSamplesForLevel: number;
      regimeFilterPct: number; regimeFilterSeconds: number;
    }
  | {
      type: 'regime'; name: string;
      atrPeriod: number; regimeWindowSeconds: number;
      trendThreshold: number; rangeThreshold: number;
      signalWindowSeconds: number; signalMultiple: number;
      trailingAtrMultiple: number; slAtrMultiple: number;
      trailDelaySeconds: number;
      meanWindowSeconds: number; entryBandMultiple: number;
      reversionSlMultiple: number;
      cooldownSeconds: number; betSizeSol: number;
      minAtrPct?: number;
      uncertainMultiple?: number;
    };

export const STRATEGIES: StrategyConfig[] = [
  // ═══════════════════════════════════════════════════════════
  // Optimized configs from 365-day backtest + hyper-grid search
  // (295 variants tested, round 2 combined winners, all 4/4
  //  quarters profitable). Max 1 SOL per bet.
  // ═══════════════════════════════════════════════════════════

  // ── Trend (champion) — wide trail + long delay ──────────────
  // #1 overall: +1.54 SOL/yr, Sharpe 0.131, 45.7% WR, 4/4 quarters
  { type: 'trend', name: 'T-champion',   threshold: 0.50, window: 180, trailingStopPct: 2.50, trailDelaySeconds: 900, stopLossPct: 2.50, betSizeSol: 1.0 },
  // Runner-up variants for diversification
  { type: 'trend', name: 'T-fast-trail', threshold: 0.50, window: 180, trailingStopPct: 2.50, trailDelaySeconds: 180, stopLossPct: 2.50, betSizeSol: 1.0 },
  { type: 'trend', name: 'T-narrow',     threshold: 0.50, window: 180, trailingStopPct: 2.00, trailDelaySeconds: 480, stopLossPct: 1.50, betSizeSol: 1.0 },
  { type: 'trend', name: 'T-ultra-wide', threshold: 0.50, window: 180, trailingStopPct: 3.00, trailDelaySeconds: 480, stopLossPct: 3.00, betSizeSol: 1.0 },
  { type: 'trend', name: 'T-selective',  threshold: 0.55, window: 180, trailingStopPct: 2.50, trailDelaySeconds: 480, stopLossPct: 2.50, betSizeSol: 1.0 },

  // ── Level (3h lookback, tight tolerance, no funding bias) ───
  // #18 overall: +0.70 SOL/yr, 0% maker fees, 2407 trades
  { type: 'level', name: 'L3-nofund',    lookbackSeconds: 3*3600, supportPct: 10, resistancePct: 90, recalcIntervalSeconds: 120, touchTolerancePct: 0.03, cooldownSeconds: 300,  stopLossPct: 0.80, fundingLookbackSeconds: 5400, fundingBiasMinPct: 999,  betSizeSol: 1.0, minSamplesForLevel: 100, regimeFilterPct: 1.5, regimeFilterSeconds: 7200 },
  { type: 'level', name: 'L3-fund',      lookbackSeconds: 3*3600, supportPct: 10, resistancePct: 90, recalcIntervalSeconds: 120, touchTolerancePct: 0.03, cooldownSeconds: 300,  stopLossPct: 0.80, fundingLookbackSeconds: 5400, fundingBiasMinPct: 0.3,  betSizeSol: 1.0, minSamplesForLevel: 100, regimeFilterPct: 1.5, regimeFilterSeconds: 7200 },
  { type: 'level', name: 'L3-p15/85',    lookbackSeconds: 3*3600, supportPct: 15, resistancePct: 85, recalcIntervalSeconds: 120, touchTolerancePct: 0.03, cooldownSeconds: 300,  stopLossPct: 0.80, fundingLookbackSeconds: 5400, fundingBiasMinPct: 0.3,  betSizeSol: 1.0, minSamplesForLevel: 100, regimeFilterPct: 1.5, regimeFilterSeconds: 7200 },
  { type: 'level', name: 'L3-longcd',    lookbackSeconds: 3*3600, supportPct: 10, resistancePct: 90, recalcIntervalSeconds: 120, touchTolerancePct: 0.03, cooldownSeconds: 1200, stopLossPct: 0.80, fundingLookbackSeconds: 5400, fundingBiasMinPct: 0.3,  betSizeSol: 1.0, minSamplesForLevel: 100, regimeFilterPct: 1.5, regimeFilterSeconds: 7200 },

  // ── Momentum (big TP, let winners run) ──────────────────────
  // Best momentum: TP=3.0% (21% WR but big wins), Sharpe 0.062
  { type: 'momentum', name: 'M-bigtp3',  threshold: 0.55, window: 180, holdSeconds: 0, betSizeSol: 1.0, takeProfitPct: 3.00, stopLossPct: 0.50 },
  // More-trades variant
  { type: 'momentum', name: 'M-active',  threshold: 0.50, window: 180, holdSeconds: 0, betSizeSol: 1.0, takeProfitPct: 0.90, stopLossPct: 0.50 },
  // Base proven config
  { type: 'momentum', name: 'M-base',    threshold: 0.55, window: 180, holdSeconds: 0, betSizeSol: 1.0, takeProfitPct: 0.90, stopLossPct: 0.50 },

  // ── Regime-Switching Hybrid (ATR-adaptive, sqrt-scaled thresholds) ──
  // Grid search #2 winners from 309 configs on 2Y data (3 SOL/account, Kelly 25%)
  // Very wide stops (sl=10, tr=7) are the dominant winning pattern
  // #1: +55.3% ROI @30% Kelly, +35-45% @25% Kelly — 30m signal, ultra-wide stops, balanced regime
  // Fine-grid optimized: avg +158% ROI across 30-180d (10x lev, 30% Kelly, pure ATR trail)
  // Combined cross-parameter search: 4374 combos, all periods positive, avg Sharpe 0.213
  // Key changes from prev: trail 0.8→0.7, sl 1.5→1.0, sig 4.0→4.5, win 30m→25m, trend 1.5→1.2, range 0.8→1.0
  { type: 'regime', name: 'R-base',   atrPeriod: 90, regimeWindowSeconds: 4*3600, trendThreshold: 1.2, rangeThreshold: 1.0, signalWindowSeconds: 25*60, signalMultiple: 4.5, trailingAtrMultiple: 0.8, slAtrMultiple: 1.0, trailDelaySeconds: 300, meanWindowSeconds: 1*3600, entryBandMultiple: 2.5, reversionSlMultiple: 4.0, cooldownSeconds: 120, betSizeSol: 1.0, minAtrPct: 0.035, uncertainMultiple: 1.0 },
  // Selective variant: trend-heavy regime, higher signal bar — fewer trades, better Sharpe
  { type: 'regime', name: 'R-sharp',  atrPeriod: 60, regimeWindowSeconds: 4*3600, trendThreshold: 1.0, rangeThreshold: 0.2, signalWindowSeconds: 30*60, signalMultiple: 5.0, trailingAtrMultiple: 1.5, slAtrMultiple: 2.5, trailDelaySeconds: 480, meanWindowSeconds: 2*3600, entryBandMultiple: 2.5, reversionSlMultiple: 4.0, cooldownSeconds: 300, betSizeSol: 1.0 },
  // Fast ATR variant: quicker adaptation, 15m signal window — more responsive to vol changes
  { type: 'regime', name: 'R-fast',   atrPeriod: 30, regimeWindowSeconds: 4*3600, trendThreshold: 1.5, rangeThreshold: 0.5, signalWindowSeconds: 15*60, signalMultiple: 4.0, trailingAtrMultiple: 1.5, slAtrMultiple: 2.5, trailDelaySeconds: 480, meanWindowSeconds: 2*3600, entryBandMultiple: 2.5, reversionSlMultiple: 4.0, cooldownSeconds: 300, betSizeSol: 1.0 },
];

// Strategy name → Drift subaccount ID (one subaccount per strategy for isolation)
export const SUBACCOUNT_MAP: Record<string, number> = {
  'T-champion':   0,
  'T-fast-trail': 1,
  'T-narrow':     2,
  'T-ultra-wide': 3,
  'T-selective':  4,
  'L3-nofund':    5,
  'L3-fund':      6,
  'L3-p15/85':    7,
  'L3-longcd':    8,
  'M-bigtp3':     9,
  'M-active':    10,
  'M-base':      11,
  'R-base':      12,
  'R-sharp':     13,
  'R-fast':      14,
};

export const ALL_SUB_ACCOUNT_IDS = Object.values(SUBACCOUNT_MAP);

/** Look up stop-loss % for a strategy by name.
 *  Regime strategies use dynamic ATR-based SL — returns a 2% safety SL
 *  for the on-chain trigger order as a backstop when the bot is offline. */
export function getStopLossPct(name: string): number {
  const config = STRATEGIES.find(s => s.name === name);
  if (!config) throw new Error(`Unknown strategy: ${name}`);
  if (config.type === 'regime') return 2.0; // safety backstop — matches hard SL
  if (!('stopLossPct' in config)) throw new Error(`Strategy ${name} has no stopLossPct`);
  return config.stopLossPct;
}
