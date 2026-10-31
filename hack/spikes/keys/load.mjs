// A function called without pause by CALLERS callers for SECONDS, by one of three paths, each as FF's callers make
// the call: MODE=ff, through FF's API (API, FUNCTION), as a program calls a function; MODE=proxy, through the cluster
// API's service proxy (API, TOKEN_FILE, CA_FILE, NS, SERVICE), as the backend calls in development; MODE=direct,
// straight to the function's Service (TARGET), as the backend calls in production, on connections kept alive and
// closed after 5 s unused, as the backend's. By the proxy and directly, a call the function never got is tried again
// as the backend tries it (post() in kubernetes.orchestrator.ts): for 5 s from the first refusal, 100 ms later and
// twice that each time up to a second, on a connection of its own directly; a connection refused (directly), or an
// answer that says the call never ran, as an instance that stops gives. One JSON line per call: when it started (the
// epoch's ms: a pod's clock is the node's), how long it took, its status or its error (and whether it came on a
// connection kept alive), the VALUE and the pod that answered, and the refusals before it, of each kind.
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
  direct: () => ({ url: TARGET, body: '{}', options: { agent: new http.Agent({ keepAlive: true, timeout: 5000 }) } }),
}[MODE]();

/** One attempt; `again` on a connection of its own, directly. */
function post(again) {
  return new Promise((resolve, reject) => {
    const { url, body, options } = target;
    const request = (url.startsWith('https:') ? https : http).request(url, {
      method: 'POST',
      ...options,
      ...(again && MODE === 'direct' ? { agent: false } : {}),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...options.headers },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => (text += chunk));
      response.on('end', () => resolve({ status: response.statusCode, text, notRun: response.headers['x-ff-not-run'] !== undefined }));
      response.on('error', reject);
    });
    request.setTimeout(10_000, () => request.destroy(new Error('no answer within 10 s')));
    request.on('error', (error) => reject(Object.assign(error, { reused: request.reusedSocket })));
    request.end(body);
  });
}

async function call() {
  const before = { refused: 0, notRun: 0 };
  let deadline;
  for (let wait = 100; ; wait = Math.min(2 * wait, 1000)) {
    let res, failure;
    try {
      res = await post(deadline !== undefined);
    } catch (error) {
      failure = error;
    }
    const kind = res
      ? MODE !== 'ff' && res.status === 503 && res.notRun && 'notRun'
      : MODE === 'direct' && failure.code === 'ECONNREFUSED' && 'refused';
    deadline ??= Date.now() + REFUSED_RETRY_MS;
    if (!kind || Date.now() + wait > deadline) {
      if (res) return { ...res, ...before };
      throw Object.assign(failure, before);
    }
    before[kind] += 1;
    await sleep(wait);
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
      const { status, text, refused, notRun } = await call();
      Object.assign(line, { ms: Date.now() - t, status, refused, notRun });
      if (status < 300) Object.assign(line, answerOf(text));
      else line.body = text.slice(0, 200);
    } catch (error) {
      const { refused, notRun, reused } = error;
      Object.assign(line, { ms: Date.now() - t, error: `${error.code ?? ''} ${error.message}`.trim(), reused, refused, notRun });
    }
    console.log(JSON.stringify(line));
  }
}
await Promise.all(Array.from({ length: Number(CALLERS) }, caller));
