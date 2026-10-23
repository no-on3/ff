# ADR 0009: Buckets behind FF's S3 front door

| | |
|---|---|
| **Status** | Accepted: the [step-2 plan](../step-2-plan.md)'s D6 to D8, and its choices for buckets (its §9), confirmed by you on 2026-10-22; measured by V-01's spike on 2026-10-23 |
| **Date** | 2026-10-23 |
| **Implementation** | Step-2 plan: decisions D6 to D9, D11 and D12; tasks V-06 to V-09 |
| **Related** | [Parent plan](../local-markets-and-aws-portability-plan.md): E-04 (the S3 front door), E-07 (execution credentials), ADR-002 (the S3 engine), §4.7, §6.7; [What to build next](../what-to-build-next.md) §5.2; the spike, [`hack/spikes/data-services`](../../hack/spikes/data-services/README.md) |

## Context

Customers' apps need somewhere to keep files: uploads, images, exports. FF already runs an S3 store for its own objects, SeaweedFS in development and whatever S3 the operator runs in production (the parent's ADR-002). Customers' buckets go on that store, and customers use AWS's own SDKs and CLI with only the endpoint changed, so that their code moves to S3 with nothing changed.

The store can't face customers by itself:
- **Its access control is its own,** different from one engine to another: SeaweedFS's identities are a file, Ceph's users another API, a managed S3 a third.
- **FF must decide each request:** the key's account and buckets, the account's status and credit, the plan's rate and sizes, and later (step 3) a function to run when a file lands.
- **FF must count each request** by AWS's two classes, and each byte, to bill them.

So a front door of FF's own stands in front of the store (D6). Before building it, the spike measured what today's clients send and whether a small Node.js server can take it: a minimal front door (`front-door.mjs`, Node.js's standard library only) in front of SeaweedFS 4.48, against AWS's SDK for JavaScript v3 3.1156.0, boto3 1.43.118 and the AWS CLI 2.34.32, each with its defaults, given only an endpoint, a region and a key. **55 checks passed**: puts of strings, buffers and streams, odd keys, ranges, listings with pages, prefixes and delimiters, copies, multipart uploads (the SDK's `lib-storage`, boto3's transfers, the CLI's), presigned GET and PUT, expired and tampered URLs, a wrong secret, another account's bucket, an unsupported operation, `aws s3 sync` both ways.

### What the clients send, measured

| | SDK for JavaScript v3 | boto3 | AWS CLI v2 |
|---|---|---|---|
| Addressing, for an endpoint with a host name | virtual-hosted, `<bucket>.<host>` | path-style, `<host>/<bucket>` | path-style |
| For an endpoint that is an IP address | path-style, by itself | path-style | path-style |
| A body it holds whole (a string, a buffer, a part) | its SHA-256 signed, and a CRC-32 in `x-amz-checksum-crc32` | the same | its SHA-256 signed, and a CRC-64/NVME in `x-amz-checksum-crc64nvme` |
| A stream | `aws-chunked`, `STREAMING-UNSIGNED-PAYLOAD-TRAILER`, its CRC-32 in a trailer, **even over plain HTTP** | (reads it whole) | (multipart) |
| A presigned upload URL | signs `x-amz-checksum-crc32=AAAAAA==`, the CRC-32 of an empty body, into it | no checksum | no checksum |

None of the three sent the signed chunked bodies (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`, with or without a trailer), which other SDKs (Java's, Go's) send over plain HTTP.

### Throughput and memory, on this machine

| 200 MB of random bytes | Upload | Download |
|---|---|---|
| The AWS CLI to SeaweedFS directly (8 MB parts, 10 at a time) | 206 MB/s | 235 MB/s |
| The AWS CLI through the front door | 184 MB/s | 238 MB/s |
| The SDK for JavaScript, one 200 MB stream, to SeaweedFS directly | 109 MB/s | |
| The same, through the front door | 201 MB/s | |

The numbers move by a third from run to run on a laptop shared with other work; through the front door they stay in the store's range, every body's signature and checksum checked on the way. Its memory stayed flat: 128 MB resident after the checks, 153 MB after a gigabyte of transfers, 166 MB at its peak. It holds no body: each is streamed to the store as it comes, and the store's answer back as it comes.

## Decision

### 1. One front door, in the backend, in front of any store
A server of the backend's own, on a port of its own (`FF_STORAGE_PORT`), as the function URLs' is, at `s3.<domain>` and `<bucket>.s3.<domain>` behind the edge. It answers customers itself, with AWS's XML errors, and talks to the store with FF's own credentials, the only ones the store knows. Customers' keys never reach the store. Whatever store is behind it serves, with nothing asked of its own access control: production's S3 needs to make and delete buckets and serve the object API, nothing more.

### 2. AWS Signature Version 4, as S3 checks it
- **In the `Authorization` header or as a presigned URL** (`X-Amz-*` in the query), with the account's keys (D7) or a function's (D8). Nothing anonymous: public buckets are step 4's.
- **The canonical request as S3 makes it:** the path encoded once, nothing normalized; the query sorted; the signed headers' values trimmed. The time within 15 minutes; a presigned URL from 1 second to 7 days, refused past its expiry.
- **Any region in the scope** signs: the key is the secret, not the region. `GetBucketLocation` answers FF's own (`FF_REGION`, `tn-tunis-1`).
- **A body is checked before the store has it whole:** a signed SHA-256 as the body streams, every chunk's signature of a signed `aws-chunked` body in its chain, the trailer's signature, the decoded length. A body that fails is cut before its end, so the store never completes the object, and the client gets S3's error (`XAmzContentSHA256Mismatch`, `SignatureDoesNotMatch`, `IncompleteBody`).
- **The four `aws-chunked` forms:** signed or not, with a trailer or not. The JavaScript SDK's form is the one measured; V-06 tests the signed ones with AWS's own documented examples.

### 3. Checksums, as S3 checks them
- **CRC-32, CRC-32C, CRC-64/NVME, SHA-1 and SHA-256,** in a header or a trailer, computed by the front door as the body streams and compared before the upload completes (`BadDigest`). The store gets no checksum header: what stores do with them differs from one engine and version to another, and the front door's check is the one that answers the client as S3 would.
- **A presigned URL's checksum parameters are signed, then ignored,** as S3 does: the JavaScript SDK's presigner signs the CRC-32 of an empty body into every presigned upload URL (measured), and S3 answers those uploads 200, as other S3-compatible projects found ([ministack](https://github.com/ministackorg/ministack/pull/1705), [objectstack](https://github.com/objectstack-ai/objectstack/issues/21147)); SeaweedFS checks it, and refused every such upload with `BadDigest` until the front door stopped passing it on. FF can't check S3 itself without an AWS account: the parent plan's monthly test against AWS (§6.10, its third target) does, once FF has one.

### 4. Both addressings, and an IP address for functions
- **Customers outside** use `https://s3.<domain>`, which the SDK for JavaScript addresses virtual-hosted (`https://photos.s3.ffunc.tn/…`) and boto3 and the CLI path-style (`https://s3.ffunc.tn/photos/…`): both are served. The edge needs a certificate for each bucket's host, the two ways function URLs get theirs: one for `*.s3.<domain>` by DNS, or one per bucket on demand, asked of the backend first. On demand, buckets and function URLs share Let's Encrypt's weekly allowance for the domain: decision 17 (who hosts FF's DNS) answers it.
- **Functions** get an endpoint that is an IP address inside the cluster (D8): every SDK then addresses it path-style by itself (measured), so no DNS name of FF's is needed for buckets inside the cluster, and the JavaScript SDK, which has no setting outside the code for path-style, works with `new S3Client({})`. Inside the cluster it is plain HTTP, as the backend's calls to functions are; outside, HTTPS at the edge.

### 5. Buckets: AWS's names, the store's own names
A bucket's name follows AWS's rules (3 to 63 lower-case letters, digits and hyphens; no dots, so that its virtual-hosted host keeps the wildcard certificate) and is unique across FF, free again once deleted. In the store, each bucket has a name of FF's (`ff-` and random characters), so that the store's names say nothing of the customer, and a name deleted is free at once whatever the store does with its own. Every XML answer that names a bucket (a listing's `Name`, a multipart upload's `Bucket` and `Location`) names the customer's, measured with the three clients.

### 6. What is served
`PutObject`, `GetObject` with ranges, `HeadObject`, `DeleteObject`, `DeleteObjects`, `CopyObject` (its source checked as a read of the key's), `ListObjectsV2` (and the older `ListObjects`), the multipart upload (`CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `ListParts`, `ListMultipartUploads`), `HeadBucket`; `ListBuckets` and `GetBucketLocation` answered by FF from its own tables. Anything else answers `NotImplemented` (501), measured with `PutBucketPolicy`.

### 7. Counted as AWS bills
Each answered request counts in its bucket's minute, by AWS's classes: `PUT`, `COPY`, `POST` and `LIST` (and multipart's parts) in the first; `GET`, `HEAD` and the others in the second; `DELETE` and the abort of an upload free, as S3's price list says. `DeleteObjects` is a `POST` that deletes, which the price list doesn't name: it is counted as a delete, free, until V-09 settles how AWS bills it. With the bytes in and out. The counts are flushed once a minute, one row per bucket, minute and class (D9), never a row per request.

### 8. A bucket's size: its listing, walked every hour
The hourly sample sums the sizes in the bucket's listing, through the store's own S3 API: 10,000 objects took 0.37 s, 11 pages of 1,000, so a bucket of a million objects takes about half a minute. SeaweedFS's own count (`weed shell`'s `s3.bucket.list`) is faster, but it counts its stored chunks, deduplicated (879 MB where the objects add up to 891 MB) and with deleted bytes until a vacuum, and only SeaweedFS has it: S3 bills the objects' sizes, which the listing gives on any store. As built (V-09): `StoreBuckets.measure()`, the listing's sizes summed and its objects counted, into `bucket_samples` once an hour per bucket; an upload under way isn't an object yet, and isn't counted. The account's buckets are measured together, so that they are weighed against the plan's storage at once, and every minute while they are full.

## Consequences

- **V-06 builds the front door in the backend,** in TypeScript, from the spike's: tested against AWS's SigV4 test vectors, the four `aws-chunked` forms, each checksum, and the requests the three clients sent here; then end to end with the three clients themselves, through the backend. As built: AWS's documented examples, the SDK for JavaScript against it with a store in memory, then in front of SeaweedFS; the three clients end to end with V-07, which makes their keys. One change from the spike's: a body's last piece waits for its checks, as checking at the end let the store complete a failed body, which had every byte its length announced.
- **CRC-64/NVME and CRC-32C** come from AWS's own package, `@aws-sdk/checksums`, which the backend's SDK already brings, made a direct dependency; CRC-32 and the SHA ones from Node.js.
- **The edge** gains `s3.<domain>` and `*.s3.<domain>`, sent to the backend's storage port, with their certificates as function URLs get theirs (decision 17).
- **Functions reach it inside the cluster,** with their account's internet access off: a NetworkPolicy rule to the backend's storage port, as databases have theirs (ADR 0008). As built (V-08): each function's key is made at its first deploy, one that works at most a function, and revoked when it is deleted; its pods get it in their environment's Secret with `AWS_REGION`, `AWS_DEFAULT_REGION` and `AWS_ENDPOINT_URL_S3`, which FF reserves, and a new key rolls them out as a new environment does. The address is the backend's `FF_STORAGE_FUNCTION_ENDPOINT`: in production the Service `ff-storage`'s fixed one, `10.43.0.251:3002`, each tenant's rule then opening the backend's own pods and the backend's NetworkPolicy letting functions in on that port alone; in development and L4, this machine at the gateway of the cluster's Docker network, its address in `FF_STORAGE_FUNCTION_CIDRS`. Measured end to end: `new S3Client({})` in a Node.js function and `boto3.client("s3")` in a Python one, from packages as npm and pip install them, write to their account's bucket and are refused another's; and on the platform's own cluster, the backend in it, through `ff-storage` inside gVisor.
- **Presigned uploads from the JavaScript SDK work as on S3,** with its defaults; on a store that checks a presigned URL's checksum, they would not.
- **Bucket notifications** (step 3) start here: the front door sees every write.

## Alternatives considered

- **The store's own users, one per account.** Each engine's API differs, none counts requests by AWS's classes, and none knows an account's credit or suspension; and FF would hand customers keys of the store itself.
- **A front door in another process, in Go** (the parent's ADR-004 for its gateway). Measured, Node.js streams at the store's speed with flat memory; a process of its own stays possible later, as the parent's R-05 keeps it for the function URLs.
- **One addressing only.** Path-style alone breaks the SDK for JavaScript's default with a host name; virtual-hosted alone breaks boto3's and the CLI's.
- **FF's region only in signatures.** It would refuse a client left on `us-east-1` for nothing: the region in a signature protects nothing.
- **The store's own size count.** Faster, but not what S3 bills, and SeaweedFS's alone.
