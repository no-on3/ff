# Sites spike

The measurements behind [ADR 0011](../../../docs/adr/0011-static-sites.md) (step 4's static sites): the [step-4 plan](../../../docs/step-4-plan.md)'s W-01, its first half. One script:

```bash
hack/spikes/sites/website.sh                      # about a minute
ASSETS=60 SMALL=2000 hack/spikes/sites/website.sh # a bigger site
```

It needs Docker, the AWS CLI, Node.js 22 or later, `jq` and Python 3. Its work files go to `hack/.spike-sites/`, which git ignores.

- **The store:** SeaweedFS 4.48, FF's own, in a container removed on exit, holding a built site uploaded with `aws s3 sync`: an index, a folder with its own, an error document, `ASSETS` (30) hashed assets of about 100 KB, `SMALL` (500) small files, one large file (50 MB), and a file stored without a type; beside it another bucket, whose file no path of the first must reach.
- **`website-server.mjs`,** a website server as the backend's would be, Node.js's standard library only: GET and HEAD, signed requests to the store (`sign.mjs`, as the backend's `StoreClient` signs its own), a folder's index document, a folder named without its slash redirected to it, the error document with 404 or, for a single-page app, the index document with 200, the browser's conditions and ranges passed to the store, the stored type or one by the file's name, nosniff. Two run, a single-page app's and a plain site's.
- **`load.mjs`:** what each path answers; then a site's first load as a browser makes it over HTTP/1.1 (the index, then its assets six at a time), twenty times, through the server and from the store directly; 500 small files, fifty at once; one large file streamed; and paths with dot segments sent as written, to the store with FF's credentials and to the server, whether any reaches the other bucket's file.

What was measured, and what it decided, is in ADR 0011.
