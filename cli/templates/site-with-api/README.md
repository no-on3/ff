# {{name}}

A page and its API, in {{language}}: a guestbook. The page, `site/`, is a bucket's site; it finds the API's address in `site/config.json` and calls it from the browser. The API, at a function's URL, lists the latest entries and keeps new ones, each an object of a second bucket. The same folder runs here with `ff local start`, on FF with `ff deploy` and `ff sites deploy`, and on AWS with `sam deploy`.

| Route | Answer |
| --- | --- |
| `GET /entries` | The latest 20 entries, the newest first |
| `POST /entries` | `{"name": "…", "message": "…"}`, a name of 1 to 50 characters and a message of 1 to 500: 201 with the entry kept, its `id` and its time `at` |

A path without a route is 404, and another method 405, with the methods it takes in `Allow`. `src/` is the function's code, `CodeUri` in `template.yaml`: `src/app.{{extension}}` routes the requests and keeps each entry as `entries/<id>.json`, its ID counting down to the year 2286, so that the bucket, which lists its keys in order, lists the newest first. `site/` holds the page, `index.html`, `app.js` and `style.css`, yours to change. `tests/` tries each route with a stand-in for the bucket, `events/` holds two requests as the URL sends them, and `samconfig.toml` names the stack, `{{name}}`.

The API's CORS lets any page call it, `AllowOrigins: ["*"]`: it takes no cookie and no key, so a page elsewhere can do no more with it than curl can. An API that takes a cookie or a key names its page's origin alone, as `ff init --template rest-api`'s does.

## Here

```bash
{{install}}
{{test}}# the API's tests, no bucket needed
echo '{"api": "http://{{name_lower}}-api.fn.localhost:3700"}' > site/config.json   # the API the page calls, here
ff local start template.yaml --site Website=site   # the page, http://website.site.localhost:3700, the API, the buckets
curl -d '{"name": "Amira", "message": "Ahlan from Sousse!"}' http://{{name_lower}}-api.fn.localhost:3700/entries
curl http://{{name_lower}}-api.fn.localhost:3700/entries
```

The page answers a browser at `http://website.site.localhost:3700`. `--site Website=site` serves the folder as it is, a change seen at the next load, without a copy; without it, the site answers the bucket's objects, which the AWS CLI uploads at `http://127.0.0.1:3700` with the key `ff local start` prints. The entries are kept in `.ff/local/buckets/entries/` from a start to the next; `ff local reset` removes them.

## On FF

```bash
ff deploy template.yaml                         # the stack {{name}}: the API and its URL, the two buckets, their names
echo "{\"api\": \"$(ff url show {{name}}-api --output json | jq -r .url.functionUrl)\"}" > site/config.json
ff sites deploy <WebsiteBucket> site            # the page, to the bucket the deploy named
```

The page is at `WebsiteUrl`, an output of the deploy, as are the buckets' names, made from the stack's. `ff sites deploy` again sends what changed alone. `ff delete-stack` deletes the function, its URL and the buckets; a bucket that holds files stops it, as it stops CloudFormation: `ff buckets delete <WebsiteBucket> --force` and `ff buckets delete <EntriesBucket> --force` delete them with their files, and `ff delete-stack` again the rest.

## On AWS

```bash
sam build && sam deploy --guided                # the same template, the stack {{name}}
echo '{"api": "<ApiUrl>"}' > site/config.json   # the API the page calls, an output of the deploy
aws s3 sync site/ s3://<WebsiteBucket>/         # the page
```

The page is at `WebsiteUrl`, S3's website address, `http://` alone: CloudFront in front of the bucket gives it `https://`. `WebsitePolicy` makes the page's files public, as S3's sites need, and the bucket's `PublicAccessBlockConfiguration` lets that policy be; an account that blocks public access to all its buckets keeps the page private, until its own setting allows it. `Policies` give the function's role the entries' bucket.

## The same as on AWS

The template is SAM's, within what FF takes of it; the site is S3's website hosting, a bucket's `WebsiteConfiguration`; the handler is AWS Lambda's, given Lambda's URL event (version 2.0) and answering a URL's response; the URL's CORS is answered by the URL, before the function, as Lambda's is; the entries' bucket is S3's, reached by AWS's SDK at the endpoint and with the key the function's environment gives, a role's on AWS and the function's own on FF.
