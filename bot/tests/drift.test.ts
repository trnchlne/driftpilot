import { describe, it, expect } from 'vitest';

describe('DriftWrapper mutex', () => {
  // Test the mutex pattern in isolation (no real Drift SDK needed)
  it('serializes concurrent operations', async () => {
    const order: number[] = [];
    let mutexPromise: Promise<void> = Promise.resolve();

    async function withMutex(id: number, work: () => Promise<void>) {
      const prev = mutexPromise;
      let resolve: () => void;
      mutexPromise = new Promise<void>((r) => (resolve = r));
      await prev;
      try {
        order.push(id);
        await work();
      } finally {
        resolve!();
      }
    }

    // Launch 3 concurrent operations
    const p1 = withMutex(1, () => new Promise((r) => setTimeout(r, 10)));
    const p2 = withMutex(2, () => new Promise((r) => setTimeout(r, 10)));
    const p3 = withMutex(3, () => new Promise((r) => setTimeout(r, 10)));

    await Promise.all([p1, p2, p3]);

    // They should execute in order despite being launched concurrently
    expect(order).toEqual([1, 2, 3]);
  });

  it('releases mutex even if operation throws', async () => {
    const order: number[] = [];
    let mutexPromise: Promise<void> = Promise.resolve();

    async function withMutex(id: number, work: () => Promise<void>) {
      const prev = mutexPromise;
      let resolve: () => void;
      mutexPromise = new Promise<void>((r) => (resolve = r));
      await prev;
      try {
        order.push(id);
        await work();
      } finally {
        resolve!();
      }
    }

    const p1 = withMutex(1, () => Promise.reject(new Error('fail'))).catch(() => {});
    const p2 = withMutex(2, () => Promise.resolve());

    await Promise.all([p1, p2]);

    // Op 2 should still run even though op 1 threw
    expect(order).toEqual([1, 2]);
  });
});

describe('position sizing', () => {
  it('converts SOL amount to base units correctly', () => {
    // Drift uses 1e9 precision for SOL
    const solAmount = 0.2;
    const baseUnits = Math.round(solAmount * 1e9);
    expect(baseUnits).toBe(200_000_000);
  });

  it('handles fractional SOL amounts', () => {
    const solAmount = 0.15;
    const baseUnits = Math.round(solAmount * 1e9);
    expect(baseUnits).toBe(150_000_000);
  });

  it('handles very small bets', () => {
    const solAmount = 0.01;
    const baseUnits = Math.round(solAmount * 1e9);
    expect(baseUnits).toBe(10_000_000);
  });
});
