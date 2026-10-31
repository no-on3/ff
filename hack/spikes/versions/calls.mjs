// Calls through the cluster API's service proxy, as FF's backend makes them: each to the version's Service with the
// probability WEIGHT, else to LATEST's, as an alias with a second version's share routes them; what answered each
// (the version its runtime reports) counted, and the calls' times. One JSON line at the end.
//   API=https://127.0.0.1:<port> TOKEN_FILE=… CA_FILE=… NS=… LATEST=<service> [VERSION=<service> WEIGHT=0.1] N=1000 node calls.mjs
import https from 'node:https';
import { readFileSync } from 'node:fs';

const { API, TOKEN_FILE, CA_FILE, NS, LATEST, VERSION = '', WEIGHT = '0', N = '100' } = process.env;
const token = readFileSync(TOKEN_FILE, 'utf8').trim();
const agent = new https.Agent({ ca: readFileSync(CA_FILE), keepAlive: true });

function call(service) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const request = https.request(`${API}/api/v1/namespaces/${NS}/services/${service}:http/proxy/invoke`, {
      method: 'POST', agent, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, body, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    });
    request.on('error', reject);
    request.end('{}');
  });
}

// The first "version" in the answer, wherever the runtime's envelope puts the function's own output.
function versionIn(value) {
  if (value && typeof value === 'object') {
    if (typeof value.version === 'string') return value.version;
    for (const inner of Object.values(value)) {
      const found = versionIn(typeof inner === 'string' && inner.startsWith('{') ? JSON.parse(inner) : inner);
      if (found) return found;
    }
  }
  return undefined;
}

const routed = {};
const answered = {};
const times = [];
let failed = 0;
for (let i = 0; i < Number(N); i += 1) {
  const service = VERSION && Math.random() < Number(WEIGHT) ? VERSION : LATEST;
  routed[service] = (routed[service] ?? 0) + 1;
  const { status, body, ms } = await call(service);
  times.push(ms);
  if (status !== 200) {
    failed += 1;
    continue;
  }
  const version = versionIn(JSON.parse(body)) ?? 'none';
  const key = `${service} -> ${version}`;
  answered[key] = (answered[key] ?? 0) + 1;
}
times.sort((a, b) => a - b);
const at = (p) => Math.round(times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))] * 10) / 10;
console.log(JSON.stringify({ calls: Number(N), weight: Number(WEIGHT), routed, answered, failed, p50: at(50), p95: at(95), max: at(100) }));
