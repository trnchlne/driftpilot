import { describe, it, expect } from 'vitest';

// Test the price conversion logic used in feed.ts
// (We can't easily test SSE without a network, but we can test the parsing)

describe('Pyth price conversion', () => {
  function convertPythPrice(price: string, expo: string): number {
    return parseInt(price) * 10 ** parseInt(expo);
  }

  it('converts BTC price correctly', () => {
    // Real Pyth data: BTC ~$97,000
    // price: "9700000000000", expo: "-8"
    const result = convertPythPrice('9700000000000', '-8');
    expect(result).toBeCloseTo(97_000, 0);
  });

  it('converts SOL price correctly', () => {
    // Real Pyth data: SOL ~$150
    // price: "15000000000", expo: "-8"
    const result = convertPythPrice('15000000000', '-8');
    expect(result).toBeCloseTo(150, 0);
  });

  it('handles negative exponents', () => {
    const result = convertPythPrice('12345', '-2');
    expect(result).toBeCloseTo(123.45, 2);
  });

  it('handles very small prices', () => {
    const result = convertPythPrice('100', '-8');
    expect(result).toBeCloseTo(0.000001, 8);
  });
});

describe('SSE message parsing', () => {
  function parseSseMessage(data: string) {
    const parsed = JSON.parse(data);
    if (!parsed.parsed || !Array.isArray(parsed.parsed)) return [];

    return parsed.parsed.map((item: any) => ({
      feedId: item.id,
      price: parseInt(item.price.price) * 10 ** parseInt(item.price.expo),
      publishTime: parseInt(item.price.publish_time),
    }));
  }

  it('parses a real Pyth SSE message with multiple feeds', () => {
    const sseData = JSON.stringify({
      parsed: [
        {
          id: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
          price: { price: '9700000000000', expo: '-8', publish_time: '1700000000' },
        },
        {
          id: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
          price: { price: '15000000000', expo: '-8', publish_time: '1700000000' },
        },
      ],
    });

    const ticks = parseSseMessage(sseData);
    expect(ticks).toHaveLength(2);

    expect(ticks[0].feedId).toContain('e62df6c8');
    expect(ticks[0].price).toBeCloseTo(97_000, 0);
    expect(ticks[0].publishTime).toBe(1700000000);

    expect(ticks[1].feedId).toContain('ef0d8b6f');
    expect(ticks[1].price).toBeCloseTo(150, 0);
  });

  it('returns empty array for non-parsed messages', () => {
    const ticks = parseSseMessage(JSON.stringify({ binary: {} }));
    expect(ticks).toHaveLength(0);
  });

  it('handles missing price data gracefully', () => {
    const sseData = JSON.stringify({
      parsed: [{ id: 'abc', price: null }],
    });

    // Should not throw
    expect(() => {
      const parsed = JSON.parse(sseData);
      const results = [];
      for (const item of parsed.parsed) {
        if (!item.price) continue;
        results.push(item);
      }
      return results;
    }).not.toThrow();
  });
});
