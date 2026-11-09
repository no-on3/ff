// {{name}}'s worker: the queue's jobs, ten at most a call, as SQS's event gives them to Lambda, on FF as on AWS. Each
// job is done by its task's function in TASKS. One that throws, or whose task none does, is named in the answer's
// batchItemFailures, so that the queue keeps it for another try while it deletes the others, as
// ReportBatchItemFailures in template.yaml asks; a job that failed three times goes to the dead-letter queue. Each job
// done, or failed, is a line of the log.

/** What each task does, given its job, its answer a line of the log: yours to change. */
export const TASKS = {
  // {"task": "greet", "name": "Amira"}
  greet: async (job) => {
    if (typeof job.name !== 'string' || job.name.length === 0) throw new Error('A greeting needs a name');
    return `Hello ${job.name}`;
  },
};

export async function handler(event) {
  return work(event, TASKS);
}

/** The batch's jobs done by the tasks given; the answer names those that failed. */
export async function work(event, tasks) {
  const failed = [];
  for (const record of event.Records) {
    const tries = Number(record.attributes?.ApproximateReceiveCount ?? 1);
    try {
      const job = JSON.parse(record.body);
      if (!Object.hasOwn(tasks, job?.task)) throw new Error(`No task ${JSON.stringify(job?.task)}`);
      const result = await tasks[job.task](job);
      console.log(JSON.stringify({ job: record.messageId, task: job.task, done: result }));
    } catch (error) {
      console.log(JSON.stringify({ job: record.messageId, failed: error.message, tries }));
      failed.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failed };
}
