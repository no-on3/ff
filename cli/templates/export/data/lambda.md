# Your FF functions, to AWS Lambda

FF's functions are AWS Lambda's: the same handler, the same events, the same limits. A function moves with its code as it is, built for Lambda in `code/`, and its settings under Lambda's names in `template.yaml`, which the SAM CLI deploys. What changes is around the code: its key becomes a role, FF's endpoints leave its environment, a URL's callers sign with AWS's keys rather than FF's, and your domains reach it through CloudFront.

## What you need

- **This export:** `template.yaml`, `code/`, `secrets.template.env` (the values its parameters take) and `MIGRATION.md` (the order of the move).
- **An AWS account, the AWS CLI and the SAM CLI,** with the rights to make Lambda functions, IAM roles, SQS queues, S3 buckets and EventBridge rules.
- **Lambda's quotas,** in the console's Service Quotas: a new account's concurrency can start at 10, for all its functions together. Ask for more before you move, by what `MIGRATION.md` counts.

## What each becomes

| On FF | On AWS | In `template.yaml` |
|---|---|---|
| A function in Node.js or Python | `nodejs24.x` or `python3.13`: FF's runtimes are Node.js 24 and Python 3.13 | `AWS::Serverless::Function`, `Runtime` |
| Its code, inline or a package | Its zip: inline TypeScript as the JavaScript FF's runtime ran (`function.js`, still `function.handler`), a package as you uploaded it | `CodeUri: code/<function>.zip`, `Handler` |
| Its memory and timeout | The same, in MB and seconds | `MemorySize`, `Timeout` |
| Its variables | Its variables | `Environment.Variables`, from parameters unless exported `--with-values` |
| Its secrets, which FF never shows back | Variables from parameters CloudFormation doesn't echo, or Secrets Manager | `NoEcho` parameters, listed in `secrets.template.env` |
| `minInstances`, instances kept warm | Provisioned concurrency, on an alias, billed by the hour while it is set | `AutoPublishAlias: live`, `ProvisionedConcurrencyConfig` |
| `maxInstances`, when not FF's 3 | Reserved concurrency, taken from the account's quota | `ReservedConcurrentExecutions` |
| A URL, open or for FF's API keys | A function URL, `NONE` or `AWS_IAM`. On AWS, `AWS_IAM` takes a request signed by an IAM user or role allowed to call it; FF's API keys don't work there | `FunctionUrlConfig`, with its CORS; its address in `Outputs` |
| Your domains on a URL | A CloudFront distribution in front of the function URL, with a certificate of ACM's | Not there: below |
| A schedule | An EventBridge rule, the same expression, in UTC, with its input or EventBridge's Scheduled Event | `Events`, `Type: Schedule` |
| A queue it reads, its calls that don't wait, a bucket's events | As [`sqs.md`](sqs.md) says | `Events` of `Type: SQS` and `S3`, `EventInvokeConfig` |
| The function's key, given to its code | Its execution role: AWS's SDKs find its credentials in the environment Lambda gives | A role SAM makes, with `Policies` for what the key used on FF |
| FF's endpoints, `AWS_ENDPOINT_URL_S3`, `_SQS` and `_SESV2` | None: AWS's SDKs reach AWS's own | Not there |
| Its log, `ff logs` | CloudWatch Logs, `/aws/lambda/<function>`, or `sam logs` | |
| Its metrics and alarms | CloudWatch's `AWS/Lambda`, the same names (`Invocations`, `Errors`, `Duration`, `Throttles`, `ConcurrentExecutions`), and its alarms | |

The code needs nothing new: AWS's SDKs read the region and the credentials Lambda gives, as they read FF's.

A function's role allows what its key used of the account's buckets, queues and mail on FF, which FF notes a day at a time: SAM's policy templates where the function did what one is for (`S3ReadPolicy`, `S3CrudPolicy`, `SQSSendMessagePolicy`, `SQSPollerPolicy`…), each on its one bucket or queue, and statements for the rest, such as `ses:SendEmail` on the identity it sends as. A use FF never saw, such as a monthly job's, AWS refuses with `AccessDenied` until the function's `Policies` allow it.

## Deploying

1. **Check the template:** `sam validate --lint --region eu-west-3`, or the region you choose.
2. **Deploy it,** from this folder: `sam deploy --guided` asks for the stack's name, the region, each parameter (the secrets without echo), and leave to make the functions' roles; it uploads each zip of `code/` to a bucket of its own, then makes the stack. It saves your answers in `samconfig.toml`, the secrets left out; `sam deploy` alone then deploys again.
3. **Call each function:** `sam remote invoke <its logical ID> --stack-name <stack> --event '{"name": "Tunis"}'`, its log in `sam logs --stack-name <stack> --tail`; a URL with `curl`, its address in the stack's outputs (`sam list stack-outputs --stack-name <stack>`).

## Your domains on a URL

A function URL answers at its own host alone, `<id>.lambda-url.<region>.on.aws`. Your domain reaches it through a CloudFront distribution whose origin is that host, which caches nothing and passes every header but `Host`, as the URL answers its own name only. `url-domain.yaml`, for CloudFormation:

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: Your domain in front of a function URL, as FF's custom domains are
Parameters:
  UrlHost:
    Type: String
    Description: The function URL's host, such as abc123.lambda-url.eu-west-3.on.aws
  Domain:
    Type: String
    Description: Your domain, such as api.shop.tn
  Certificate:
    Type: String
    Description: The ARN of ACM's certificate for it, in us-east-1
Resources:
  Front:
    Type: AWS::CloudFront::Distribution
    Properties:
      DistributionConfig:
        Enabled: true
        HttpVersion: http2and3
        Aliases: [!Ref Domain]
        ViewerCertificate:
          AcmCertificateArn: !Ref Certificate
          SslSupportMethod: sni-only
          MinimumProtocolVersion: TLSv1.2_2021
        Origins:
          - Id: url
            DomainName: !Ref UrlHost
            CustomOriginConfig:
              OriginProtocolPolicy: https-only
              OriginSSLProtocols: [TLSv1.2]
        DefaultCacheBehavior:
          TargetOriginId: url
          ViewerProtocolPolicy: redirect-to-https
          AllowedMethods: [GET, HEAD, OPTIONS, PUT, PATCH, POST, DELETE]
          CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad          # AWS's managed CachingDisabled
          OriginRequestPolicyId: b689b0a8-53d0-40ab-baf2-68738e2966ac  # AWS's managed AllViewerExceptHostHeader
Outputs:
  Address:
    Value: !GetAtt Front.DomainName
```

1. **A certificate for the domain,** in `us-east-1`, CloudFront's region: `aws acm request-certificate --region us-east-1 --domain-name api.shop.tn --validation-method DNS`, and the CNAME it gives published, to prove it.
2. **The distribution:** `aws cloudformation deploy --template-file url-domain.yaml --stack-name api-domain --parameter-overrides UrlHost=<the URL's host> Domain=api.shop.tn Certificate=<its ARN>`.
3. **Point the domain at it:** its CNAME to the distribution's `d….cloudfront.net` (the stack's `Address`) instead of FF's: callers move as their DNS caches expire, both answering until then.

An `AWS_IAM` URL behind CloudFront takes CloudFront's own signature, an origin access control of type `lambda`, and a permission that lets CloudFront call the URL; a caller's own signature doesn't pass through it.

## Moving

`MIGRATION.md` gives the order with this account's functions: deploy, call each on AWS, then move its callers (a URL's callers to its new address, your domains' DNS, the schedules turned on there and off on FF), and delete it on FF once nothing calls it there.
