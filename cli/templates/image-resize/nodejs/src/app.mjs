// {{name}}'s thumbnails: for each image put in its bucket under uploads/, a WebP of SIZE pixels at most each way,
// written under thumbnails/ at the same path, its extension .webp. The event is S3's, as Lambda gets it, the same on
// FF and on AWS; the bucket is the event's. sharp makes the thumbnail: its native code is Linux's, which ff deploy
// --container and sam build --use-container install whatever this machine is.
/** The thumbnail's most pixels, each way: a smaller image is kept its size. */
export const SIZE = 200;
const UPLOADS = 'uploads/';
const THUMBNAILS = 'thumbnails/';

export async function handler(event) {
  return thumbnails(event, await bucket(), await resizer());
}

/**
 * The thumbnails of the event's uploads, each written beside its image: `bucket` reads and writes the files, `resize`
 * makes a thumbnail of an image's bytes. The tests give their own.
 */
export async function thumbnails(event, bucket, resize) {
  const made = [];
  for (const record of event.Records ?? []) {
    const name = record.s3.bucket.name;
    const key = keyOf(record);
    const thumbnail = thumbnailOf(key);
    if (!thumbnail) {
      console.log(JSON.stringify({ left: key, why: `not a file under ${UPLOADS}` }));
      continue;
    }
    const image = await bucket.get(name, key);
    let small;
    try {
      small = await resize(image);
    } catch (error) {
      // A file that is no image, or one too damaged to read: trying again would fail again.
      console.log(JSON.stringify({ left: key, why: error.message }));
      continue;
    }
    await bucket.put(name, thumbnail, small, 'image/webp');
    console.log(JSON.stringify({ made: thumbnail, from: key, bytes: small.length }));
    made.push(thumbnail);
  }
  return { made };
}

/** The record's key as it was put: S3 writes it in an event as a URL's query writes it, a space a "+". */
export function keyOf(record) {
  return decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
}

/** The thumbnail's key of a file under uploads/, its extension .webp; none for another key. */
export function thumbnailOf(key) {
  if (!key.startsWith(UPLOADS) || key.endsWith('/')) return null;
  const path = key.slice(UPLOADS.length);
  const dot = path.lastIndexOf('.');
  const stem = dot > path.lastIndexOf('/') + 1 ? path.slice(0, dot) : path;
  return `${THUMBNAILS}${stem}.webp`;
}

async function resizer() {
  // Loaded here, so that the tests run without it installed.
  const { default: sharp } = await import('sharp');
  // Turned as the camera says it was held, then made smaller, never larger.
  return (image) =>
    sharp(image).rotate().resize(SIZE, SIZE, { fit: 'inside', withoutEnlargement: true }).webp().toBuffer();
}

async function bucket() {
  const { GetObjectCommand, PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({});
  return {
    async get(name, key) {
      const object = await s3.send(new GetObjectCommand({ Bucket: name, Key: key }));
      return Buffer.from(await object.Body.transformToByteArray());
    },
    async put(name, key, body, type) {
      await s3.send(new PutObjectCommand({ Bucket: name, Key: key, Body: body, ContentType: type }));
    },
  };
}
