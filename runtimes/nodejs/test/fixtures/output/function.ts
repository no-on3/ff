// Writes as a busy handler might, just before it returns: lines on stdout and on stderr and, unless told
// not to, a line left open on stdout. With `busyMs`, it leaves work running that blocks its worker after
// it returns.
interface Event {
  body: { lines?: number; errors?: number; open?: boolean; busyMs?: number };
}

export async function handler(event: Event, context: { awsRequestId: string }) {
  const id = context.awsRequestId;
  for (let i = 1; i <= (event.body.lines ?? 20); i++) console.log(`${id}: line ${i}`);
  for (let i = 1; i <= (event.body.errors ?? 1); i++) console.error(`${id}: error ${i}`);
  if (event.body.open !== false) process.stdout.write(`${id}: left open`);
  const busyMs = event.body.busyMs ?? 0;
  if (busyMs > 0) {
    setImmediate(() => {
      const until = Date.now() + busyMs;
      while (Date.now() < until);
    });
  }
  return 'ok';
}
