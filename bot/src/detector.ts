export type Direction = 'long' | 'short';

export interface Signal {
  direction: Direction;
  pctChange: number;
}

interface PriceSample {
  time: number;
  price: number;
}

export class Detector {
  private readonly threshold: number;
  private readonly windowSeconds: number;
  private readonly minGapSeconds: number;
  private buffer: PriceSample[] = [];
  private lastSignalTime = -Infinity;

  constructor(threshold: number, windowSeconds: number, minGapSeconds = 30) {
    this.threshold = threshold;
    this.windowSeconds = windowSeconds;
    this.minGapSeconds = minGapSeconds;
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  getCurrentChange(): number | null {
    if (this.buffer.length < 2) return null;
    const oldest = this.buffer[0];
    const newest = this.buffer[this.buffer.length - 1];
    return ((newest.price / oldest.price) - 1) * 100;
  }

  onTick(price: number, time: number): Signal | null {
    this.buffer.push({ time, price });

    // Prune samples older than window
    const cutoff = time - this.windowSeconds;
    while (this.buffer.length > 0 && this.buffer[0].time < cutoff) {
      this.buffer.shift();
    }

    if (this.buffer.length < 2) return null;

    const oldest = this.buffer[0];
    const pctChange = ((price / oldest.price) - 1) * 100;

    if (Math.abs(pctChange) < this.threshold) return null;

    // Cooldown check
    if (time - this.lastSignalTime < this.minGapSeconds) return null;

    this.lastSignalTime = time;

    return {
      direction: pctChange > 0 ? 'long' : 'short',
      pctChange,
    };
  }
}
