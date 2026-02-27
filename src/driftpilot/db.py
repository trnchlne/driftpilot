"""SQLite schema, CRUD operations, and fetch progress tracking."""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

from .config import BATCH_INSERT_SIZE
from .models import Event, PriceTick


_write_lock = asyncio.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS price_ticks (
    feed_id    TEXT    NOT NULL,
    price      REAL    NOT NULL,
    conf       REAL    NOT NULL,
    ema_price  REAL    NOT NULL,
    expo       INTEGER NOT NULL,
    publish_time INTEGER NOT NULL,
    slot       INTEGER NOT NULL,
    raw_price  INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    UNIQUE(feed_id, publish_time)
);

CREATE INDEX IF NOT EXISTS idx_ticks_feed_time
    ON price_ticks(feed_id, publish_time);

CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_id         TEXT    NOT NULL,
    direction       TEXT    NOT NULL,
    start_time      INTEGER NOT NULL,
    end_time        INTEGER NOT NULL,
    start_price     REAL    NOT NULL,
    end_price       REAL    NOT NULL,
    pct_change      REAL    NOT NULL,
    window_seconds  INTEGER NOT NULL,
    threshold       REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS fetch_progress (
    feed_id         TEXT PRIMARY KEY,
    last_fetched_ts INTEGER NOT NULL
);
"""


def get_connection(db_path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db(db_path: str | Path) -> sqlite3.Connection:
    conn = get_connection(db_path)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def bulk_insert_ticks(conn: sqlite3.Connection, ticks: list[PriceTick]) -> int:
    if not ticks:
        return 0
    sql = """
        INSERT OR IGNORE INTO price_ticks
        (feed_id, price, conf, ema_price, expo, publish_time, slot, raw_price, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    rows = [
        (t.feed_id, t.price, t.conf, t.ema_price, t.expo,
         t.publish_time, t.slot, t.raw_price, t.fetched_at)
        for t in ticks
    ]
    inserted = 0
    for i in range(0, len(rows), BATCH_INSERT_SIZE):
        batch = rows[i:i + BATCH_INSERT_SIZE]
        cursor = conn.executemany(sql, batch)
        inserted += cursor.rowcount
    conn.commit()
    return inserted


async def async_bulk_insert_ticks(conn: sqlite3.Connection, ticks: list[PriceTick]) -> int:
    async with _write_lock:
        return await asyncio.to_thread(bulk_insert_ticks, conn, ticks)


def get_fetch_progress(conn: sqlite3.Connection, feed_id: str) -> int | None:
    row = conn.execute(
        "SELECT last_fetched_ts FROM fetch_progress WHERE feed_id = ?",
        (feed_id,),
    ).fetchone()
    return row[0] if row else None


def update_fetch_progress(conn: sqlite3.Connection, feed_id: str, ts: int) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO fetch_progress (feed_id, last_fetched_ts) VALUES (?, ?)",
        (feed_id, ts),
    )
    conn.commit()


async def async_update_fetch_progress(conn: sqlite3.Connection, feed_id: str, ts: int) -> None:
    async with _write_lock:
        await asyncio.to_thread(update_fetch_progress, conn, feed_id, ts)


def get_tick_count(conn: sqlite3.Connection, feed_id: str | None = None) -> int:
    if feed_id:
        row = conn.execute(
            "SELECT COUNT(*) FROM price_ticks WHERE feed_id = ?", (feed_id,)
        ).fetchone()
    else:
        row = conn.execute("SELECT COUNT(*) FROM price_ticks").fetchone()
    return row[0]


def get_time_range(conn: sqlite3.Connection) -> tuple[int | None, int | None]:
    row = conn.execute(
        "SELECT MIN(publish_time), MAX(publish_time) FROM price_ticks"
    ).fetchone()
    return (row[0], row[1]) if row[0] is not None else (None, None)


def load_ticks_as_rows(
    conn: sqlite3.Connection,
    feed_id: str,
    start_time: int | None = None,
    end_time: int | None = None,
) -> list[tuple]:
    sql = "SELECT publish_time, price, conf FROM price_ticks WHERE feed_id = ?"
    params: list = [feed_id]
    if start_time is not None:
        sql += " AND publish_time >= ?"
        params.append(start_time)
    if end_time is not None:
        sql += " AND publish_time <= ?"
        params.append(end_time)
    sql += " ORDER BY publish_time"
    return conn.execute(sql, params).fetchall()


def insert_events(conn: sqlite3.Connection, events: list[Event]) -> None:
    if not events:
        return
    conn.execute("DELETE FROM events")
    sql = """
        INSERT INTO events
        (feed_id, direction, start_time, end_time, start_price, end_price,
         pct_change, window_seconds, threshold)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    rows = [
        (e.feed_id, e.direction, e.start_time, e.end_time,
         e.start_price, e.end_price, e.pct_change, e.window_seconds, e.threshold)
        for e in events
    ]
    conn.executemany(sql, rows)
    conn.commit()


def load_events(conn: sqlite3.Connection, feed_id: str | None = None) -> list[Event]:
    sql = "SELECT feed_id, direction, start_time, end_time, start_price, end_price, pct_change, window_seconds, threshold FROM events"
    params: list = []
    if feed_id:
        sql += " WHERE feed_id = ?"
        params.append(feed_id)
    sql += " ORDER BY start_time"
    rows = conn.execute(sql, params).fetchall()
    return [Event(*r) for r in rows]
