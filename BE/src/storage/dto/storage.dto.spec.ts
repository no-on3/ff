import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateBucketDto, CreateStorageKeyDto } from './storage.dto';

/** A body as the API validates it, with main.ts's pipe: the instance it passes on, or why it answers 400. */
async function validated(metatype: typeof CreateBucketDto | typeof CreateStorageKeyDto, body: object): Promise<object | string[]> {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  try {
    return (await pipe.transform(body, { type: 'body', metatype })) as object;
  } catch (error) {
    return ((error as BadRequestException).getResponse() as { message: string[] }).message;
  }
}

describe("a bucket's name, as the API takes it: AWS's rule, without dots", () => {
  it.each(['photos', 'my-app-2026', '123'])('takes %s', async (name) => {
    expect(await validated(CreateBucketDto, { name })).toMatchObject({ name });
  });

  it.each([
    ['too short', 'ab', 'is not a bucket name: 3 to 63 lower-case letters'],
    ['with a dot, which would break its certificate', 'my.photos', 'is not a bucket name: 3 to 63 lower-case letters'],
    ['in capitals', 'Photos', 'is not a bucket name: 3 to 63 lower-case letters'],
    ["with a prefix AWS keeps", 'xn--photos', 'AWS keeps names with "xn--" for itself'],
  ])('refuses one %s, saying why', async (_case, name, why) => {
    expect(await validated(CreateBucketDto, { name })).toEqual([expect.stringContaining(why)]);
  });
});

describe("an access key's buckets", () => {
  it('may be all the account\'s, or some by name, read-only or not', async () => {
    expect(await validated(CreateStorageKeyDto, {})).toEqual({});
    expect(await validated(CreateStorageKeyDto, { buckets: ['photos', 'exports'], readOnly: true })).toEqual({ buckets: ['photos', 'exports'], readOnly: true });
  });

  it('refuses no bucket, the same twice, and a name no bucket could have', async () => {
    expect(await validated(CreateStorageKeyDto, { buckets: [] })).toEqual([expect.stringContaining('buckets should not be empty')]);
    expect(await validated(CreateStorageKeyDto, { buckets: ['photos', 'photos'] })).toEqual([expect.stringContaining("All buckets's elements must be unique")]);
    expect(await validated(CreateStorageKeyDto, { buckets: ['My.Photos'] })).toEqual([expect.stringContaining('is not a bucket name')]);
    expect(await validated(CreateStorageKeyDto, { readOnly: 'yes' })).toEqual([expect.stringContaining('readOnly must be a boolean value')]);
  });
});
