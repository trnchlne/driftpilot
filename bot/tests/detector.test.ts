import { describe, it, expect } from 'vitest';
import { Detector } from '../src/detector.js';

describe('Detector', () => {
  describe('signal detection', () => {
    it('returns null on first tick (need at least 2 samples)', () => {
      const d = new Detector(0.3, 60);
      expect(d.onTick(100_000, 1000)).toBeNull();
    });

    it('returns null when price moves less than threshold', () => {
      const d = new Detector(0.3, 60);
      d.onTick(100_000, 1000);
      // +0.2% — below 0.3% threshold
      expect(d.onTick(100_200, 1030)).toBeNull();
    });

    it('fires long signal when price pumps above threshold', () => {
      const d = new Detector(0.3, 60);
      d.onTick(100_000, 1000);
      // +0.35%
      const signal = d.onTick(100_350, 1030);
      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('long');
      expect(signal!.pctChange).toBeCloseTo(0.35, 2);
    });

    it('fires short signal when price dumps below threshold', () => {
      const d = new Detector(0.3, 60);
      d.onTick(100_000, 1000);
      // -0.4%
      const signal = d.onTick(99_600, 1030);
      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('short');
      expect(signal!.pctChange).toBeCloseTo(-0.4, 2);
    });

    it('detects just above threshold', () => {
      const d = new Detector(0.3, 60);
      d.onTick(100_000, 1000);
      // +0.301% — just above 0.3% threshold (avoids FP boundary)
      const signal = d.onTick(100_301, 1030);
      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('long');
    });
  });

  describe('window pruning', () => {
    it('prunes old samples outside the window', () => {
      const d = new Detector(0.3, 60);

      // t=0: price 100k
      d.onTick(100_000, 0);
      // t=30: price 100k (no move)
      d.onTick(100_000, 30);
      // t=61: price 100k — old sample at t=0 should be pruned
      // now add a pump tick: oldest in window is t=30 at 100k
      d.onTick(100_000, 61);
      // t=62: price 100.4k — 0.4% from t=30 baseline
      const signal = d.onTick(100_400, 62);
      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('long');
    });

    it('does not fire if move happened before window', () => {
      const d = new Detector(0.3, 60);

      // t=0: big low price
      d.onTick(99_000, 0);
      // t=30: normal price
      d.onTick(100_000, 30);
      // t=61: same normal price — t=0 sample pruned, baseline is now t=30
      // no change from 100k → 100k
      const signal = d.onTick(100_000, 61);
      expect(signal).toBeNull();
    });
  });

  describe('cooldown', () => {
    it('suppresses signal within cooldown period', () => {
      const d = new Detector(0.3, 60, 30);

      d.onTick(100_000, 0);
      // First signal at t=10
      const s1 = d.onTick(100_400, 10);
      expect(s1).not.toBeNull();

      // Second signal attempt at t=20 (10s after first, within 30s cooldown)
      d.onTick(100_000, 15); // reset baseline
      const s2 = d.onTick(100_400, 20);
      expect(s2).toBeNull();
    });

    it('allows signal after cooldown expires', () => {
      const d = new Detector(0.3, 60, 30);

      d.onTick(100_000, 0);
      const s1 = d.onTick(100_400, 10);
      expect(s1).not.toBeNull();

      // Feed some baseline ticks, then signal at t=41 (31s after first)
      d.onTick(100_000, 35);
      const s2 = d.onTick(100_400, 41);
      expect(s2).not.toBeNull();
      expect(s2!.direction).toBe('long');
    });
  });

  describe('edge cases', () => {
    it('handles rapid small ticks without false triggers', () => {
      const d = new Detector(0.3, 60);
      const results: any[] = [];

      // Simulate 60 ticks of 0.01% noise
      for (let i = 0; i < 60; i++) {
        const noise = 100_000 + Math.sin(i) * 10; // tiny oscillation
        results.push(d.onTick(noise, i));
      }

      // Should have no signals (noise is way below 0.3%)
      expect(results.filter((r) => r !== null)).toHaveLength(0);
    });

    it('handles micro-15s config (low threshold, short window)', () => {
      const d = new Detector(0.15, 15);
      d.onTick(100_000, 0);
      // +0.16% in 10s
      const signal = d.onTick(100_160, 10);
      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('long');
    });

    it('handles big-180s config (high threshold, long window)', () => {
      const d = new Detector(0.5, 120);
      d.onTick(100_000, 0);
      // +0.4% — not enough
      expect(d.onTick(100_400, 60)).toBeNull();
      // +0.55% from baseline
      const signal = d.onTick(100_550, 90);
      expect(signal).not.toBeNull();
      expect(signal!.direction).toBe('long');
    });
  });
});
