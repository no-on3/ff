# {{name}}

`sam init`'s hello world as FF takes it: `template.yaml` makes one function, `HelloWorldFunction`, its code in
`{{code_uri}}`, AWS Lambda's handler, and a URL anyone may call. `samconfig.toml` names the stack, {{name}}. FF's
`ff deploy` and AWS's `sam deploy` both take the folder as it is.

```bash
ff deploy template.yaml                  # the stack {{name}}: its function and URL, the outputs printed; again after a change
ff local start template.yaml             # on this machine: its URL http://helloworldfunction.fn.localhost:3700/, Ctrl-C ends it
curl <HelloWorldApi>                     # the function's URL, the deploy's output HelloWorldApi: {"message":"hello world"}
ff invoke <name> --data @events/event.json   # a URL's request, by the function's name, which the deploy printed
ff logs <name>                           # its log: --follow for the new lines as they come
{{test}}# the handler's test, events/event.json its request
ff delete-stack {{name}}                 # the stack, with what it made, as sam delete
```

What differs from `sam init`'s:

- **Its URL:** `sam init`'s `Api` event makes an API Gateway REST API, which FF hasn't. `FunctionUrlConfig` gives the
  function a URL on FF and on AWS alike, and `HelloWorldApi`, the output that named the API, is that URL. The output
  of the IAM role SAM makes for the function is left out: FF has no IAM.
- **Its event:** `events/event.json` is a function URL's request, Lambda's payload of version 2.0, which FF's URLs
  send. The handler is `sam init`'s, its answer a URL's as it was API Gateway's.
- **Its test** needs no library, and sits outside `{{code_uri}}`, so that no package holds it.

`ff local start` runs the function on this machine, in Docker, as FF runs it, its URL on the port 3700; its logs
and its key are in `.ff/`, and `.env.local` holds the secrets it gives the functions, `KEY=value` lines, which
`.gitignore` keeps out of git.

`ff doctor template.yaml` says what of a template is outside FF's subset of SAM; the next deploy changes what the
template changed, and deletes what it no longer has after asking (`--yes` in a script). On AWS, `sam deploy` uses the
settings of `samconfig.toml`'s `[default.deploy.parameters]`, which FF passes over.
