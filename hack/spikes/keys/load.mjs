// A function called without pause by CALLERS callers for SECONDS, by one of three paths, each as FF's callers make
// the call: MODE=ff, through FF's API (API, FUNCTION), as a program calls a function; MODE=proxy, through the cluster
// API's service proxy (API, TOKEN_FILE, CA_FILE, NS, SERVICE), as the backend calls in development; MODE=direct,
// straight to the function's Service (TARGET), as the backend calls in production: on Node.js's default agent, which
// keeps connections alive, a refused connection tried again for 5 s, 100 ms later and twice that each time up to a
// second, as the backend tries it. One JSON line per call: when it started (the epoch's ms: a pod's clock is the
// node's), how long it took, its status or its error, the VALUE and the pod that answered, and the connections
// refused before it.
//   MODE=direct TARGET=http://fn-<id>.<ns>.svc:8080/invoke CALLERS=4 SECONDS=30 node load.mjs
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const { MODE, API, FUNCTION, TOKEN_FILE, CA_FILE, NS, SERVICE, TARGET, CALLERS = '4', SECONDS = '30' } = process.env;
const REFUSED_RETRY_MS = 5000;

const target = {
  ff: () => ({ url: `${API}/functions/${FUNCTION}/invoke`, body: '{"input":{}}', options: {} }),
  proxy: () => ({
    url: `${API}/api/v1/namespaces/${NS}/services/${SERVICE}:http/proxy/invoke`,
    body: '{}',
    options: {
      agent: new https.Agent({ ca: readFileSync(CA_FILE), keepAlive: true }),
      headers: { authorization: `Bearer ${readFileSync(TOKEN_FILE, 'utf8').trim()}` },
    },
  }),
  direct: () => ({ url: TARGET, body: '{}', options: {} }),
}[MODE]();

function post() {
  return new Promise((resolve, reject) => {
    const { url, body, options } = target;
    const request = (url.startsWith('https:') ? https : http).request(url, {
      method: 'POST',
      ...options,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...options.headers },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => (text += chunk));
      response.on('end', () => resolve({ status: response.statusCode, text }));
      response.on('error', reject);
    });
    request.setTimeout(10_000, () => request.destroy(new Error('no answer within 10 s')));
    request.on('error', reject);
    request.end(body);
  });
}

// The backend's rule in production: a connection refused never reached the function, so it is tried again.
async function call() {
  let refused = 0;
  const deadline = Date.now() + REFUSED_RETRY_MS;
  for (let wait = 100; ; wait = Math.min(2 * wait, 1000)) {
    try {
      return { ...(await post()), refused };
    } catch (error) {
      if (MODE !== 'direct' || error.code !== 'ECONNREFUSED' || Date.now() + wait > deadline) {
        error.refused = refused;
        throw error;
      }
      refused += 1;
      await sleep(wait);
    }
  }
}

// FF's API answers with the call's record, its output inside; the runtime with the output itself.
function answerOf(text) {
  const parsed = JSON.parse(text);
  const output = MODE === 'ff' ? parsed.output : parsed;
  return { value: output?.value, pod: output?.pod, ...(MODE === 'ff' && parsed.status !== 'COMPLETED' ? { record: parsed.status } : {}) };
}

const end = Date.now() + Number(SECONDS) * 1000;
async function caller() {
  while (Date.now() < end) {
    const t = Date.now();
    const line = { t };
    try {
      const { status, text, refused } = await call();
      Object.assign(line, { ms: Date.now() - t, status, refused });
      if (status < 300) Object.assign(line, answerOf(text));
      else line.body = text.slice(0, 200);
    } catch (error) {
      Object.assign(line, { ms: Date.now() - t, error: `${error.code ?? ''} ${error.message}`.trim(), refused: error.refused });
    }
    console.log(JSON.stringify(line));
  }
}
await Promise.all(Array.from({ length: Number(CALLERS) }, caller));
