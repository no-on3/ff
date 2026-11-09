# {{name}}'s API, at its function's URL: each request routed by its method and path, its items kept in PostgreSQL.
# The event is Lambda's URL event (version 2.0) and the answer a URL's response, the same on FF and on AWS Lambda.
#   GET    /items        the latest 50 items, the newest first
#   POST   /items        {"name": "…"}: the item kept, 201 with it
#   GET    /items/<id>   the item, or 404
#   DELETE /items/<id>   204, or 404
# DATABASE_URL names the database: on FF a secret (ff db create <name> --secret-for <function>), with
# ff local start --with postgres the local one, on AWS the function's environment. The browser's CORS is the URL's,
# as template.yaml sets it: this code never answers a preflight.
import base64
import json
import os
import re


class Invalid(Exception):
    """A request that can't be taken: its answer is 400 with the message."""


ITEM = '''id, name, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"'''


def list_items(db, id, body):
    return answer(200, db.query(f"SELECT {ITEM} FROM items ORDER BY id DESC LIMIT 50"))


def create_item(db, id, body):
    [item] = db.query(f"INSERT INTO items (name) VALUES (%s) RETURNING {ITEM}", [name_of(body)])
    return answer(201, item, {"location": f"/items/{item['id']}"})


def read_item(db, id, body):
    found = db.query(f"SELECT {ITEM} FROM items WHERE id = %s", [id])
    return answer(200, found[0]) if found else not_found(id)


def delete_item(db, id, body):
    return answer(204) if db.query("DELETE FROM items WHERE id = %s RETURNING id", [id]) else not_found(id)


# The routes: a method, a path, and what answers them, given the database, the path's ID and the body.
ROUTES = [
    ("GET", re.compile(r"/items/?"), list_items),
    ("POST", re.compile(r"/items/?"), create_item),
    ("GET", re.compile(r"/items/(\d{1,9})"), read_item),
    ("DELETE", re.compile(r"/items/(\d{1,9})"), delete_item),
]


def handler(event, context):
    return route(event, database)


def route(event, connect):
    """The request's answer, the database given by `connect` when its route needs it: the tests give their own."""
    method = event["requestContext"]["http"]["method"]
    path = event["rawPath"]
    paths = [one for one in ROUTES if one[1].fullmatch(path)]
    if not paths:
        return answer(404, {"message": f"No route for {path}"})
    found = next((one for one in paths if one[0] == method), None)
    if found is None:
        allowed = ", ".join(verb for verb, _, _ in paths)
        return answer(405, {"message": f"{path} takes {allowed}, not {method}"}, {"allow": allowed})
    _, pattern, run = found
    groups = pattern.fullmatch(path).groups()
    try:
        body = body_of(event) if method == "POST" else None
        return run(connect(), int(groups[0]) if groups else None, body)
    except Invalid as error:
        return answer(400, {"message": str(error)})


def body_of(event):
    text = event.get("body") or ""
    if event.get("isBase64Encoded"):
        text = base64.b64decode(text).decode("utf-8")
    try:
        return json.loads(text)
    except ValueError:
        raise Invalid('The body is JSON: {"name": "…"}')


def name_of(body):
    name = body.get("name") if isinstance(body, dict) else None
    name = name.strip() if isinstance(name, str) else ""
    if not 0 < len(name) <= 200:
        raise Invalid('An item is {"name": "…"}, its name 1 to 200 characters')
    return name


def not_found(id):
    return answer(404, {"message": f"No item {id}"})


def answer(status, body=None, headers=None):
    if body is None:
        return {"statusCode": status, "headers": headers or {}}
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", **(headers or {})},
        "body": json.dumps(body, ensure_ascii=False),
    }


# One connection per instance, made at its first call that needs it and kept for the calls after, as an instance
# takes one call at a time; the table made then, if it isn't there.
_database = None


class Database:
    def __init__(self, connection):
        self.connection = connection

    def query(self, text, values=()):
        cursor = self.connection.execute(text, values)
        return cursor.fetchall() if cursor.description else []


def database():
    global _database
    if _database is None or _database.connection.closed:
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError("DATABASE_URL is not set: the database is the function's secret, see README.md")
        # Loaded here, so that the tests run without it installed.
        import psycopg
        from psycopg.rows import dict_row

        connection = psycopg.connect(url, autocommit=True, connect_timeout=3, row_factory=dict_row)
        connection.execute(
            """CREATE TABLE IF NOT EXISTS items (
                id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                name text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now())"""
        )
        _database = Database(connection)
    return _database
