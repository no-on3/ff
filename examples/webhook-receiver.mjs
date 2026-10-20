// A webhook receiver for FF's notifications, with Node.js alone: it checks each request's signature with the
// account's secret, refuses one older than five minutes, drops an event it already has, and prints the others.
//   FF_WEBHOOK_SECRET=whsec_… node examples/webhook-receiver.mjs [port]
// FF signs "<t>.<body>" with HMAC-SHA256, keyed with the secret as written, and sends
// FF-Signature: t=<Unix seconds>,v1=<hex>[,v1=<hex>]; a day after a rotation, a v1 by each secret.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const secret = process.env.FF_WEBHOOK_SECRET;
if (!secret) throw new Error('Set FF_WEBHOOK_SECRET to the account\'s secret: GET /notifications/webhook-secret');
const port = Number(process.argv[2] ?? 8090);
const TOLERANCE_S = 300;
const seen = new Set();

/** Whether the header holds a v1 of "<t>.<body>" by our secret, signed within the tolerance. */
function verified(header, body, now = Date.now()) {
  const fields = (header ?? '').split(',').map((part) => part.split('='));
  const t = Number(fields.find(([name]) => name === 't')?.[1]);
  if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  return fields.some(([name, value]) => name === 'v1' && /^[0-9a-f]{64}$/.test(value) && timingSafeEqual(Buffer.from(value, 'hex'), expected));
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    // The body exactly as it came: parsing and writing it again could change a byte, and the signature with it.
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.method !== 'POST' || !verified(req.headers['ff-signature'], body)) {
      res.writeHead(400).end('bad signature\n');
      return;
    }
    const id = req.headers['ff-event-id'];
    if (!seen.has(id)) {
      seen.add(id);
      console.log(JSON.stringify(JSON.parse(body)));
    }
    res.writeHead(204).end(); // answer within 5 seconds, or FF tries again
  });
}).listen(port, () => console.log(`Waiting for FF's webhooks on http://localhost:${port}`));
