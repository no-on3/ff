import { ACCESS_KEY_ID, STORE_NAME, bucketNameProblem, newAccessKeyId, newSecretAccessKey, newStoreName } from './storage-names';

describe("buckets' names", () => {
  it("are AWS's, without dots", () => {
    for (const name of ['photos', 'abc', 'my-app-2026', '123', `a${'b'.repeat(61)}c`]) expect(bucketNameProblem(name)).toBeUndefined();
    for (const name of ['ab', `a${'b'.repeat(62)}c`, 'Photos', 'my.photos', '-photos', 'photos-', 'my_photos', 'phötos', '']) {
      expect(bucketNameProblem(name)).toMatch(/is not a bucket name: 3 to 63 lower-case letters/);
    }
  });

  it('keep out what AWS keeps for itself', () => {
    expect(bucketNameProblem('xn--photos')).toMatch(/AWS keeps names with "xn--"/);
    expect(bucketNameProblem('photos-s3alias')).toMatch(/AWS keeps names with "-s3alias"/);
    expect(bucketNameProblem('photos--ol-s3')).toMatch(/AWS keeps names with "--ol-s3"/);
  });

  it("in the store, say nothing of whose they are", () => {
    const names = new Set(Array.from({ length: 50 }, newStoreName));

    expect(names.size).toBe(50);
    for (const name of names) expect(name).toMatch(STORE_NAME);
  });
});

describe('access keys', () => {
  it("look like AWS's: an ID of 20 characters, a secret of 40", () => {
    const ids = new Set(Array.from({ length: 50 }, newAccessKeyId));

    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(ACCESS_KEY_ID);
    expect(newSecretAccessKey()).toMatch(/^[A-Za-z0-9+/]{40}$/);
  });
});
