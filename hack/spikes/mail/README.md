# Mail spike

The measurements behind [ADR 0012](../../../docs/adr/0012-customer-mail.md) (step 4's e-mail from apps): the [step-4 plan](../../../docs/step-4-plan.md)'s W-01, its SES and DKIM halves. Two scripts:

```bash
hack/spikes/mail/ses.sh    # about a minute; npm and pip fetch the SDKs the first time
hack/spikes/mail/dkim.sh   # about a minute; builds its Postfix image and fetches mailauth the first time
```

They need Docker, the AWS CLI, Node.js 22 or later (`dkim.sh` uses nodemailer from `BE/node_modules`: `npm install` in `BE` first), `jq`, OpenSSL and Python 3. Their work files go to `hack/.spike-mail/`, which git ignores.

## SES v2's API (`ses.sh`)

- **`ses-endpoint.mjs`,** a minimal Amazon SES v2 endpoint, Node.js's standard library only: SES v2's REST API in JSON, AWS Signature Version 4 for the service `ses` with one key, identities, the account, the suppression list and `SendEmail` in memory, its errors as AWS's REST JSON protocol gives them (the error's name in `x-amzn-ErrorType`, a JSON body with its message). It counts how each request's path was signed: escaped once, as S3's are, or twice, as AWS's rule for every other service says.
- **The clients,** each with its endpoint from `AWS_ENDPOINT_URL_SESV2` alone, a region and a key, as a function's code would have FF's: AWS's SDK for JavaScript v3 (`ses-sdk-check.mjs`, `@aws-sdk/client-sesv2` 3.1152.0), boto3 1.43.118 (`ses_boto3_check.py`), and the AWS CLI. Each: a domain and an address made as identities, one already there refused, one read back by its address (an `@` escaped in the path), one not there refused, the list in pages, `SendEmail` simple and raw, one from a domain not verified refused, the account's quotas, the suppression list, a wrong secret refused.

## A customer's DKIM signature through a Postfix (`dkim.sh`)

- **The key,** RSA 2,048 bits, as FF would make one for a customer's domain; its public half as the TXT record FF would give the customer.
- **The sender** (`send.mjs`): nodemailer, as the backend has it, signing each message with that key, handing it to a Postfix of its own (Alpine 3.24.2's, `postfix/`) with a return path that names the message (VERP).
- **Postfix** relays every message to the spike's receiving server (`receiver.mjs`, Node.js's standard library only), which keeps what it takes and refuses one address as a mailbox that doesn't exist; what comes back for the return path's domain, the bounce, stays in one mailbox.
- **At the other end** (`verify.mjs`, mailauth 7.3.0 as a mailbox provider would check): each message's signature against the public key, then the same message with its subject changed, which must fail; and the bounce, read as a delivery status report: whose, which address, why.

What was measured, and what it decided, is in ADR 0012.
