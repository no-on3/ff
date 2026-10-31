# `ff`, FF's command-line tool

One Rust binary that deploys, invokes and reads FF's functions, through FF's API only: no storage keys, no cluster access ([ADR 0002](../docs/adr/0002-cli.md)). It is being built task by task, as the [CLI plan](../docs/cli-plan.md) says; its progress log says what works.

## Commands so far

| Command | What it does |
|---|---|
| `ff init <name> --runtime nodejs\|python` | Makes the folder `<name>`: `function.ts` or `function.py`, AWS Lambda's handler, which logs a line and answers a greeting; `events/event.json`, an event to call it with; and a README with the commands that run it here, deploy it and read its log |
| `ff deploy <file\|folder> [--name] [--runtime] [--handler] [--memory] [--timeout] [--min-instances] [--max-instances] [--env KEY=value…] [--container] [--no-build]` | Creates the function of the file's name (or `--name`; a `function.*` file, as `ff init` makes, takes its folder's name), its runtime from the extension (`.ts`, `.js`, `.cjs`: nodejs; `.py`: python), 128 MB and 5 s unless said; or updates the function of that name with only what changed, and says "no changes" when nothing did. It returns once the new version is live, and sets the instances after. `--env KEY=value`, repeated, sets the function's variables, all of them as on Lambda: those not named are removed; `ff env` changes one at a time. Code that fails to load exits 4 with the diagnosis: a new function is kept, in `ERROR`, and a working one keeps its previous version. **A folder** is deployed as a package with its libraries (below): the folder's name, its runtime from `package.json`, `requirements.txt` or `pyproject.toml`; packaged, then uploaded only when the account hasn't it, which ff asks by its SHA-256, and named in the same rollout as the settings. Its handler is `--handler`, else the function's while the package has its file, else `function.*`, then AWS Lambda's defaults, `index.*` for Node.js and `lambda_function.lambda_handler` for Python. A file deployed over a function that runs a package makes it inline code again, which ff says, its handler `function.handler` unless `--handler` names another |
| `ff package [<folder>] [--zip FILE] [--runtime] [--handler] [--container] [--no-build] [--compile]` | Makes the folder (this one by default) a zip as AWS Lambda takes one, with its libraries, as `ff deploy <folder>` does (below), and writes it to the folder's `.ff/<name>.zip`, or `--zip`; it prints its files, sizes, handler and SHA-256, Lambda's `CodeSha256`. `--compile` runs the project's own `tsc` on its `tsconfig.json` and leaves the TypeScript out, for AWS Lambda, which runs JavaScript alone: FF runs `.ts` itself |
| `ff invoke <name> [--data JSON\|@file\|-] [--raw] [--async\|--dry-run\|--http METHOD PATH [-H 'name: value']…]` | Calls it with the event (`{}` by default) and prints its answer, then `request <ID> · <duration> · <memory>`; the request ID finds the call's log lines. `--raw` prints the answer only. A function that raised or timed out exits 5, with the call's ID. `--async` runs it without waiting, as AWS Lambda's invocation type Event: it prints the call's request ID at once (`--raw`: the ID alone), and FF runs it within seconds, retried on failure, each attempt in `ff history` under that ID. `--dry-run` only checks that the call could be made: nothing runs. `--http` calls it through its URL instead, as a browser or a webhook does, with the API key when the URL takes one, and prints the HTTP status and body (`--verbose`: the headers too) whatever the status, as curl does; a host under `localhost` is reached on `127.0.0.1` |
| `ff list` | The account's functions: runtime, memory, timeout, status, instances, last update |
| `ff get <name>` | One function: its settings and state, its handler, its code (inline or a package, its size, its SHA-256 as AWS Lambda gives it), its error when it is in `ERROR`, its variables' names |
| `ff logs <name> [--tail N] [--since 15m] [--start] [--end] [--grep phrase] [--request-id ID] [--all] [--follow [--poll]]` | Its log lines from the log store, as `time [instance] message` (with `--verbose`, the call's request ID too): the newest 100 of the window by default, `--all` every page of it, `--follow` then each new line as it comes, through the API's live tail, a new tail when one ends (after 30 minutes), a minute of retries 5 s apart when the store is unavailable, and `--poll` asking every 2 s instead, through a proxy that holds streams back. `--grep` finds a phrase as whole words, case included; `--request-id` one call's lines, from its START to its REPORT. The store's notice of dropped lines comes as a warning. With `--output json`, each line is a JSON object of its own |
| `ff async-config <name> [--retries 0\|1\|2] [--max-age 30m] [--on-success FN\|--no-on-success] [--on-failure FN\|--no-on-failure] [--reset]` | Its settings for its calls that don't wait, as AWS Lambda's asynchronous invocation settings: how many times a call that fails is retried, how long one is kept (1 minute to 6 hours), and another function of the account, by name or ARN, or a queue of it, by ARN (`arn:aws:sqs:tn-tunis-1:<account>:<queue>`), that gets each call's record once it succeeds, or fails for good. Without a flag it says them, or that Lambda's defaults apply; the flags change what they name and keep the rest; `--reset` goes back to Lambda's defaults |
| `ff history <name> [--limit N]` | Its last calls, newest first: time, request ID, status, duration, how it came (an asynchronous call's attempt with its number), the error's first line; `--output json`, each call as the history keeps it, its event and answer included |
| `ff scale <name> [--min N] [--max N]` | The instances it keeps running when idle (billed as AWS bills provisioned concurrency), and the most it runs |
| `ff delete <name> [--yes]` | Deletes it, with its history and its logs, after asking; a script says `--yes` |
| `ff local invoke <file\|folder> [--data …] [--raw] [--name] [--runtime] [--memory] [--timeout]` | Runs it once on this machine, in Docker, in the runtime image production uses and with the pod's hardening: a read-only root with a 512 MiB `/tmp`, uid 10001, no capability, no new privileges, its memory as the limit and CPU by Lambda's ratio, the variables the backend gives a pod, the code mounted read-only (a file as `/var/task/function.<extension>`, a folder as `/var/task`), the port on `127.0.0.1` only. `--env KEY=value` gives the run variables, refusing the names the runtime sets itself, as the API does. It prints the answer and the call's log; a load that fails exits 4 with the runtime's reason, a call that raised, timed out or ran out of memory exits 5. The container is removed after, Ctrl-C too |
| `ff local start <file\|folder> [--port N] [--watch] [--url]` | Keeps it running on `127.0.0.1` (any free port unless `--port`): it prints the address to `POST` events to, then its log on stderr as it comes, until Ctrl-C. `--watch` starts it again when its code changes: its file, even replaced by an editor, or anything in its folder. `--url` serves it as its URL would on FF: any request becomes AWS Lambda's URL event (API Gateway's payload 2.0, as the backend's gateway builds it), its answer the response by Lambda's rules, and what the gateway answers itself (502 for an answer that can't be one, its reason on stderr; 429; 413 over 6 MB) answered the same way. CORS and keys are FF's: none locally |
| `ff env list <name> [--show]` | Its environment variables' names, and with `--show` their values: they are readable like its code, as on Lambda |
| `ff env set <name> KEY=value… \| KEY…` | Sets variables, keeping the others, and returns once the new version is live; a `KEY` alone reads its value from stdin, or from a prompt that doesn't show it, so that the shell's history doesn't keep it. Nothing is sent when nothing changes |
| `ff env unset <name> KEY…` | Removes variables |
| `ff secrets list <name>` | Its secrets: their names, and when each was set; never a value, which nobody reads back, the API included |
| `ff secrets set <name> NAME…` | Sets secrets, keeping the others, once the new version is live: each value from a prompt that doesn't show it, or a line of stdin each, in the names' order; a value on the command line is refused, as the shell's history would keep it |
| `ff secrets unset <name> NAME…` | Removes secrets |
| `ff url show <name>` | Its web address, as AWS Lambda's function URLs: who may call it, its CORS, its own domains |
| `ff url enable <name> [--auth none\|key] [--cors-origin …] [--cors-method …] [--cors-header …]` | Gives it a URL, `--auth` saying who may call it: `none`, anyone; `key`, the account's API keys with `functions:invoke`, as Lambda's `AWS_IAM` would ask for a signature; or changes what is given on the URL it has |
| `ff url disable <name> [--yes]` | Deletes its URL, after asking: the address stops answering at once, and a new URL would have another |
| `ff domains list\|add\|verify\|remove <name> [<domain>]` | The account's own domains for its URL: `add` says the DNS records that prove one (a CNAME to the URL's host for a subdomain, or a TXT record, for an apex too), `verify` checks them again, `remove` takes one away |
| `ff schedule list <name>` | Its schedules: each one's expression, whether it runs, its next run, and how its last went |
| `ff schedule set <name> <expression> [--name N] [--input JSON\|@file\|-] [--no-input] [--description] [--disabled]` | Makes the schedule `N` (`schedule` unless named), or changes it: an EventBridge expression in UTC (`rate(5 minutes)`, `cron(0 2 * * ? *)`), the event its runs send (EventBridge's Scheduled Event, or `--input`; `--no-input` goes back to it). It says the next runs, as the API reads the expression, and a wrong one in the API's words before anything changes |
| `ff schedule enable\|disable\|remove <name> [--name N]` | Runs it again from now, stops its runs keeping it, or removes it |
| `ff db create <name> [--secret-for <function>…] [--secret-name NAME]` | Makes a PostgreSQL database and its user, as AWS RDS gives one (its name RDS's: lower-case letters, digits and hyphens, checked before calling), and prints its connection string this once: FF keeps no copy. `--secret-for` sets that string as a secret of each function named, `DATABASE_URL` unless `--secret-name` says otherwise, each rolled out in turn; a function that isn't the account's stops it before the database is made. Needs `databases:write`, and `functions:write` with `--secret-for` |
| `ff db list` | The account's databases: their status (available, read-only past the plan's storage, suspended), storage of the plan's, sessions of the plan's, when made. Needs `databases:read` |
| `ff db get <name>` | One database: its status, storage and sessions now, and how to reach it (host, database, user, the string without its password), when its password was made |
| `ff db password <name> [--secret-for <function>…] [--secret-name NAME]` | Gives it a new password, printed this once in its connection string, as `create` does, and sets it as the functions' secret; the old one opens no new session |
| `ff db delete <name> [--yes]` | Drops it and its user, with its data, after asking; a script says `--yes` |
| `ff caches create <name> [--secret-for <function>…] [--secret-name NAME]` | Makes a cache, Valkey as AWS ElastiCache gives it (its name ElastiCache's: lower-case letters, digits and hyphens, checked before calling), with the plan's memory, and prints its address, `rediss://default:<password>@<host>:<port>`, this once: FF keeps no copy. `--secret-for` sets it as a secret of each function named, `REDIS_URL` unless `--secret-name` says otherwise, each rolled out in turn, as `ff db create` does. Needs `caches:write`, and `functions:write` with `--secret-for` |
| `ff caches list` | The account's caches: their status (available, suspended with the account), the memory their keys use of the plan's, their connections now, when made. Needs `caches:read` |
| `ff caches get <name>` | One cache: its status, memory and connections now, its address without its password, its engine, when its password was made |
| `ff caches password <name> [--secret-for <function>…] [--secret-name NAME]` | Gives it a new password, printed this once in its address, and sets it as the functions' secret; the old one logs no new connection in, those under way keep theirs |
| `ff caches delete <name> [--yes]` | Deletes it, with its keys, after asking; a script says `--yes` |
| `ff email identities` | The domains and addresses the account sends mail from, as AWS SES v2 lists its identities: each one's proof (proved, waiting, not proved, its record gone), its sending, when added. Needs `email:read` |
| `ff email add <domain or address>` | Adds a domain to send from, with the records to publish at its DNS, printed: its DKIM key's, which proves it, its return path's MX and SPF, which bring its bounces back, and DMARC's, advised; FF looks for them every minute, for 72 hours. An address gets a link e-mailed to it, whose following proves it. The name is checked as the API checks it before calling. Needs `email:write` |
| `ff email get <domain or address>`, `ff email verify <domain or address>` | One identity: its proof, its DKIM selector, its return path, the records it publishes; `verify` looks a domain's records up now, or e-mails an address its link again |
| `ff email delete <domain or address> [--yes]` | Deletes it, with its DKIM key, after asking: no mail goes from it after; a script says `--yes` |
| `ff email account` | The account's sending, as SES's GetAccount says it: in the sandbox or not, on or paused, its standing (healthy, under review, stopped past SES's bounce and complaint rates), what it sent of the plan's quotas in the last 24 hours |
| `ff email send --from <address> --to <address>… [--cc …] [--bcc …] --subject <text> (--text <text> \| --html <html>)` | Sends a message, as SES's SendEmail sends a simple one: from an address the account proved or one at a domain it proved, signed with that domain's DKIM key; in the sandbox, only to what it proved. It's queued, and its ID printed |
| `ff email messages [--limit N]` | The account's latest messages (20 unless `--limit`, 100 at most), each recipient's fate: sent, bounced or failed with the receiving server's words, complained of, kept off by the suppression list |
| `ff email suppressions`, `ff email suppress <address> [--reason BOUNCE\|COMPLAINT]`, `ff email unsuppress <address>` | The account's suppression list, every page of it, the addresses none of its mail goes to, each with why and the message it came from; an address put on it, a bounce unless `--reason` says otherwise, or taken off |
| `ff buckets create <name>` | Makes a bucket, as AWS S3 gives one (its name AWS's without dots, unique across FF, checked before calling), and says where AWS's tools reach it: the endpoint, its address, the region; and that FF keeps no copy of its files at a second site. Needs `storage:write` |
| `ff buckets list`, `ff buckets get <name>` | The account's buckets, each with what it held at its last hourly measure and its address; one with its objects then, its endpoint and region. Needs `storage:read` |
| `ff buckets delete <name> [--force] [--yes]` | Deletes an empty bucket, after asking; `--force` deletes its files first, and the uploads under way |
| `ff buckets keys create [--bucket NAME…] [--queue NAME…] [--read-only]` | Makes an access key to the account's buckets and queues, or to the ones named alone (a key naming buckets alone reaches no queue, and one naming queues alone no bucket), read-write or read-only, and prints its secret this once as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_ENDPOINT_URL_S3` and `AWS_ENDPOINT_URL_SQS`, which AWS's SDKs and CLI read: `eval` them, or put them in a function's secrets. Two at most an account. Owners only |
| `ff buckets keys list`, `ff buckets keys revoke <id> [--yes]` | The account's keys, the buckets and queues each reaches, read-write or read-only, and when it was last used, never a secret; revoking one refuses it at once |
| `ff buckets notify <bucket> <function>\|--queue NAME [--event EVENT…] [--prefix P] [--suffix S] [--id ID]` | Has the bucket send its objects' events, as S3's notifications: to a function of the account, called without waiting with S3's event, or to a queue, as messages; `s3:ObjectCreated:*` unless `--event` names others (S3's names, held to them before calling), for the keys its prefix and suffix name. The bucket's other configurations stay; one an event could match twice is refused, in S3's words. Needs `storage:write` |
| `ff buckets notifications <bucket> [--remove ID] [--clear [--yes]]` | The bucket's notifications: each one's ID, events, keys and destination; `--remove` takes one away, `--clear` all of them, after asking. Needs `storage:read` |
| `ff sites deploy <bucket> <folder> [--spa\|--no-spa] [--index-document NAME] [--error-document KEY] [--keep]` | Uploads a built site's folder to a bucket as its site, as S3's website hosting serves one: with a key of its own to that bucket for the deploy alone, revoked when it is done, it sends the files whose content changed, assets first and pages last, each typed by its name and cached a year (`immutable`) when its name carries a hash, `no-cache` otherwise; then deletes the bucket's files the folder hasn't, unless `--keep`. Names starting with a dot are left out, `.well-known` apart. Makes the bucket a site if it isn't one, `index.html` its index document and the folder's `404.html` its error document unless told; `--spa` answers a path with no file with the index document, for a single-page app's routes. Owners and developers; needs `storage:write` |
| `ff sites get <bucket>`, `ff sites remove <bucket> [--yes]` | The site's address and settings; removing it makes the bucket no site, its address answering 404 at once, its files kept, private again |
| `ff sites domains list\|add\|verify\|remove <bucket> [<domain>]` | The site's own domains, proved as a function URL's are: `add` says the DNS records that prove one (a CNAME to the site's host, or a TXT record and the addresses), `verify` checks them again, `remove` takes one away |
| `ff sites metrics <bucket> [--period 60\|300\|3600] [--since 1h]` | The site's visits, as CloudWatch names a CloudFront distribution's metrics: a row per period with its requests, the bytes sent, and the shares answered 4xx and 5xx; JSON is the API's answer, `TotalErrorRate` too. Needs `metrics:read` |
| `ff queues create <name> [--visibility-timeout D] [--retention D] [--delay D] [--receive-wait D] [--max-message-size BYTES] [--dead-letter-queue QUEUE [--max-receive-count N]]` | Makes a queue, as Amazon SQS's standard queues (its name SQS's, 1 to 80 letters, digits, hyphens and underscores; a FIFO queue's refused), with SQS's attributes, durations such as `30s`, `15m` or `4d` checked against SQS's ranges before calling, and a dead-letter queue by its name, which gets each message received more than `N` times (5 unless said); says its URL, ARN and endpoint. Needs `queues:write` |
| `ff queues list`, `ff queues get <name>` | The account's queues, each with its messages waiting, in flight and delayed, what they hold and its dead-letter queue; one with its URL, ARN and endpoint (`AWS_ENDPOINT_URL_SQS`) and its attributes in words. Needs `queues:read` |
| `ff queues set <name> [the attributes' flags] [--no-dead-letter-queue]` | Changes the attributes given, as SQS's SetQueueAttributes: the others stay |
| `ff queues send <name> <body\|@file\|-> [--attribute NAME=VALUE…] [--delay D]` | Sends a message, as SQS's SendMessage, to debug a queue: its body as given, from a file or from stdin, with string attributes; prints its ID |
| `ff queues receive <name> [--max N] [--wait D] [--visibility-timeout D] [--delete]` | Receives up to `N` messages (1 to 10), as SQS's ReceiveMessage, waiting up to 20 s for one: each hidden for the visibility timeout and its receive counted, as any receive; prints each one's ID, receive count, sender, attributes, receipt handle and body; `--delete` deletes each one received |
| `ff queues delete-message <name> <receipt handle>` | Deletes a message by the handle of its last receive; an older receive's handle deletes nothing, as on SQS |
| `ff queues purge <name> [--yes]`, `ff queues delete <name> [--yes]` | Deletes every message of a queue, or the queue with its messages, after asking; a script says `--yes` |
| `ff queues metrics <name> [--period 60\|300\|3600] [--since 1h]` | A queue's metrics, as CloudWatch names SQS's: a row per period with the most messages waiting and in flight, its oldest message's age, the messages sent, received and deleted, and the receives that found none; then the window's totals. JSON is the API's answer, with each period's averages and the size of what was sent. Needs `metrics:read` |
| `ff event-sources add <queue> <function> [--batch-size N] [--batching-window D] [--report-batch-item-failures] [--max-concurrency N] [--disabled]` | Has the function read a queue of the account, as AWS Lambda's event source mapping for SQS: FF calls it with SQS's event, `Records[]`, in batches of up to `N` messages (10 unless said, up to 10,000; over 10 with a window), gathered for up to `D` (`2s`; none unless said), and deletes what the call handled; `--report-batch-item-failures` reads the answer's `batchItemFailures`, keeping those messages alone; `--max-concurrency` (2 to 1,000) caps the batches at once. The queue's visibility timeout must be at least the function's timeout, as Lambda requires. Says the mapping's UUID. Needs `functions:write` |
| `ff event-sources list [--function NAME] [--queue NAME]`, `ff event-sources get <uuid>` | The account's mappings, or a function's, or those reading a queue: which function reads which queue, its batches, window, failures (the batch's or each item's), concurrency and state. Needs `functions:read` |
| `ff event-sources update <uuid> [the batches' flags] [--report-batch-item-failures\|--no-report-batch-item-failures] [--no-max-concurrency] [--enable\|--disable]` | Changes what is given, as Lambda's UpdateEventSourceMapping: disabled, nothing is read and the messages wait |
| `ff event-sources remove <uuid> [--yes]` | Stops the function reading the queue, after asking; the queue's messages stay |
| `ff export <folder> [--functions NAME,…] [--with-values]` | Writes what a move to AWS needs in a new folder, from the account's resources, or from the functions named with the queues and buckets that call them, that they send to or that their keys use: `template.yaml` for AWS SAM, the functions (their runtime as Lambda names it, their memory and timeout, their variables as parameters unless `--with-values`, their secrets as parameters CloudFormation doesn't echo, warm instances as provisioned concurrency, a role allowing what their keys used on FF, through SAM's policy templates where the function did what one is for) with their URLs, schedules, queues read and settings for calls that don't wait, then the queues and the buckets with their events, each bucket's name a parameter, S3's names being global; a schedule is off there until the move (`ScheduleState`), so that none runs on both; `code/<function>.zip`, each function's code as Lambda runs it, inline TypeScript as the JavaScript FF ran; `secrets.template.env`, the values the template takes and the export doesn't write; `data/`, a page for each kind of resource the account has, its names said at the top, and `s3-sync.sh`; and `MIGRATION.md`, the account's runbook: the data first, then the queues, then the functions, with what the template changes on the way, a name from before Lambda's rule among it. Needs `functions:read` and the other services' reads |
| `ff accounts` | The accounts the token reaches, the role in each, the current one marked |
| `ff account` | The current account (the one named by `--account`, `FF_ACCOUNT` or the profile, else the only one): its status, the role in it, its plan's limits, and whether its functions reach the internet, which is why a call out fails when they don't |
| `ff usage [--month YYYY-MM] [--csv]` | A month's usage per function, deleted ones included: requests, GB-seconds, the calls not billed, the cost; each database's hours measured, GB-months and cost; each bucket's GB-months, its requests by S3's two classes, what they sent out (counted, not billed) and cost; each queue's requests as SQS bills them, the messages sent and received, and cost; the total and the estimate; `--csv`, the API's own CSV. Needs `usage:read` |
| `ff balance` | The balance, this month's charges and how far they are rated, and whether calls go on, are in their grace period, or stopped. Needs `usage:read` |
| `ff metrics [<name>] [--period 60\|300\|3600] [--since 1h]` | A function's metrics, or the whole account's: a row per period with invocations, errors, throttles, cold starts, the duration's p50, p95 and maximum, and the instances; then the window's totals, and its calls that didn't wait when there were any, as Lambda's metrics count them: kept, dropped, and records their destination didn't take. Needs `metrics:read` |
| `ff whoami` | Who the token is, an API key (its name, ID and scopes) or a user (their accounts, and which one acts), and the account it acts for: `GET /me`. The first check of a new key |
| `ff config set <key> <value>` | Set one of the profile's settings: `endpoint`, `account`, `dev_account` or `allow_http` |
| `ff config unset <key>` | Remove one of them, or the profile's `token` |
| `ff config show` | The settings in effect, each with where it comes from; the token masked, `ffk_<key ID>_…`, as the console lists keys |
| `ff config set-token` | Save an API key for the profile, read from a prompt that doesn't show it, or from stdin (`ff config set-token < key.txt`) |
| `ff version` | The version, and the commit it was built from; with `--verbose`, the platform it was built for |
| `ff completion <shell>` | A completion script for `bash`, `zsh`, `fish`, `elvish` or `powershell` |

Every command takes `--output text|json` (one JSON document per command, for scripts: a function's code is left out, its size given), `--quiet` (no progress or notes on stderr), `--verbose` and `--no-color` (`NO_COLOR` in the environment says the same), and the connection's flags below. Functions are named as on AWS Lambda: 1 to 64 letters, digits, hyphens or underscores, which `ff deploy` checks before sending anything.

## Settings

An owner of the account makes an API key in the console's API keys page, with the scopes the commands need, and the key is shown once. Then:

```bash
ff config set endpoint https://api.ff.example   # the API's address; http://localhost:3000 by default
ff config set-token                             # paste the key: it isn't shown, nor kept in the shell's history
ff whoami                                       # API key "laptop" (ffk_1a2b3c4d5e6f_…) on account 123456789012 …
```

The settings are kept in `config.toml`, the token in `credentials.toml` next to it, readable by its owner only (ff warns when others may read it). Both are in `~/.config/ff/` on Linux, `~/Library/Application Support/ff/` on macOS, `%APPDATA%\ff\` on Windows, or in the folder `FF_CONFIG_DIR` names. Each holds profiles:

```toml
[profiles.default]
endpoint = "https://api.ff.example"

[profiles.dev]
endpoint = "http://localhost:3000"
dev_account = "123456789012"     # a development stack (FF_AUTH_MODE=dev) acts as this account, with no token
```

`ff config set` and `unset` change a file keeping its comments and its other profiles; `--profile <name>` picks the profile they change, and the first setting makes a new one.

**Which setting applies:** a flag, then an environment variable, then the profile, then the default.

| Setting | Flag | Environment | Profile |
|---|---|---|---|
| The profile | `--profile` | `FF_PROFILE` | `default` |
| The API's address | `--endpoint` | `FF_ENDPOINT` | `endpoint`, else `http://localhost:3000` |
| The account, for a login with several | `--account` | `FF_ACCOUNT` | `account` |
| The token | none: a flag would stay in the shell's history | `FF_TOKEN` | `token`, in `credentials.toml` |
| The account a development stack acts as | | | `dev_account` |
| Plain http to another machine | `--allow-http` | | `allow_http` |

**Plain `http://`** sends the token in clear, so ff uses it only to this machine (`localhost`, `127.0.0.1`, `[::1]`), unless `--allow-http` or `allow_http = true` says otherwise, for a development stack elsewhere.

**Without a token**, nor a development account, ff says how to get a key, and calls nothing.

## Running functions on this machine

`ff local` needs Docker, and the runtime images: `ff-runtime-nodejs:24-v3` and `ff-runtime-python:3.13-v3`, built from this repository (`docker build -t ff-runtime-python:3.13-v3 runtimes/python`, or any end-to-end script's run), or others named by `FF_RUNTIME_IMAGE_NODEJS` and `FF_RUNTIME_IMAGE_PYTHON`. It speaks to the runtime as the backend does (`/readyz`, then `POST /invoke` with the event), so a function behaves on this machine as in its pod, but for its variables and secrets, which stay on FF.

## Packages

`ff package` and `ff deploy <folder>` make a function's folder a zip as AWS Lambda takes one, within its limits, which FF's API applies too: 50 MB zipped, 250 MB and 20,000 files unpacked.

- **Built in a copy of the folder,** never in it, in the system's temporary folder: for Node.js, `npm ci` (`npm install` without a lockfile), the `build` script when `package.json` has one, then `npm prune --omit=dev`, so that the build's tools aren't packaged; for Python, pip installs `requirements.txt`, or `pyproject.toml`'s `[project] dependencies`, at the package's root, as wheels for the runtimes' platform whatever this machine is: Linux x86_64, glibc 2.28 or older, CPython 3.13 (`--platform manylinux_2_28_x86_64 --only-binary=:all:`), which FF's runtimes (glibc 2.41) and AWS Lambda's run. npm 11.19 and later run no install script of a dependency that `package.json`'s `allowScripts` doesn't allow; ff shows npm's output only when a step fails, so it says which scripts npm skipped, and `npm install-scripts approve <package>` in the folder allows one.
- **`--container`** runs the same steps in Docker, in the runtime's base image (`node:24-trixie-slim`, `python:3.13-slim`) for `linux/amd64`, as this user, as `sam build --use-container` does: for npm's libraries with native code on another system than Linux x86_64, which ff warns about, and for a Python library published as source alone, which pip there builds. **`--no-build`** installs nothing: the folder as it is, its `node_modules` included.
- **Left out:** version control (`.git`, `.hg`, `.svn`), `__pycache__`, `.DS_Store`, ff's own `.ff/`, `.env` and `.env.*` files, which usually hold secrets and which a warning names (`ff secrets set` gives a function its secrets), the folder's own `node_modules` when npm installs them again, and what `.ffignore` names, in `.gitignore`'s syntax without `!` (a name at any depth, a path from the folder with a `/`, a trailing `/` for folders, `*`, `?` and `**`): what the build reads stays in its copy, and only the zip leaves it out. A link to a file inside the folder is packaged as that file; a link to a folder, out of it or to nothing is left out, and a warning says how many.
- **The same zip each time** for the same files (the plan's D5): entries in the order of their names, dated 1980-01-01, `0644`, or `0755` for a file this machine marks executable, deflated when that makes them smaller. A deploy compares its SHA-256 with the function's: an unchanged folder sends nothing.

`ff package` writes `.ff/.gitignore` with the folder it makes, so that git doesn't keep the zips.

## What ff sends

Each request carries `Authorization: Bearer <token>`, `X-FF-Account` when an account is set, `X-FF-Dev-Account` when a development account is, and `User-Agent: ff-cli/<version>`. It connects within 5 s, and waits 30 s for an answer, unless a command needs longer: a deploy waits 120 s for its rollout, and a package's upload a minute and a second per 100 KB. A package is asked for by its SHA-256 (`GET /packages?codeSha256=`) and uploaded (`POST /packages`, `application/zip`) only when the account hasn't it; when the hourly purge of unused packages takes it between that question and the rollout, ff uploads it and tries once more. `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and `NO_PROXY` are honoured, and certificates are checked against the system's own, so a company's CA works.

A read the plan's rate refused (429) is tried once more after its `Retry-After`, up to 30 s; a change never is, since it may have happened.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, "no changes" included |
| 2 | A usage error: an unknown command or flag, a bad argument |
| 3 | Configuration, connection, or an API error that isn't one below |
| 4 | A deploy failed: the function didn't become ready |
| 5 | The invocation failed: the function raised an error or timed out |
| 6 | Refused by the account, not the request: no credit (402), a role or a key's scopes (403), the plan's rate (429) |

An error goes to stderr: `error: <message>`, the API's own when it refused, and its request ID on the next line when there is one; with `--output json`, `{"error": {"message", "exitCode", "status", "requestId"}}`, the API's status and request ID null when the API gave none.

## Install

`hack/build-cli.sh`, from the repository's root, makes the static Linux binary for x86_64, `cli/target/dist/ff-linux-x86_64`, and its SHA-256 beside it: here, when the musl target and `musl-gcc` are installed, else inside the Rust image (`--container` asks for it). Copy it as `ff` anywhere on the `PATH`; it needs nothing else, and `ff version` names the commit it was built from. Releases for other systems, signed, come with the CLI plan's C-41.

## Build and test

Rust 1.91.0, which `rust-toolchain.toml` names: rustup installs it on first use in this folder, so that a laptop and the CI server lint with the same clippy (`hack/install-tools.sh rust` installs rustup and it in `hack/.rust` where there is no rustup; `RUSTUP_TOOLCHAIN=stable` tries the newest). From this folder:

```bash
cargo build --release --locked                                    # target/release/ff
cargo build --release --locked --target x86_64-unknown-linux-musl  # a static binary, with musl-gcc installed
cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings
cargo test --locked                                                # unit tests, then the binary's own (tests/)
```

The binary's tests run `ff` with a settings folder of its own, against a scripted API (`tests/common/mod.rs`) that answers in order and records what it was sent. `ff version` names the commit from git at build time, or from `FF_BUILD_COMMIT` when the build sets it.
