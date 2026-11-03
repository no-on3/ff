// {{name}}'s uploads: S3's event, a record for each new file of the bucket.
export async function handler(event) {
  for (const record of event.Records) {
    console.log(`new file ${decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '))} in ${record.s3.bucket.name}, ${record.s3.object.size} bytes`);
  }
}
