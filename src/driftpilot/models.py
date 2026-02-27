"""Data models for price ticks, events, and analysis results."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class PriceTick:
    feed_id: str
    price: float
    conf: float
    ema_price: float
    expo: int
    publish_time: int
    slot: int
    raw_price: int
    fetched_at: int


@dataclass(frozen=True, slots=True)
class Event:
    feed_id: str
    direction: str  # "pump" or "dump"
    start_time: int
    end_time: int
    start_price: float
    end_price: float
    pct_change: float
    window_seconds: int
    threshold: float


@dataclass(frozen=True, slots=True)
class CorrelatedPair:
    btc_event: Event
    sol_response_time: int | None
    lag_seconds: float | None
    sol_pct_change: float | None
    hit: bool


@dataclass(frozen=True, slots=True)
class HitRateResult:
    total_btc_events: int
    hits: int
    misses: int
    hit_rate: float
    mean_lag: float | None
    median_lag: float | None
    p25_lag: float | None
    p75_lag: float | None
    min_lag: float | None
    max_lag: float | None
    pump_hits: int
    pump_misses: int
    dump_hits: int
    dump_misses: int
