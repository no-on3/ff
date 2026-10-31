#!/usr/bin/env node
// How long each cache took to answer after its process was started: each port tried until its user logs in, over TLS,
// for a minute at most, after which the cache that never answered is named and the spike stops.
//   HOST=… CA=… STARTED=<epoch ms> CACHES='[{"port":…,"password":…}, …]' node ready.mjs
import { open } from './resp.mjs';

const caches = JSON.parse(process.env.CACHES);
const started = Number(process.env.STARTED);
const deadline = Date.now() + 60_000;
const times = await Promise.all(
  caches.map(async (cache) => {
    while (Date.now() < deadline) {
      try {
        const connection = await open(`rediss://default:${encodeURIComponent(cache.password)}@${process.env.HOST}:${cache.port}`, process.env.CA);
        connection.end();
        if (connection.auth === 'OK') return Date.now() - started;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    console.error(`the cache on port ${cache.port} never answered over TLS`);
    process.exit(1);
  }),
);
const sorted = [...times].sort((a, b) => a - b);
console.log(JSON.stringify({ measure: 'started until it answers over TLS', caches: caches.length, firstMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)], lastMs: sorted.at(-1) }));
