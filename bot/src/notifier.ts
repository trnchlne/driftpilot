/**
 * Push notifications via ntfy.sh for trade opens and closes.
 *
 * Set NTFY_TOPIC in .env to enable (e.g. NTFY_TOPIC=driftpilot-secret-xyz).
 * Install the ntfy app on Android and subscribe to the same topic.
 * If NTFY_TOPIC is not set, notifications are silently disabled.
 */

import { dashboardBus } from './dashboard-bus.js';
import type { EntryEvent, TradeEvent } from './dashboard-bus.js';

const NTFY_URL = 'https://ntfy.sh';

function send(topic: string, title: string, message: string, tags: string): void {
  fetch(`${NTFY_URL}/${topic}`, {
    method: 'POST',
    headers: {
      Title: title,
      Tags: tags,
    },
    body: message,
  }).catch((err) => {
    console.error('[notifier] ntfy send failed:', err instanceof Error ? err.message : err);
  });
}

export function startNotifier(): void {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;

  console.log(`[notifier] ntfy.sh enabled — topic: ${topic}`);

  dashboardBus.on('entry', (event: EntryEvent) => {
    const dir = event.direction.toUpperCase();
    const title = `${event.strategyName}: ${dir} opened`;
    const message = `${dir} @ $${event.price.toFixed(2)} | size ${event.size.toFixed(2)} SOL`;
    const tags = event.direction === 'long' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend';
    send(topic, title, message, tags);
  });

  dashboardBus.on('trade', (event: TradeEvent) => {
    const dir = event.direction.toUpperCase();
    const pnlSign = event.pnl >= 0 ? '+' : '';
    const pnlPct = event.entry > 0
      ? ((event.exit - event.entry) / event.entry * (event.direction === 'long' ? 100 : -100))
      : 0;
    const title = `${event.strategyName}: ${dir} closed`;
    const message =
      `${dir} $${event.entry.toFixed(2)}→$${event.exit.toFixed(2)} ` +
      `${pnlSign}${pnlPct.toFixed(2)}% | ${pnlSign}${event.pnl.toFixed(4)} SOL | ${event.reason}`;
    const tags = event.pnl >= 0 ? 'white_check_mark' : 'x';
    send(topic, title, message, tags);
  });
}
