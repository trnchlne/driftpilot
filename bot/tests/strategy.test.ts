import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Strategy } from '../src/strategy.js';
import { SOL_FEED_ID } from '../src/feed.js';
import type { DriftWrapper } from '../src/drift.js';

// Mock DriftWrapper — records calls without touching Drift
function createMockDrift() {
  const calls: { method: string; args: any[] }[] = [];
  return {
    calls,
    openPosition: vi.fn(async (...args: any[]) => {
      calls.push({ method: 'openPosition', args });
    }),
    closePosition: vi.fn(async (...args: any[]) => {
      calls.push({ method: 'closePosition', args });
    }),
    disconnect: vi.fn(async () => {}),
  } as unknown as DriftWrapper & { calls: typeof calls };
}

const MED_60S_CONFIG = {
  name: 'test-med-60s',
  subAccountId: 0,
  threshold: 0.3,
  window: 60,
  holdSeconds: 60,
  leverage: 1.5,
  betSizeSol: 0.2,
};

function solTick(price: number, time: number) {
  return { feedId: SOL_FEED_ID, price, publishTime: time };
}

function otherTick(price: number, time: number) {
  return { feedId: 'other-feed-id', price, publishTime: time };
}

describe('Strategy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('tick routing', () => {
    it('updates lastSolPrice on SOL ticks', () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      strat.onTick(solTick(150.0, 1000));
      expect(strat.lastSolPrice).toBe(150.0);

      strat.onTick(solTick(151.5, 1001));
      expect(strat.lastSolPrice).toBe(151.5);
    });

    it('does not update lastSolPrice on non-SOL ticks', () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      strat.onTick(solTick(150.0, 1000));
      strat.onTick(otherTick(100_000, 1001));
      expect(strat.lastSolPrice).toBe(150.0);
    });
  });

  describe('signal → position lifecycle', () => {
    it('opens position on SOL pump signal', async () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      // SOL baseline
      strat.onTick(solTick(150.0, 1000));
      // SOL pump +0.35% → triggers signal, entry at this price
      strat.onTick(solTick(150.525, 1030));

      // Let the async openPosition resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(strat.inPosition).toBe(true);
      expect(strat.entryPrice).toBe(150.525);
      expect(strat.entryDirection).toBe('long');
      expect(drift.openPosition).toHaveBeenCalledWith(0, 'long', 0.2);
    });

    it('opens short position on SOL dump signal', async () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      strat.onTick(solTick(150.0, 1000));
      // SOL dump -0.4%
      strat.onTick(solTick(149.4, 1030));

      await vi.advanceTimersByTimeAsync(0);

      expect(strat.inPosition).toBe(true);
      expect(strat.entryDirection).toBe('short');
      expect(drift.openPosition).toHaveBeenCalledWith(0, 'short', 0.2);
    });

    it('closes position after holdSeconds', async () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      strat.onTick(solTick(150.0, 1000));
      strat.onTick(solTick(150.525, 1030));

      await vi.advanceTimersByTimeAsync(0);
      expect(strat.inPosition).toBe(true);

      // Advance 60 seconds (hold period)
      await vi.advanceTimersByTimeAsync(60_000);

      expect(strat.inPosition).toBe(false);
      expect(drift.closePosition).toHaveBeenCalledWith(0);
      expect(strat.tradeCount).toBe(1);
    });

    it('skips signal while already in position', async () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      strat.onTick(solTick(150.0, 1000));
      // First signal
      strat.onTick(solTick(150.525, 1030));
      await vi.advanceTimersByTimeAsync(0);
      expect(strat.inPosition).toBe(true);

      // Second signal while in position — should be skipped
      strat.onTick(solTick(150.0, 1035));
      strat.onTick(solTick(150.75, 1050));
      await vi.advanceTimersByTimeAsync(0);

      // openPosition should only have been called once
      expect(drift.openPosition).toHaveBeenCalledTimes(1);
    });

    it('can open new position after previous one closes', async () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      // First trade
      strat.onTick(solTick(150.0, 1000));
      strat.onTick(solTick(150.525, 1030));
      await vi.advanceTimersByTimeAsync(0);

      // Close after hold
      await vi.advanceTimersByTimeAsync(60_000);
      expect(strat.inPosition).toBe(false);

      // Second trade (after cooldown)
      strat.onTick(solTick(150.0, 1095));
      strat.onTick(solTick(150.6, 1100));
      await vi.advanceTimersByTimeAsync(0);

      expect(strat.inPosition).toBe(true);
      expect(drift.openPosition).toHaveBeenCalledTimes(2);
    });

    it('resets inPosition if openPosition throws', async () => {
      const drift = createMockDrift();
      (drift.openPosition as any).mockRejectedValueOnce(new Error('insufficient margin'));

      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      strat.onTick(solTick(150.0, 1000));
      strat.onTick(solTick(150.525, 1030));

      await vi.advanceTimersByTimeAsync(0);

      // Should have recovered from error
      expect(strat.inPosition).toBe(false);
    });
  });

  describe('P&L calculation', () => {
    it('calculates profit on long trade (SOL goes up)', async () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      // Entry: SOL at $100 baseline, then pump to trigger signal
      strat.onTick(solTick(100.0, 1000));
      strat.onTick(solTick(100.35, 1030));
      await vi.advanceTimersByTimeAsync(0);

      // Exit: SOL at $101 (+1% from entry)
      strat.onTick(solTick(101.0, 1060));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(strat.tradeCount).toBe(1);
      expect(strat.cumulativePnlSol).toBeGreaterThan(0);
      expect(strat.cumulativeFeesSol).toBeGreaterThan(0);
    });

    it('calculates loss on long trade (SOL goes down)', async () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      // Entry: SOL pump signal
      strat.onTick(solTick(100.0, 1000));
      strat.onTick(solTick(100.35, 1030));
      await vi.advanceTimersByTimeAsync(0);

      // Exit: SOL at $99 (down from entry)
      strat.onTick(solTick(99.0, 1060));
      await vi.advanceTimersByTimeAsync(60_000);

      // Gross PnL: negative (went long but SOL fell)
      expect(strat.cumulativePnlSol).toBeLessThan(0);
    });

    it('calculates profit on short trade (SOL goes down)', async () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      // Entry: SOL dump signal → short
      strat.onTick(solTick(100.0, 1000));
      strat.onTick(solTick(99.6, 1030));
      await vi.advanceTimersByTimeAsync(0);
      expect(strat.entryDirection).toBe('short');

      // Exit: SOL at $99 — good for short
      strat.onTick(solTick(99.0, 1060));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(strat.cumulativePnlSol).toBeGreaterThan(0);
    });

    it('calculates loss on short trade (SOL goes up)', async () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      strat.onTick(solTick(100.0, 1000));
      strat.onTick(solTick(99.6, 1030));
      await vi.advanceTimersByTimeAsync(0);

      // SOL goes up — bad for short
      strat.onTick(solTick(101.0, 1060));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(strat.cumulativePnlSol).toBeLessThan(0);
    });

    it('accumulates P&L across multiple trades', async () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      // Trade 1: long, SOL pump then rises
      strat.onTick(solTick(100.0, 1000));
      strat.onTick(solTick(100.35, 1030));
      await vi.advanceTimersByTimeAsync(0);
      strat.onTick(solTick(101.0, 1060));
      await vi.advanceTimersByTimeAsync(60_000);

      const afterTrade1 = strat.cumulativePnlSol;
      expect(strat.tradeCount).toBe(1);

      // Trade 2: long, SOL pump then rises more
      strat.onTick(solTick(101.0, 1095));
      strat.onTick(solTick(101.4, 1100));
      await vi.advanceTimersByTimeAsync(0);
      strat.onTick(solTick(102.0, 1160));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(strat.tradeCount).toBe(2);
      expect(strat.cumulativePnlSol).toBeGreaterThan(afterTrade1);
    });

    it('fees are always positive and deducted from PnL', async () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      strat.onTick(solTick(100.0, 1000));
      strat.onTick(solTick(100.35, 1030));
      await vi.advanceTimersByTimeAsync(0);

      // SOL roughly flat at exit — just fees
      strat.onTick(solTick(100.35, 1060));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(strat.cumulativeFeesSol).toBeGreaterThan(0);
      // With roughly zero price movement, net PnL should be negative (just fees)
      expect(strat.cumulativePnlSol).toBeLessThan(0);
    });
  });

  describe('stop()', () => {
    it('cancels pending hold timer', async () => {
      const drift = createMockDrift();
      const strat = new Strategy(MED_60S_CONFIG, drift, true);

      strat.onTick(solTick(150.0, 1000));
      strat.onTick(solTick(150.525, 1030));
      await vi.advanceTimersByTimeAsync(0);
      expect(strat.inPosition).toBe(true);

      strat.stop();

      // Advance past hold period — closePosition should NOT be called
      await vi.advanceTimersByTimeAsync(60_000);
      expect(drift.closePosition).not.toHaveBeenCalled();
    });
  });
});
