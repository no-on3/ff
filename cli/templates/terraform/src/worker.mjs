// {{name}}'s worker: SQS's event, a batch of the queue's messages. A call that fails leaves the batch in the queue,
// to be tried again, and then in the dead-letter queue.
export async function handler(event) {
  for (const record of event.Records) {
    console.log(`job ${record.messageId}: ${record.body}`);
  }
}
