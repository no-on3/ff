# {{name}}

A SAM application for FF: `template.yaml` makes one function, `hello/`, with an alias, `live`, and a URL that anyone may
call; `samconfig.toml` names the stack, {{name}}, and the parameters' values.

```bash
ff deploy template.yaml                       # on FF, as the stack {{name}}: again after a change, which it updates
curl "<HelloUrl>?name=Tunis"                  # the address the deploy printed, its output HelloUrl
ff invoke <name> --data @events/event.json    # its answer, by the name the deploy printed, HelloFunctionName
ff logs <name>                                # its log: --follow for the new lines as they come
ff delete-stack {{name}}                      # the stack, with what it made
```

The next deploy changes what the template changed, and deletes what it no longer has after asking; in a script, say
`--yes`. `--parameter-overrides Stage=prod` gives a parameter its value in place of samconfig.toml's.

The template is SAM's, the subset FF takes (`ff doctor template.yaml` says what is outside it), and the handler is AWS
Lambda's: `sam deploy` takes the same folder to AWS, `resolve_s3` and `capabilities` in samconfig.toml for AWS alone.
