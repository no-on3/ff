# Your FF queues and background work, to AWS

FF's queues are Amazon SQS's standard queues, its calls that don't wait are AWS Lambda's asynchronous invokes, a function reading a queue is Lambda's event source mapping, and a bucket's notifications are S3's. Each becomes the AWS resource of the same name with the same settings, and your code keeps working: only the endpoints change. The settings move; the messages waiting don't. You let FF handle them before the move.

## What you need

- **What you have on FF,** each as JSON: `ff queues list` and `ff queues get <queue>`, `ff event-sources list`, `ff async-config <function>` for each function called without waiting, and `ff buckets notifications <bucket>` (each with `--output json`).
- **An AWS account,** the AWS CLI, and AWS SAM or CloudFormation for the template below.

## What each becomes

| On FF | On AWS | Its settings, under AWS's names |
|---|---|---|
| A queue | `AWS::SQS::Queue` | `VisibilityTimeout`, `MessageRetentionPeriod`, `DelaySeconds`, `ReceiveMessageWaitTimeSeconds`, `MaximumMessageSize`, as `ff queues get` gives them in seconds and bytes; `RedrivePolicy` with the dead-letter queue's ARN (`!GetAtt OrdersDlq.Arn`) and `maxReceiveCount` |
| A function reading a queue | `AWS::Lambda::EventSourceMapping`, or SAM's `SQS` event | `BatchSize`, `MaximumBatchingWindowInSeconds`, `FunctionResponseTypes: [ReportBatchItemFailures]`, `ScalingConfig.MaximumConcurrency`, `Enabled`. The function's role needs `sqs:ReceiveMessage`, `sqs:DeleteMessage` and `sqs:GetQueueAttributes` on the queue, which SAM's `SQS` event gives it |
| A function's settings for calls that don't wait | `AWS::Lambda::EventInvokeConfig`, or SAM's `EventInvokeConfig` | `MaximumRetryAttempts`, `MaximumEventAgeInSeconds`, and `DestinationConfig`'s `OnSuccess` and `OnFailure`, a function or a queue in your AWS account. The function's role needs `sqs:SendMessage` or `lambda:InvokeFunction` on them |
| A bucket's notifications | the bucket's `NotificationConfiguration`, or SAM's `S3` event | each configuration's `Event` names and `Filter` (`prefix`, `suffix`), and its `Function` or `Queue`; with an `AWS::Lambda::Permission` that lets S3 call the function, or an `AWS::SQS::QueuePolicy` that lets it send to the queue |
| A schedule | SAM's `Schedule` event | its expression, as it is: FF's are EventBridge's |

The code needs nothing new: `new SQSClient({})` and `boto3.client("sqs")` find the queue by its name (`GetQueueUrl`) on AWS as on FF, the function's role standing for its key. A handler written for SQS's, S3's or EventBridge's events gets the same events there.

## A template, the pieces together

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Resources:
  OrdersDlq:
    Type: AWS::SQS::Queue
  Orders:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 60
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt OrdersDlq.Arn
        maxReceiveCount: 3
  ProcessOrder:                     # ff event-sources add orders process-order --batching-window 2s --report-batch-item-failures
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: process-order/
      Handler: index.handler
      Runtime: nodejs24.x           # FF's Node.js runtime is Node 24; its Python runtime, python3.13
      Timeout: 30
      Events:
        Orders:
          Type: SQS
          Properties:
            Queue: !GetAtt Orders.Arn
            BatchSize: 10
            MaximumBatchingWindowInSeconds: 2
            FunctionResponseTypes: [ReportBatchItemFailures]
  FailedReceipts:
    Type: AWS::SQS::Queue
  SendReceipt:                      # ff async-config send-receipt --retries 1 --on-failure arn:aws:sqs:…:failed-receipts
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: send-receipt/
      Handler: index.handler
      Runtime: nodejs24.x
      EventInvokeConfig:
        MaximumRetryAttempts: 1
        DestinationConfig:
          OnFailure:
            Type: SQS
            Destination: !GetAtt FailedReceipts.Arn
  Photos:
    Type: AWS::S3::Bucket
  MakeThumbnail:                    # ff buckets notify photos make-thumbnail --prefix in/
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: make-thumbnail/
      Handler: index.handler
      Runtime: nodejs24.x
      Events:
        Uploads:
          Type: S3
          Properties:
            Bucket: !Ref Photos
            Events: s3:ObjectCreated:*
            Filter:
              S3Key:
                Rules:
                  - Name: prefix
                    Value: in/
```

SAM's `SQS` and `S3` events, and `EventInvokeConfig`'s `SQS` destination, give the functions' roles what they need. AWS names a bucket for the whole of S3: yours may be taken there, so give it a `BucketName` of your own, and the code that names it the new name.

## Moving

1. **Make the AWS side,** the template above with your functions' code (`sam deploy --guided`), the bucket notifications left out for now.
2. **Send to AWS from now:** point the senders at AWS's queues, your code's environment without `AWS_ENDPOINT_URL_SQS` and without FF's key, so that `GetQueueUrl` finds the new queue. Calls that don't wait go to the functions on Lambda.
3. **Let FF finish what waits:** its functions keep reading FF's queues, and its worker keeps running the calls kept. `ff queues list` shows each queue's messages waiting, in flight and delayed going down to 0, and `ff metrics <function> --since 6h` counts the calls that didn't wait, kept and dropped. A call FF still retries is done within six hours at most, Lambda's longest.
4. **Look in the dead-letter queues:** what is in them failed for good on FF. `ff queues receive orders-dlq --max 10` shows it; send again to AWS what should run again (`aws sqs send-message`), then `--delete` it on FF.
5. **Copy the buckets, then turn their notifications on:** `s3-sync.sh` (beside this page) copies a bucket to S3 first. Each object it copies is a new upload, so a notification set before the copy would call the function once for every file: add the bucket's events to the template, and `sam deploy` again, once the copy is done.
6. **Then delete them on FF:** the mappings (`ff event-sources remove <uuid>`), the queues (`ff queues delete <queue>`), the buckets' notifications (`ff buckets notifications <bucket> --clear`), and the functions once nothing calls them.
