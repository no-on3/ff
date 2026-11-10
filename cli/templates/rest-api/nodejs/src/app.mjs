// {{name}}'s API, at its function's URL: each request routed by its method and path, its items kept in PostgreSQL.
// The event is Lambda's URL event (version 2.0) and the answer a URL's response, the same on FF and on AWS Lambda.
//   GET    /items        the latest 50 items, the newest first
//   POST   /items        {"name": "…"}: the item kept, 201 with it
//   GET    /items/<id>   the item, or 404
//   DELETE /items/<id>   204, or 404
// DATABASE_URL names the database: on FF a secret (ff db create <name> --secret-for <function>), with
// ff local start --with postgres the local one, on AWS the function's environment. The browser's CORS is the URL's,
// as template.yaml sets it: this code never answers a preflight.

/** A request that can't be taken: its answer is 400 with the message. */
class Invalid extends Error {}

const ITEM = `id, name, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"`;

/** The routes: a method, a path, and what answers them, given the database and the path's ID. */
const ROUTES = [
  [
    'GET',
    /^\/items\/?$/,
    async ({ db }) => answer(200, await db.query(`SELECT ${ITEM} FROM items ORDER BY id DESC LIMIT 50`)),
  ],
  [
    'POST',
    /^\/items\/?$/,
    async ({ db, body }) => {
      const [item] = await db.query(`INSERT INTO items (name) VALUES ($1) RETURNING ${ITEM}`, [nameOf(body)]);
      return answer(201, item, { location: `/items/${item.id}` });
    },
  ],
  [
    'GET',
    /^\/items\/(\d{1,9})$/,
    async ({ db, id }) => {
      const [item] = await db.query(`SELECT ${ITEM} FROM items WHERE id = $1`, [id]);
      return item ? answer(200, item) : notFound(id);
    },
  ],
  [
    'DELETE',
    /^\/items\/(\d{1,9})$/,
    async ({ db, id }) => {
      const deleted = await db.query('DELETE FROM items WHERE id = $1 RETURNING id', [id]);
      return deleted.length ? answer(204) : notFound(id);
    },
  ],
];

export async function handler(event) {
  return route(event, database);
}

/** The request's answer, the database given by `connect` when its route needs it: the tests give their own. */
export async function route(event, connect) {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const paths = ROUTES.filter(([, pattern]) => pattern.test(path));
  if (paths.length === 0) return answer(404, { message: `No route for ${path}` });
  const found = paths.find(([verb]) => verb === method);
  if (!found) {
    const allowed = paths.map(([verb]) => verb).join(', ');
    return answer(405, { message: `${path} takes ${allowed}, not ${method}` }, { allow: allowed });
  }
  const [, pattern, run] = found;
  const id = path.match(pattern)[1];
  try {
    const body = method === 'POST' ? bodyOf(event) : undefined;
    return await run({ db: await connect(), id: id && Number(id), body });
  } catch (error) {
    if (error instanceof Invalid) return answer(400, { message: error.message });
    throw error;
  }
}

function bodyOf(event) {
  const text = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  try {
    return JSON.parse(text);
  } catch {
    throw new Invalid('The body is JSON: {"name": "…"}');
  }
}

function nameOf(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length === 0 || name.length > 200) {
    throw new Invalid('An item is {"name": "…"}, its name 1 to 200 characters');
  }
  return name;
}

const notFound = (id) => answer(404, { message: `No item ${id}` });

function answer(statusCode, body, headers = {}) {
  if (body === undefined) return { statusCode, headers };
  return { statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

// One connection per instance, made at its first call that needs it and kept for the calls after, as an instance
// takes one call at a time; the table made then, if it isn't there.
let ready;

function database() {
  ready ??= connect().catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

async function connect() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set: the database is the function's secret, see README.md");
  }
  // Loaded here, so that the tests run without it installed.
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 3000 });
  await pool.query(`CREATE TABLE IF NOT EXISTS items (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now())`);
  return { query: async (text, values) => (await pool.query(text, values)).rows };
}
