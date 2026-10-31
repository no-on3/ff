# Your FF site, to S3 and CloudFront

An FF site is a bucket with S3's website configuration, served over HTTPS at `<bucket>.site.<domain>` and at your own domains. On AWS it becomes an S3 bucket behind a CloudFront distribution, which gives the HTTPS, your domains and the single-page setting. The files move with the AWS CLI, nothing of FF's in between; your code doesn't change, its pages being files.

## What you need

- **The built folder you deploy,** such as `./dist`: uploading it again is simpler than copying the bucket, and gives each file its cache header. Without it, the first half of [`s3-sync.sh`](s3-sync.sh) copies the bucket's files to a folder, with a read-only key of FF's (`ff buckets keys create --bucket <bucket> --read-only`).
- **What the site is on FF:** `ff sites get <bucket> --output json`, its index document, its error document and whether it is a single-page app; `ff sites domains list <bucket>`, your domains.
- **An AWS account and the AWS CLI,** and for your domains a certificate of AWS Certificate Manager in `us-east-1`, CloudFront's region, that names them.

## What each becomes

| On FF | On AWS |
|---|---|
| The bucket's files | The same keys in an S3 bucket, private, read by CloudFront alone through an origin access control |
| The index document, `index.html` | CloudFront's default root object for `/`, and a CloudFront Function for a folder's path |
| The error document, `404.html`, answered with 404 | A custom error response: 403 and 404 answer `/404.html` with 404 (S3 answers 403 for a key that isn't there, as CloudFront may not list the bucket) |
| A single-page app (`ff sites deploy --spa`) | A custom error response: 403 and 404 answer `/index.html` with 200 |
| `<bucket>.site.<domain>` | The distribution's `d….cloudfront.net` |
| Your domains, proved by a CNAME | The distribution's alternate domain names with ACM's certificate, and the same CNAME, to `d….cloudfront.net` |
| A year and `immutable` for hashed assets, `no-cache` for the rest | The same `Cache-Control`, set at upload, which CloudFront and browsers read |
| Each visit counted as a GET, the bytes sent limited each month | CloudFront's requests and data out, billed |
| `GET /buckets/<bucket>/website/metrics`, alarms on them | CloudFront's metrics, the same names (`Requests`, `BytesDownloaded`, `4xxErrorRate`, `5xxErrorRate`, `TotalErrorRate`), and CloudWatch's alarms |

## A template, the pieces together

`site.yaml`, for CloudFormation: the bucket, the distribution reading it, the function that answers a folder's path with its index document, and the error responses. `SinglePageApp` says which error response; `Domains` and `Certificate` are your domains and ACM's certificate for them, both empty until you move them.

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: An FF site, as S3 and CloudFront serve it
Parameters:
  SinglePageApp:
    Type: String
    AllowedValues: ['true', 'false']
    Default: 'false'
  Domains:
    Type: CommaDelimitedList
    Default: ''
    Description: Your domains, such as www.shop.tn; empty for none
  Certificate:
    Type: String
    Default: ''
    Description: The ARN of ACM's certificate for them, in us-east-1
Conditions:
  Spa: !Equals [!Ref SinglePageApp, 'true']
  HasDomains: !Not [!Equals [!Ref Certificate, '']]
Resources:
  Files:
    Type: AWS::S3::Bucket
    Properties:
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true
  ReadAccess:
    Type: AWS::CloudFront::OriginAccessControl
    Properties:
      OriginAccessControlConfig:
        Name: !Sub '${AWS::StackName}-files'
        OriginAccessControlOriginType: s3
        SigningBehavior: always
        SigningProtocol: sigv4
  FolderIndex:
    Type: AWS::CloudFront::Function
    Properties:
      Name: !Sub '${AWS::StackName}-folder-index'
      AutoPublish: true
      FunctionConfig:
        Comment: A folder's path answers its index document, as FF's website server does
        Runtime: cloudfront-js-2.0
      FunctionCode: |
        function handler(event) {
          var request = event.request;
          if (request.uri.endsWith('/')) request.uri += 'index.html';
          return request;
        }
  Site:
    Type: AWS::CloudFront::Distribution
    Properties:
      DistributionConfig:
        Enabled: true
        DefaultRootObject: index.html
        HttpVersion: http2and3
        Aliases: !If [HasDomains, !Ref Domains, !Ref AWS::NoValue]
        ViewerCertificate: !If
          - HasDomains
          - AcmCertificateArn: !Ref Certificate
            SslSupportMethod: sni-only
            MinimumProtocolVersion: TLSv1.2_2021
          - !Ref AWS::NoValue
        Origins:
          - Id: files
            DomainName: !GetAtt Files.RegionalDomainName
            OriginAccessControlId: !GetAtt ReadAccess.Id
            S3OriginConfig:
              OriginAccessIdentity: ''
        DefaultCacheBehavior:
          TargetOriginId: files
          ViewerProtocolPolicy: redirect-to-https
          CachePolicyId: 658327ea-f89d-4fab-a63d-7e88639e58f6   # AWS's managed CachingOptimized
          FunctionAssociations:
            - EventType: viewer-request
              FunctionARN: !GetAtt FolderIndex.FunctionMetadata.FunctionARN
        CustomErrorResponses:
          - ErrorCode: 403
            ResponseCode: !If [Spa, 200, 404]
            ResponsePagePath: !If [Spa, /index.html, /404.html]
          - ErrorCode: 404
            ResponseCode: !If [Spa, 200, 404]
            ResponsePagePath: !If [Spa, /index.html, /404.html]
  FilesReadBySite:
    Type: AWS::S3::BucketPolicy
    Properties:
      Bucket: !Ref Files
      PolicyDocument:
        Statement:
          - Effect: Allow
            Principal: { Service: cloudfront.amazonaws.com }
            Action: s3:GetObject
            Resource: !Sub '${Files.Arn}/*'
            Condition:
              StringEquals:
                AWS:SourceArn: !Sub 'arn:aws:cloudfront::${AWS::AccountId}:distribution/${Site}'
Outputs:
  Bucket:
    Value: !Ref Files
  Address:
    Value: !GetAtt Site.DomainName
```

An error document other than `404.html` goes in `ResponsePagePath`.

## Moving

1. **Make the site on AWS:**

   ```bash
   aws cloudformation deploy --template-file site.yaml --stack-name shop-site --parameter-overrides SinglePageApp=true
   output() { aws cloudformation describe-stacks --stack-name shop-site --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
   ```

2. **Upload the files,** with the cache headers `ff sites deploy` gives them: assets first, as Vite names its hashed ones (`assets/`), then the rest, so that a page never names an asset not there yet.

   ```bash
   aws s3 sync ./dist/assets "s3://$(output Bucket)/assets" --delete --cache-control 'public, max-age=31536000, immutable'
   aws s3 sync ./dist "s3://$(output Bucket)" --delete --exclude 'assets/*' --cache-control no-cache
   ```

   The AWS CLI types each file by its name, as `ff sites deploy` does.
3. **Check it** at `https://$(output Address)/`: its pages, a path with no file, a folder's path.
4. **Move your domains:** ask ACM for their certificate (`aws acm request-certificate --region us-east-1 --domain-name www.shop.tn --validation-method DNS`), publish the CNAME it gives to prove them, and deploy again with `Domains=www.shop.tn Certificate=<its ARN>`. Then point each domain's CNAME at `$(output Address)` instead of `<bucket>.site.<domain>`: visitors move as their DNS caches expire, both sites answering until then.
5. **Then, on FF,** once no visitor comes any more (`ff sites metrics <bucket>`): `ff sites domains remove <bucket> <domain>` for each, `ff sites remove <bucket>`, and `ff buckets delete <bucket> --force` when you no longer need its files.

**One difference:** FF redirects a folder named without its slash (`/docs`) to `/docs/`, as S3's website endpoint does; this distribution doesn't, so link folders with their slash.
