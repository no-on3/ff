# ADR 0011: Static sites, a bucket's files served by the backend

| | |
|---|---|
| **Status** | Accepted: the [step-4 plan](../step-4-plan.md)'s D1 to D3, and its choices (its §9), confirmed on 2026-10-30; how a bucket's files reach browsers, measured by W-01's spike the same day |
| **Date** | 2026-10-30 |
| **Implementation** | Step-4 plan: decisions D1 to D3; tasks W-02 and W-03 |
| **Related** | [ADR 0009](0009-buckets.md) (buckets, the S3 front door); [What to build next](../what-to-build-next.md) §7; the spike, [`hack/spikes/sites`](../../hack/spikes/sites/README.md) |

## Context

Step 4 lets a customer move a whole app to FF, its built frontend first: the files a build makes (`index.html`, hashed assets, images), public to read at an address of FF's or the customer's own domain, over HTTPS. AWS gives this as S3's website hosting (a bucket's website configuration: its index document, its error document), most often with CloudFront in front for HTTPS, a custom domain and single-page apps.

FF's buckets (ADR 0009) are never anonymous: every request to the S3 front door is signed. FF's own apps are Vite builds baked into their images, each served by a Caddy of its own. The store is SeaweedFS behind the front door, under FF's names for buckets.

### A bucket's files served by the backend, measured

`hack/spikes/sites/website.sh`: SeaweedFS 4.48 (FF's), holding a built site uploaded with `aws s3 sync` (an index, a folder with its own, an error document, 30 hashed assets of about 100 KB, 500 small files of 2 KB, one file of 50 MB, one stored without a type) and another bucket beside it; `website-server.mjs`, a website server as the backend's would be (Node.js's standard library, signed requests to the store), twice, a single-page app's and a plain site's. On this machine (8 CPUs, shared, its load about 2 to 4.5 during the runs), the second of two runs, the first's under more load in brackets:

| Measure | Through the website server | From the store directly |
|---|---|---|
| A site's first load, as a browser makes it over HTTP/1.1: the index, then its 30 assets six at a time; 20 runs | median 65 ms (125), p95 82 ms (208) | median 80 ms (144), p95 114 ms (275) |
| 500 small files, fifty at once | 869 a second (507); p50 4.5 ms, p95 391 ms | 1,013 a second (617); p50 6.4 ms, p95 362 ms |
| One file of 50 MB, streamed | 285 MB/s (121) | 948 MB/s (332) |
| The server's memory | 60 MB before, 145 MB after 1,164 requests and 119 MB sent | |

16 of its 17 checks as wanted: a folder's path answers its index document; a folder named without its slash redirected to it (302); a plain site's unknown path its error document with 404, a single-page app's its index document with 200; an asset's stored type kept; the browser's ETag answered 304, a range 206, HEAD its length without a body; POST refused (405); `nosniff` on every answer; and paths with dot segments (`..`, `%2E%2E`, `..%2F`, `./..`), sent as written, never reaching the other bucket's file, neither through the server, which refuses them itself, nor from the store, which answers 400 to each.

### Found

- **SeaweedFS types an object put without a type from its bytes,** as Go's `DetectContentType` does: the style sheet stored without one came back `text/plain; charset=utf-8`, which a browser told `nosniff` refuses as a style sheet. S3 stores `binary/octet-stream` instead, which says nothing, so a site's server may type the file by its name. The 17th check is this one.
- **The AWS CLI types files by their names,** with Python's `mimetypes`: `text/html` without a charset, `text/javascript` for scripts. A built page names its charset in its `<meta>`, as Vite's do.
- **The backend in the path costs nothing a visitor sees** for a site's pages and assets: its first loads were as fast as the store's own. One large file streams at a third of the store's speed, still more than a visitor's link carries.

## Decision

### 1. A site is a bucket with S3's website configuration

As S3's, set by `PutBucketWebsite` at the S3 front door in S3's XML, or by FF's API in its JSON names: the index document, the error document, and one setting of FF's, as CloudFront's custom error responses give it: an unknown path answers the index document with 200, for single-page apps. Its files are then public to read at its site's address alone; its S3 API stays signed. No bucket policy, ACL or "Block public access": the website configuration is the public switch. Redirects and routing rules: later.

### 2. The website server: the backend's fourth front door

A server of the backend's own, on a port of its own (`FF_WEBSITE_PORT`, 3004), behind the edge, as the S3 front door and the SQS endpoint are; never Caddy's file server, which would need a module of its own to read the store under FF's names, and couldn't check the account or count. `GET` and `HEAD` alone; a folder's index document, a folder named without its slash redirected to it, the error document with 404, or the index document with 200 for a single-page app; the browser's conditions and ranges passed to the store, its `ETag` and `Last-Modified` back; the type stored, or one by the file's name when the stored one says nothing (none, `binary/octet-stream`, `application/octet-stream`); `nosniff`; no cookie. A path with a dot segment, escaped or not, is refused before the store.

**The S3 front door stores an object written without a type as S3 does,** `binary/octet-stream` (a `PutObject`, a `CreateMultipartUpload`, a `CopyObject` that replaces its source's metadata), so that the store's guess never reaches a site.

A site's requests are counted as its bucket's reads, of their own class (`website`), billed as S3's second class, with the bytes they send; the plan limits the bytes an account's sites send a month.

### 3. Addresses and certificates

`https://<bucket>.site.<domain>/`: buckets' names are unique across FF and have no dots, so each makes a host. The edge's certificate for them as for function URLs and buckets: one for `*.site.<domain>` through DNS where FF's DNS allows it (the decision log, 17), else one per site on demand, once the backend says the bucket is a site.

A customer's own domain for a site is proved as a function URL's is, a CNAME to the site's host or a TXT record with the edge's addresses, and its certificate made on demand; a domain serves a function's URL or a site, one in an account, and the plan's custom domains count both.
