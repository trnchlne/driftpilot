/**
 * File-based persistence for supplementary strategy state.
 *
 * Only stores what Drift doesn't have:
 *   - entryTickTime: needed for trail delay / timeout logic
 *   - bestPriceSinceEntry: needed for trailing stop (trend strategies)
 *
 * Entry price, direction, size are read from Drift (source of truth).
 * Atomic writes: write to .tmp → rename (prevents corruption on crash).
 */

import { writeFileSync, readFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface StrategyExtras {
  entryTickTime: number;
  bestPriceSinceEntry: number;
  entryRegime?: string;
}

export type LiveStateData = Record<string, StrategyExtras>;

const DEFAULT_PATH = join(process.cwd(), 'data', 'live-state.json');

export class LiveStateManager {
  private readonly filePath: string;
  private state: LiveStateData = {};

  constructor(filePath?: string) {
    this.filePath = filePath ?? DEFAULT_PATH;
    this.load();
  }

  /** Load state from disk (safe if file doesn't exist) */
  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        this.state = JSON.parse(raw);
      }
    } catch (err) {
      console.warn('[live-state] Failed to load state file, starting fresh:', err);
      this.state = {};
    }
  }

  /** Save entry extras for a strategy */
  set(stratName: string, extras: StrategyExtras): void {
    this.state[stratName] = extras;
    this.persist();
  }

  /** Get extras for a strategy (if any) */
  get(stratName: string): StrategyExtras | undefined {
    return this.state[stratName];
  }

  /** Clear extras for a strategy (on position close) */
  clear(stratName: string): void {
    delete this.state[stratName];
    this.persist();
  }

  /** Clear all stale entries not in the given set of active strategy names */
  clearStale(activeNames: Set<string>): void {
    let changed = false;
    for (const key of Object.keys(this.state)) {
      if (!activeNames.has(key)) {
        delete this.state[key];
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Get full state (for logging/debug) */
  getAll(): LiveStateData {
    return { ...this.state };
  }

  /** Atomic write: tmp file → rename */
  private persist(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf-8');
    renameSync(tmpPath, this.filePath);
  }
}
