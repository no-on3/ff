// A function as it would run on AWS Lambda with its role: AWS's SDK for JavaScript v3 with no setting at all. FF gives
// its pods a key of the function's own, the region and the S3 endpoint in their environment, which the SDK reads.
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

export const handler = async (event) => {
  await s3.send(new PutObjectCommand({ Bucket: event.bucket, Key: 'from-node.txt', Body: 'written by a Node.js function' }));
  const read = await (await s3.send(new GetObjectCommand({ Bucket: event.bucket, Key: 'from-node.txt' }))).Body.transformToString();
  let other = 'reached';
  try {
    await s3.send(new GetObjectCommand({ Bucket: event.other, Key: 'anything.txt' }));
  } catch (error) {
    other = error.name;
  }
  return { read, other };
};
