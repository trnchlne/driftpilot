import { PriceFeed } from './feed.js';
import { createWriteStream } from 'fs';
import { resolve } from 'path';

function parseDuration(s: string): number {
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h)$/i);
  if (!match) throw new Error(`Invalid duration: ${s}. Use e.g. 30m, 4h, 3600s`);
  const val = parseFloat(match[1]);
  switch (match[2].toLowerCase()) {
    case 's': return val * 1000;
    case 'm': return val * 60 * 1000;
    case 'h': return val * 3600 * 1000;
    default: throw new Error(`Unknown unit: ${match[2]}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);

  let duration = 4 * 3600 * 1000; // default 4h
  let output = 'data/recorded-ticks.jsonl';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--duration' && args[i + 1]) {
      duration = parseDuration(args[i + 1]);
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[i + 1];
      i++;
    }
  }

  const outPath = resolve(output);
  const ws = createWriteStream(outPath, { flags: 'a' });

  console.log(`[record] Recording ticks to ${outPath}`);
  console.log(`[record] Duration: ${(duration / 3600000).toFixed(1)}h`);
  console.log(`[record] Press Ctrl+C to stop early`);

  let tickCount = 0;
  const startTime = Date.now();

  const feed = new PriceFeed();
  feed.onTick((tick) => {
    const line = JSON.stringify({ feedId: tick.feedId, price: tick.price, publishTime: tick.publishTime });
    ws.write(line + '\n');
    tickCount++;
    if (tickCount % 1000 === 0) {
      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      console.log(`[record] ${tickCount} ticks recorded (${elapsed}min elapsed)`);
    }
  });

  feed.start();

  const shutdown = () => {
    console.log(`\n[record] Stopping...`);
    feed.stop();
    ws.end(() => {
      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      console.log(`[record] Done: ${tickCount} ticks in ${elapsed}min → ${outPath}`);
      process.exit(0);
    });
  };

  // Auto-stop after duration
  setTimeout(shutdown, duration);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
