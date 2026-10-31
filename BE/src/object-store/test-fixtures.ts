// Shared by the tests that reach a real object store, L2's (not part of the build: tsconfig.build.json excludes
// test-fixtures.ts).
import { S3Client } from '@aws-sdk/client-s3';

/**
 * The store's settings as the backend reads them, FF_OBJECT_STORE_*, alone: BE/.env's development SeaweedFS, or the
 * CI's own. Read when asked, after the test has loaded BE/.env.
 */
export function testObjectStore() {
  return {
    endPoint: process.env.FF_OBJECT_STORE_ENDPOINT ?? 'localhost',
    port: Number(process.env.FF_OBJECT_STORE_PORT ?? 9003),
    useSSL: process.env.FF_OBJECT_STORE_USE_SSL === 'true',
    accessKey: process.env.FF_OBJECT_STORE_ACCESS_KEY ?? 'ffdevaccesskey',
    secretKey: process.env.FF_OBJECT_STORE_SECRET_KEY ?? 'ffdevsecretkey-local-only',
  };
}

/** A client of the store itself, with FF's credentials: what it really keeps. The test destroys it. */
export function testStoreClient(): S3Client {
  const { useSSL, endPoint, port, accessKey, secretKey } = testObjectStore();
  return new S3Client({
    endpoint: `${useSSL ? 'https' : 'http'}://${endPoint}:${port}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
}
