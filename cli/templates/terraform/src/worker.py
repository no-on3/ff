# {{name}}'s worker: SQS's event, a batch of the queue's messages. A call that fails leaves the batch in the queue,
# to be tried again, and then in the dead-letter queue.
def handler(event, context):
    for record in event["Records"]:
        print(f"job {record['messageId']}: {record['body']}")
