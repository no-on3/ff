# {{name}}

A REST API at a function's URL, in {{language}}: its routes by method and path, its items kept in PostgreSQL, and CORS for the one origin whose pages call it. The same folder runs here with `ff local start`, on FF with `ff deploy`, and on AWS Lambda with `sam deploy`.

| Route | What it does |
|---|---|
| `GET /items` | The latest 50 items, the newest first |
| `POST /items` | `{"name": "…"}` kept: 201 with the item, its address in `Location`; 400 for a body that isn't one |
| `GET /items/<id>` | The item, or 404 |
| `DELETE /items/<id>` | 204, or 404 |

A path without a route is 404, and a method its route lacks 405, with the methods it takes in `Allow`. `src/` is the function's code, `CodeUri` in `template.yaml`: `src/app.{{extension}}` routes the requests, and makes the table `items` at its first call if it isn't there. `tests/` tries each route with a stand-in for the database, `events/` holds two requests as the URL sends them, and `samconfig.toml` names the stack, `{{name}}`.

## Here

```bash
{{install}}
{{test}}# the routes' tests, no database needed
ff local start template.yaml --with postgres     # the API at http://{{name_lower}}-api.fn.localhost:3700, a PostgreSQL beside it
curl -d '{"name": "Harissa, 2 jars"}' http://{{name_lower}}-api.fn.localhost:3700/items
curl http://{{name_lower}}-api.fn.localhost:3700/items
```

`--with postgres` runs a PostgreSQL in Docker, its data kept from a start to the next, and gives the function its address as `DATABASE_URL`; `ff local reset --data` removes it. A database of your own takes its place when `.env.local` names it, `DATABASE_URL=postgres://…@host.docker.internal:5432/…`.

## On FF

```bash
ff deploy template.yaml                                    # the stack {{name}}: its function and its URL
ff db create {{name_lower}} --secret-for {{name}}-api      # the database, its address the function's secret DATABASE_URL
ff invoke {{name}}-api --http POST /items --data '{"name": "Harissa, 2 jars"}'
curl "$(ff url show {{name}}-api --output json | jq -r .url.functionUrl)items"
```

The page that calls it from a browser has one origin, `AllowedOrigin`: `http://localhost:5173` unless `ff deploy template.yaml --parameter-overrides AllowedOrigin=https://…` names your site's. `ff delete-stack` deletes the function and its URL; `ff db delete {{name_lower}}` the database.

## On AWS

```bash
sam build && sam deploy --guided                           # the same template, the stack {{name}}, the same URL's CORS
```

The function reads `DATABASE_URL` as it does on FF, where it is a secret and so not in the template. On AWS it is the function's environment: an RDS PostgreSQL's address, added to `template.yaml` for AWS as a parameter CloudFormation doesn't show back, as `ff export` writes it when it moves an app from FF:

```yaml
Parameters:
  DatabaseUrl:
    Type: String
    NoEcho: true
# and under the function's Properties:
      Environment:
        Variables:
          DATABASE_URL: !Ref DatabaseUrl
```

## The same as on AWS

The template is SAM's, within what FF takes of it; the handler is AWS Lambda's, given Lambda's URL event (version 2.0) and answering a URL's response; the URL's CORS is answered by the URL, before the function, as Lambda's is; and the database is PostgreSQL, reached by the same driver at the address in `DATABASE_URL`. On FF the function's URL is `https://<id>.fn.<FF's domain>/`, on AWS `https://<id>.lambda-url.<region>.on.aws/`.
