"""SSE live streaming via Hermes for real-time BTC→SOL detection."""

from __future__ import annotations

import asyncio
import json
import sys
import time
from collections import deque

import httpx
from httpx_sse import aconnect_sse

from . import config
from .models import PriceTick
from .utils import format_pct, format_price, pyth_price_to_float, ts_to_short


class LiveDetector:
    def __init__(
        self,
        btc_threshold: float = config.DEFAULT_BTC_THRESHOLD,
        sol_threshold: float = config.DEFAULT_SOL_THRESHOLD,
        window: int = config.DEFAULT_WINDOW_SECONDS,
        max_lag: int = config.DEFAULT_MAX_LAG_SECONDS,
    ):
        self.btc_threshold = btc_threshold
        self.sol_threshold = sol_threshold
        self.window = window
        self.max_lag = max_lag

        # Rolling deques: (publish_time, price)
        self._btc_prices: deque[tuple[int, float]] = deque(maxlen=max_lag + window + 60)
        self._sol_prices: deque[tuple[int, float]] = deque(maxlen=max_lag + window + 60)

        # Track pending BTC events waiting for SOL follow
        self._pending_btc: list[dict] = []
        self._last_btc_event_time = 0

    def on_tick(self, tick: PriceTick) -> None:
        if tick.feed_id == config.BTC_USD_FEED_STRIPPED:
            self._btc_prices.append((tick.publish_time, tick.price))
            self._check_btc_event(tick)
        elif tick.feed_id == config.SOL_USD_FEED_STRIPPED:
            self._sol_prices.append((tick.publish_time, tick.price))
            self._check_sol_follow(tick)

    def _check_btc_event(self, tick: PriceTick) -> None:
        if len(self._btc_prices) < 2:
            return

        now = tick.publish_time
        # Find price from `window` seconds ago
        target_time = now - self.window
        old_price = None
        for ts, price in self._btc_prices:
            if ts <= target_time:
                old_price = price
            else:
                break

        if old_price is None or old_price == 0:
            return

        pct = (tick.price / old_price - 1) * 100

        if abs(pct) >= self.btc_threshold and (now - self._last_btc_event_time) >= config.MIN_EVENT_GAP_SECONDS:
            direction = "PUMP" if pct > 0 else "DUMP"
            self._last_btc_event_time = now

            sys.stdout.write(
                f"\n[{ts_to_short(now)}] BTC {direction} {format_pct(pct)} "
                f"({format_price(old_price)}→{format_price(tick.price)}) over {self.window}s\n"
                f"  → Watching SOL for follow...\n"
            )
            sys.stdout.flush()

            self._pending_btc.append({
                "time": now,
                "direction": direction,
                "pct": pct,
                "price": tick.price,
                "deadline": now + self.max_lag,
            })

    def _check_sol_follow(self, tick: PriceTick) -> None:
        if not self._pending_btc or len(self._sol_prices) < 2:
            return

        now = tick.publish_time
        resolved = []

        for i, btc_ev in enumerate(self._pending_btc):
            # Find SOL price at time of BTC event
            sol_base = None
            for ts, price in self._sol_prices:
                if ts <= btc_ev["time"]:
                    sol_base = price
                else:
                    break

            if sol_base is None or sol_base == 0:
                if now > btc_ev["deadline"]:
                    sys.stdout.write(
                        f"[{ts_to_short(now)}] SOL MISSED — no base price available\n"
                    )
                    sys.stdout.flush()
                    resolved.append(i)
                continue

            sol_pct = (tick.price / sol_base - 1) * 100
            is_follow = (
                (btc_ev["direction"] == "PUMP" and sol_pct >= self.sol_threshold) or
                (btc_ev["direction"] == "DUMP" and sol_pct <= -self.sol_threshold)
            )

            if is_follow:
                lag = now - btc_ev["time"]
                sys.stdout.write(
                    f"[{ts_to_short(now)}] SOL FOLLOWED {format_pct(sol_pct)} "
                    f"({format_price(sol_base)}→{format_price(tick.price)}) lag={lag}s\n"
                )
                sys.stdout.flush()
                resolved.append(i)
            elif now > btc_ev["deadline"]:
                sys.stdout.write(
                    f"[{ts_to_short(now)}] SOL MISSED — no follow within {self.max_lag}s "
                    f"(best: {format_pct(sol_pct)})\n"
                )
                sys.stdout.flush()
                resolved.append(i)

        for i in sorted(resolved, reverse=True):
            self._pending_btc.pop(i)


def _parse_sse_tick(data: dict) -> list[PriceTick]:
    ticks: list[PriceTick] = []
    parsed = data.get("parsed", [])
    for entry in parsed:
        feed_id = entry.get("id", "")
        price_data = entry.get("price", {})
        ema_data = entry.get("ema_price", {})

        raw_price = int(price_data.get("price", "0"))
        expo = int(price_data.get("expo", "0"))
        conf = int(price_data.get("conf", "0"))
        ema_raw = int(ema_data.get("price", "0"))

        ticks.append(PriceTick(
            feed_id=feed_id,
            price=pyth_price_to_float(raw_price, expo),
            conf=pyth_price_to_float(conf, expo),
            ema_price=pyth_price_to_float(ema_raw, expo),
            expo=expo,
            publish_time=int(entry.get("metadata", {}).get("publish_time", time.time())),
            slot=int(entry.get("metadata", {}).get("slot", 0)),
            raw_price=raw_price,
            fetched_at=int(time.time()),
        ))
    return ticks


async def run_live(
    btc_threshold: float = config.DEFAULT_BTC_THRESHOLD,
    sol_threshold: float = config.DEFAULT_SOL_THRESHOLD,
    window: int = config.DEFAULT_WINDOW_SECONDS,
    max_lag: int = config.DEFAULT_MAX_LAG_SECONDS,
) -> None:
    detector = LiveDetector(btc_threshold, sol_threshold, window, max_lag)

    ids_params = "&".join(f"ids[]={fid}" for fid in config.FEED_IDS)
    url = f"{config.HERMES_SSE_URL}?{ids_params}&parsed=true"

    consecutive_failures = 0
    max_failures = 5

    print(f"Connecting to Hermes SSE stream...")
    print(f"BTC threshold: {format_pct(btc_threshold)} | SOL threshold: {format_pct(sol_threshold)}")
    print(f"Window: {window}s | Max lag: {max_lag}s")
    print(f"Press Ctrl+C to stop.\n")

    while consecutive_failures < max_failures:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None)) as client:
                async with aconnect_sse(client, "GET", url) as event_source:
                    consecutive_failures = 0
                    async for sse in event_source.aiter_sse():
                        if sse.data:
                            try:
                                data = json.loads(sse.data)
                                ticks = _parse_sse_tick(data)
                                for tick in ticks:
                                    detector.on_tick(tick)
                            except json.JSONDecodeError:
                                continue
        except KeyboardInterrupt:
            print("\nStopped.")
            return
        except (httpx.RequestError, httpx.TimeoutException) as exc:
            consecutive_failures += 1
            wait = min(2 ** consecutive_failures, 30)
            sys.stderr.write(
                f"\nConnection error ({consecutive_failures}/{max_failures}): {exc}\n"
                f"Reconnecting in {wait}s...\n"
            )
            await asyncio.sleep(wait)
        except Exception as exc:
            consecutive_failures += 1
            wait = min(2 ** consecutive_failures, 30)
            sys.stderr.write(
                f"\nUnexpected error ({consecutive_failures}/{max_failures}): {exc}\n"
                f"Reconnecting in {wait}s...\n"
            )
            await asyncio.sleep(wait)

    sys.stderr.write(f"\nMax consecutive failures ({max_failures}) reached. Aborting.\n")
