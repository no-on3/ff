# {{name}}

A function for FF, in {{language}}: `function.{{extension}}` holds its handler, `events/event.json` an event to call it with.

```bash
ff local invoke . --data @events/event.json      # on this machine, in Docker, as FF runs it
ff deploy function.{{extension}}                 # on FF, as {{name}}: again after a change, to update it
ff invoke {{name}} --data @events/event.json     # its answer, and the request ID of its log lines
ff logs {{name}}                                 # its log: --follow for the new lines as they come
```

The handler is AWS Lambda's, and so is the event: what the caller sent. Only the standard library is there for now: packages come with zip deploys.
