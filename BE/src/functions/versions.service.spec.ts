/**
 * L1: what a version freezes of its function, so that a publish with nothing
 * changed answers the last one; and what Lambda's PublishVersion refuses.
 */
import { BadRequestException, ConflictException, PreconditionFailedException } from '@nestjs/common';
import { AwsEndpoint } from '../common/aws-endpoint';
import { EventFormat, FunctionStatus, PackageType, Runtime } from './entities/function.entity';
import { EnvironmentDocument, NO_ENVIRONMENT } from './environment';
import { publishRefusal, sameRelease } from './versions.service';

const RELEASE = {
  runtime: Runtime.NODEJS,
  handler: 'function.handler',
  packageType: PackageType.INLINE,
  codeSha256: 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
  memory: 128,
  timeout: 30,
  eventFormat: EventFormat.LAMBDA,
  awsEndpoints: [AwsEndpoint.S3, AwsEndpoint.SQS],
};
const ENVIRONMENT: EnvironmentDocument = { variables: { LOG_LEVEL: 'info' }, secrets: { DATABASE_URL: { value: 'postgres://a', updatedAt: '2026-11-01T09:00:00.000Z' } } };

describe('a release, as a version freezes it (L1)', () => {
  it('is the same when its code, settings and environment are, its endpoints in any order and a secret set again to its value', () => {
    const again = { ...ENVIRONMENT, secrets: { DATABASE_URL: { value: 'postgres://a', updatedAt: '2026-11-01T10:00:00.000Z' } } };
    expect(sameRelease(RELEASE, ENVIRONMENT, { ...RELEASE, awsEndpoints: [AwsEndpoint.SQS, AwsEndpoint.S3] }, again)).toBe(true);
    expect(sameRelease(RELEASE, NO_ENVIRONMENT, RELEASE, NO_ENVIRONMENT)).toBe(true);
  });

  it('differs in any of them: the code, a setting, an endpoint, a variable, a secret', () => {
    const changes: Array<[Partial<typeof RELEASE>, EnvironmentDocument]> = [
      [{ codeSha256: 'other' }, ENVIRONMENT],
      [{ memory: 256 }, ENVIRONMENT],
      [{ eventFormat: EventFormat.WRAPPED }, ENVIRONMENT],
      [{ awsEndpoints: [AwsEndpoint.S3] }, ENVIRONMENT],
      [{}, { ...ENVIRONMENT, variables: { LOG_LEVEL: 'debug' } }],
      [{}, { ...ENVIRONMENT, secrets: { DATABASE_URL: { value: 'postgres://b', updatedAt: '2026-11-01T09:00:00.000Z' } } }],
      [{}, { ...ENVIRONMENT, secrets: {} }],
    ];
    for (const [fields, environment] of changes) expect(sameRelease(RELEASE, ENVIRONMENT, { ...RELEASE, ...fields }, environment)).toBe(false);
  });
});

describe("Lambda's PublishVersion's refusals (L1)", () => {
  const ACTIVE = { status: FunctionStatus.ACTIVE, codeSha256: RELEASE.codeSha256, revisionId: '6a1f3c2e-8b7d-4c6a-9e5f-1a2b3c4d5e6f' };

  it("publishes a working function, given its code's SHA-256 and its revision, or neither", () => {
    expect(publishRefusal(ACTIVE, {})).toBeUndefined();
    expect(publishRefusal(ACTIVE, { codeSha256: ACTIVE.codeSha256, revisionId: ACTIVE.revisionId, description: 'v' })).toBeUndefined();
  });

  it("refuses one being deployed or without working code with 409, another code's SHA-256 with 400, another revision with 412", () => {
    const refusal = (fields: Partial<typeof ACTIVE>, sent = {}) => publishRefusal({ ...ACTIVE, ...fields }, sent);
    expect(refusal({ status: FunctionStatus.CREATING })).toBeInstanceOf(ConflictException);
    expect(refusal({ status: FunctionStatus.ERROR })?.message).toBe('The function is ERROR: it has no working code to publish. Fix it with PUT /functions/{id} first');
    expect(refusal({}, { codeSha256: 'other' })).toEqual(
      new BadRequestException(`codeSha256 other isn't the function's code's, ${ACTIVE.codeSha256}: publish with the function's, or none`),
    );
    expect(refusal({}, { revisionId: '00000000-0000-4000-8000-000000000000' })).toBeInstanceOf(PreconditionFailedException);
  });
});
