// {{name}}'s job, run each morning at 06:00 UTC by its schedule: the report of the day before, from the files that
// arrived in its bucket under incoming/ that day, written beside them as reports/<day>.json.
// The event is EventBridge's Scheduled Event, the same on FF and on AWS Lambda. The day reported is the one before
// its time, so that a run made again, from the queue of failed runs, reports the same day; a run by hand may name it,
// {"day": "2026-11-09"}. A run that throws is tried twice more, then its event goes to that queue, as template.yaml
// says. BUCKET names the bucket; AWS's SDK finds its endpoint and its key in the function's environment, on FF as on
// AWS.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The report of the event's day, written to the bucket, and given back. */
export async function report(event, bucket) {
  const day = dayOf(event);
  const arrived = (await bucket.list('incoming/')).filter((file) => file.lastModified.startsWith(day));
  const largest = arrived.reduce((most, file) => (most && most.size >= file.size ? most : file), null);
  const summary = {
    day,
    files: arrived.length,
    bytes: arrived.reduce((sum, file) => sum + file.size, 0),
    largest: largest && { key: largest.key, size: largest.size },
  };
  await bucket.put(`reports/${day}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`reported ${day}: ${summary.files} files, ${summary.bytes} bytes`);
  return summary;
}

export async function handler(event) {
  return report(event, await files());
}

/** The day the event names, else the one before its time, else yesterday: YYYY-MM-DD, in UTC. */
function dayOf(event) {
  if (event.day !== undefined) {
    if (typeof event.day !== 'string' || !DAY.test(event.day) || Number.isNaN(Date.parse(event.day))) {
      throw new Error(`The day to report is YYYY-MM-DD, not ${JSON.stringify(event.day)}`);
    }
    return event.day;
  }
  const at = event.time === undefined ? Date.now() : Date.parse(event.time);
  if (Number.isNaN(at)) throw new Error(`The event's time is no date: ${JSON.stringify(event.time)}`);
  return new Date(at - 86_400_000).toISOString().slice(0, 10);
}

// The bucket, made at the first call and kept for the calls after.
let bucket;

async function files() {
  bucket ??= await opened(process.env.BUCKET);
  return bucket;
}

async function opened(name) {
  if (!name) throw new Error('BUCKET is not set: template.yaml sets it to the bucket it makes');
  // Loaded here, so that the tests run without it installed.
  const { ListObjectsV2Command, PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({});
  return {
    async list(prefix) {
      const found = [];
      let token;
      do {
        const asked = { Bucket: name, Prefix: prefix, ContinuationToken: token };
        const page = await s3.send(new ListObjectsV2Command(asked));
        for (const object of page.Contents ?? []) {
          found.push({ key: object.Key, size: object.Size, lastModified: object.LastModified.toISOString() });
        }
        token = page.NextContinuationToken;
      } while (token);
      return found;
    },
    async put(key, body) {
      await s3.send(new PutObjectCommand({ Bucket: name, Key: key, Body: body, ContentType: 'application/json' }));
    },
  };
}
