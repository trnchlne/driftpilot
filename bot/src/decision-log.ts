/**
 * Decision Log — records every decision the bot makes and why.
 *
 * Stores entries in a circular buffer (in-memory). Served via /api/decisions.
 * Designed so that pasting the JSON into Claude gives full context
 * to explain why the bot did (or didn't do) something.
 *
 * Future: swap the buffer for a DB write (Postgres, SQLite, etc.)
 */

export type DecisionType =
  | 'regime_change'
  | 'entry'
  | 'entry_blocked'
  | 'exit'
  | 'signal_near_miss'
  | 'warmup_complete'
  | 'recovery'
  | 'state_snapshot';

export interface DecisionRecord {
  id: number;
  time: string;          // ISO 8601
  epochMs: number;       // unix ms — for filtering
  type: DecisionType;
  strategy: string;
  price: number;
  summary: string;       // one-liner: "TREND LONG entry — signal 2.1% > threshold 1.86%"
  context: Record<string, unknown>;
}

const MAX_ENTRIES = 2000;

class DecisionLog {
  private entries: DecisionRecord[] = [];
  private nextId = 1;

  log(
    type: DecisionType,
    strategy: string,
    price: number,
    summary: string,
    context: Record<string, unknown>,
  ): void {
    const now = Date.now();
    this.entries.push({
      id: this.nextId++,
      time: new Date(now).toISOString(),
      epochMs: now,
      type,
      strategy,
      price,
      summary,
      context,
    });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
  }

  getAll(): DecisionRecord[] {
    return this.entries;
  }

  getRecent(count: number): DecisionRecord[] {
    return this.entries.slice(-count);
  }

  getSince(epochMs: number): DecisionRecord[] {
    return this.entries.filter(e => e.epochMs >= epochMs);
  }

  getByStrategy(strategy: string): DecisionRecord[] {
    return this.entries.filter(e => e.strategy === strategy);
  }

  getByType(type: DecisionType): DecisionRecord[] {
    return this.entries.filter(e => e.type === type);
  }

  query(opts: {
    limit?: number;
    since?: number;
    strategy?: string;
    type?: DecisionType;
  }): DecisionRecord[] {
    let result = this.entries;

    if (opts.since) {
      result = result.filter(e => e.epochMs >= opts.since!);
    }
    if (opts.strategy) {
      result = result.filter(e => e.strategy === opts.strategy);
    }
    if (opts.type) {
      result = result.filter(e => e.type === opts.type);
    }
    if (opts.limit) {
      result = result.slice(-opts.limit);
    }

    return result;
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
    this.nextId = 1;
  }
}

export const decisionLog = new DecisionLog();
