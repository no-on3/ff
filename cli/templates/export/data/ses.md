# Your FF mail, to Amazon SES

FF's mail is Amazon SES v2's API: your code calls `SendEmail` with AWS's SDKs, `AWS_ENDPOINT_URL_SESV2` naming FF's endpoint. On AWS the same code calls SES itself, with no endpoint at all. Your domains move as SES's identities with DKIM keys of SES's own, published beside FF's so that both sign while you move, and your suppression list goes with them. SES has a sandbox of its own, which you ask AWS to lift.

## What you need

- **What you have on FF,** each as JSON: `ff email identities`, `ff email get <domain>` for each domain, and `ff email suppressions` (each with `--output json`).
- **An AWS account and the AWS CLI,** in the region you'll send from: SES's identities, quotas and suppression list are a region's.
- **Your domains' DNS,** to publish SES's records beside FF's.

## What each becomes

| On FF | On SES |
|---|---|
| A domain, proved by FF's DKIM key, its TXT record under the selector `ff…` | An identity of SES's, proved by its Easy DKIM: three CNAME records under selectors of their own, beside FF's |
| An address, proved by FF's link | An address identity, proved by SES's own link; out of the sandbox, a domain's identity covers its addresses, as on FF |
| The return path, `bounces.mail.<domain>`, its MX and SPF | A custom MAIL FROM domain, such as `ses.<domain>`: its MX `10 feedback-smtp.<region>.amazonses.com`, its SPF `v=spf1 include:amazonses.com ~all` |
| DMARC's record | The same, unchanged |
| The suppression list | SES's suppression list for the account, the same addresses and reasons |
| The sandbox, lifted by FF's operator | SES's own, lifted by AWS on request |
| The plan's quotas, 200 a day and 1 a second on beta | SES's, raised by AWS on request |
| `GET /email/metrics`, and alarms on them | CloudWatch's `AWS/SES` metrics, the same names, and its alarms |
| What became of each recipient, 30 days | A configuration set's event destinations (CloudWatch, EventBridge, SNS, Firehose), if you want them |

FF never gives out its DKIM private key: SES's keys replace it.

## Moving

1. **Make each domain an identity of SES's,** and publish its three CNAME records: `<token>._domainkey.<domain>` to `<token>.dkim.amazonses.com`. FF's TXT record stays until the end: two selectors, two keys, each valid, and DMARC passes with either.

   ```bash
   aws sesv2 create-email-identity --email-identity shop.example.tn
   aws sesv2 get-email-identity --email-identity shop.example.tn --query 'DkimAttributes.Tokens' --output text
   ```

2. **Its MAIL FROM domain,** which brings SES's bounces back to SES, apart from FF's `bounces.mail.<domain>`; publish its MX and SPF:

   ```bash
   aws sesv2 put-email-identity-mail-from-attributes --email-identity shop.example.tn \
     --mail-from-domain ses.shop.example.tn --behavior-on-mx-failure USE_DEFAULT_VALUE
   ```

3. **The suppression list,** so that SES never sends to an address that bounced or complained on FF:

   ```bash
   ff email suppressions --output json | jq -r '.[] | "\(.address) \(.reason)"' |
     while read -r address reason; do
       aws sesv2 put-suppressed-destination --email-address "$address" --reason "$reason"
     done
   ```

4. **Out of SES's sandbox:** its console's "Request production access", which asks what you send and to whom; AWS answers within a day or so. Until then SES sends only to the addresses you proved there.
5. **Point the code at SES:** drop `AWS_ENDPOINT_URL_SESV2`. On AWS Lambda, the function's role may `ses:SendEmail` from its identities, and `ses:SendRawEmail` if it sends raw messages; the SDK finds the region and the credentials as any. Check the first messages' headers at a mailbox of yours: `DKIM-Signature` under SES's selector, and `dkim=pass` where it arrives.
6. **Then, on FF:** `ff email delete <domain>` for each, and take FF's records away from your DNS: its DKIM TXT record, and `bounces.mail.<domain>`'s MX and SPF. Keep DMARC's.

## What doesn't move

- **The messages,** and what became of each recipient: FF keeps them 30 days. `ff email messages --limit 100 --output json` gives the latest, if you want them kept.
- **The reputation:** SES judges yours from its own sending, as FF did from its own. Send at your usual pace from the start, without a burst.
