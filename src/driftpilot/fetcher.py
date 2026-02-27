"""Async Benchmarks API fetcher with token-bucket rate limiting."""

from __future__ import annotations

import asyncio
import sys
import time
from typing import TYPE_CHECKING

import httpx

from . import config
from .db import (
    async_bulk_insert_ticks,
    async_update_fetch_progress,
    get_fetch_progress,
)
from .models import PriceTick
from .utils import pyth_price_to_float

if TYPE_CHECKING:
    import sqlite3


class TokenBucket:
    def __init__(self, capacity: int, refill_period: float):
        self._capacity = capacity
        self._tokens = float(capacity)
        self._refill_period = refill_period
        self._refill_rate = capacity / refill_period
        self._last_refill = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_refill
            self._tokens = min(self._capacity, self._tokens + elapsed * self._refill_rate)
            self._last_refill = now

            if self._tokens < 1:
                wait = (1 - self._tokens) / self._refill_rate
                await asyncio.sleep(wait)
                self._tokens = 0
            else:
                self._tokens -= 1


class ProgressBar:
    def __init__(self, total: int):
        self.total = total
        self.done = 0
        self._start = time.monotonic()
        self._lock = asyncio.Lock()

    async def increment(self) -> None:
        async with self._lock:
            self.done += 1
            self._render()

    def _render(self) -> None:
        pct = self.done / self.total if self.total else 1
        elapsed = time.monotonic() - self._start
        if self.done > 0:
            eta = (elapsed / self.done) * (self.total - self.done)
            eta_str = f"~{int(eta // 60)}m{int(eta % 60):02d}s left"
        else:
            eta_str = "calculating..."

        bar_len = 40
        filled = int(bar_len * pct)
        bar = "=" * filled + ">" * min(1, bar_len - filled) + " " * max(0, bar_len - filled - 1)
        sys.stderr.write(f"\r[{bar}] {self.done}/{self.total} ({pct:.0%}) | {eta_str}  ")
        sys.stderr.flush()

    def finish(self) -> None:
        elapsed = time.monotonic() - self._start
        sys.stderr.write(f"\rFetched {self.done} intervals in {elapsed:.0f}s" + " " * 40 + "\n")
        sys.stderr.flush()


def _parse_response(data: list, fetched_at: int) -> list[PriceTick]:
    """Parse the Benchmarks API response.

    Response is an array of entries, each with a 'parsed' array containing
    feed data with price info (including publish_time inside the price object).
    """
    ticks: list[PriceTick] = []
    for wrapper in data:
        parsed = wrapper.get("parsed")
        if not parsed:
            continue
        for entry in parsed:
            feed_id = entry.get("id", "")
            price_data = entry.get("price", {})
            ema_data = entry.get("ema_price", {})

            raw_price = int(price_data.get("price", "0"))
            expo = int(price_data.get("expo", "0"))
            conf = int(price_data.get("conf", "0"))
            ema_raw = int(ema_data.get("price", "0"))
            publish_time = int(price_data.get("publish_time", 0))

            if publish_time == 0:
                continue

            price_float = pyth_price_to_float(raw_price, expo)
            conf_float = pyth_price_to_float(conf, expo)
            ema_float = pyth_price_to_float(ema_raw, expo)

            metadata = entry.get("metadata", {})
            slot = int(metadata.get("slot", 0))

            ticks.append(PriceTick(
                feed_id=feed_id,
                price=price_float,
                conf=conf_float,
                ema_price=ema_float,
                expo=expo,
                publish_time=publish_time,
                slot=slot,
                raw_price=raw_price,
                fetched_at=fetched_at,
            ))
    return ticks


async def _fetch_one(
    client: httpx.AsyncClient,
    bucket: TokenBucket,
    timestamp: int,
    interval: int = 60,
) -> list[PriceTick]:
    await bucket.acquire()
    ids_params = "&".join(f"ids={fid}" for fid in config.FEED_IDS)
    url = (
        f"{config.BENCHMARKS_BASE_URL}/v1/updates/price/{timestamp}/{interval}"
        f"?{ids_params}&parsed=true"
    )

    backoff = config.BACKOFF_BASE
    for attempt in range(6):
        try:
            resp = await client.get(url)
            if resp.status_code == 429:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, config.BACKOFF_MAX)
                await bucket.acquire()
                continue
            resp.raise_for_status()
            return _parse_response(resp.json(), fetched_at=int(time.time()))
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 429:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, config.BACKOFF_MAX)
                continue
            if attempt == 5:
                sys.stderr.write(f"\nFailed to fetch ts={timestamp}: {exc}\n")
                return []
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, config.BACKOFF_MAX)
        except (httpx.RequestError, httpx.TimeoutException) as exc:
            if attempt == 5:
                sys.stderr.write(f"\nNetwork error at ts={timestamp}: {exc}\n")
                return []
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, config.BACKOFF_MAX)
    return []


async def _worker(
    name: str,
    queue: asyncio.Queue[int],
    client: httpx.AsyncClient,
    bucket: TokenBucket,
    conn: sqlite3.Connection,
    progress: ProgressBar,
    buffer: list[PriceTick],
    buffer_lock: asyncio.Lock,
    requests_since_checkpoint: list[int],
) -> None:
    while True:
        try:
            timestamp = queue.get_nowait()
        except asyncio.QueueEmpty:
            return

        ticks = await _fetch_one(client, bucket, timestamp)

        async with buffer_lock:
            buffer.extend(ticks)
            requests_since_checkpoint[0] += 1

            if len(buffer) >= config.BATCH_INSERT_SIZE:
                to_insert = list(buffer)
                buffer.clear()
                await async_bulk_insert_ticks(conn, to_insert)

            if requests_since_checkpoint[0] >= config.PROGRESS_UPDATE_INTERVAL:
                for fid in config.FEED_IDS:
                    await async_update_fetch_progress(conn, fid, timestamp)
                requests_since_checkpoint[0] = 0

        await progress.increment()
        queue.task_done()


async def fetch_historical(
    conn: sqlite3.Connection,
    start_ts: int,
    end_ts: int,
) -> None:
    # Determine resume point
    resume_points = []
    for fid in config.FEED_IDS:
        last = get_fetch_progress(conn, fid)
        if last is not None:
            resume_points.append(last)

    effective_start = max(resume_points) if resume_points else start_ts

    if effective_start >= end_ts:
        sys.stderr.write("All data already fetched.\n")
        return

    if resume_points:
        sys.stderr.write(
            f"Resuming from {effective_start} (previously fetched to this point)\n"
        )

    timestamps = list(range(effective_start, end_ts, config.FETCH_INTERVAL_SECONDS))
    if not timestamps:
        sys.stderr.write("No intervals to fetch.\n")
        return

    queue: asyncio.Queue[int] = asyncio.Queue()
    for ts in timestamps:
        queue.put_nowait(ts)

    bucket = TokenBucket(config.RATE_LIMIT_TOKENS, config.RATE_LIMIT_WINDOW_SECONDS)
    progress = ProgressBar(len(timestamps))
    buffer: list[PriceTick] = []
    buffer_lock = asyncio.Lock()
    requests_since_checkpoint = [0]

    async with httpx.AsyncClient(timeout=30.0) as client:
        workers = [
            asyncio.create_task(
                _worker(
                    f"worker-{i}",
                    queue, client, bucket, conn, progress,
                    buffer, buffer_lock, requests_since_checkpoint,
                )
            )
            for i in range(config.FETCH_WORKERS)
        ]
        await asyncio.gather(*workers)

    # Flush remaining buffer
    if buffer:
        await async_bulk_insert_ticks(conn, buffer)

    # Final progress update
    for fid in config.FEED_IDS:
        await async_update_fetch_progress(conn, fid, end_ts)

    progress.finish()
