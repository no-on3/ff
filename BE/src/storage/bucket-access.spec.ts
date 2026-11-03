import { MAX_POLICY_BYTES, policyFrom, publicAccessBlockFromXml, publicAccessBlockXml } from './bucket-access';
import { S3Error } from './s3-error';

const codeOf = (work: () => unknown) => {
  try {
    work();
    return 'accepted';
  } catch (error) {
    return error instanceof S3Error ? `${error.status} ${error.code}: ${error.message}` : String(error);
  }
};

describe("a bucket's policy, as S3 checks its form", () => {
  it('keeps a JSON object with a Statement as sent, its spaces and order too', () => {
    const policy = '{ "Statement": [], "Version": "2012-10-17" }';

    expect(policyFrom(policy)).toBe(policy);
  });

  it("refuses what isn't a JSON object, one without a Statement, and one past S3's 20 KB, MalformedPolicy", () => {
    expect(codeOf(() => policyFrom('[]'))).toBe("400 MalformedPolicy: Policies must be valid JSON and the first byte must be '{'");
    expect(codeOf(() => policyFrom('{"Statement": '))).toBe("400 MalformedPolicy: Policies must be valid JSON and the first byte must be '{'");
    expect(codeOf(() => policyFrom('{"Version": "2012-10-17"}'))).toBe('400 MalformedPolicy: Missing required field Statement');
    expect(codeOf(() => policyFrom(`{"Statement": [], "Sid": "${'a'.repeat(MAX_POLICY_BYTES)}"}`))).toBe('400 MalformedPolicy: Policies must be no larger than 20480 bytes');
  });
});

describe("a bucket's public access block, as S3 reads one", () => {
  const document = (switches: string) => `<PublicAccessBlockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${switches}</PublicAccessBlockConfiguration>`;

  it('reads each switch, any left out false, and writes all four back in S3\'s order', () => {
    const block = publicAccessBlockFromXml(document('<RestrictPublicBuckets>true</RestrictPublicBuckets><BlockPublicAcls>false</BlockPublicAcls>'));

    expect(block).toEqual({ blockPublicAcls: false, ignorePublicAcls: false, blockPublicPolicy: false, restrictPublicBuckets: true });
    expect(publicAccessBlockXml(block)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        document('<BlockPublicAcls>false</BlockPublicAcls><IgnorePublicAcls>false</IgnorePublicAcls><BlockPublicPolicy>false</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets>'),
    );
  });

  it('refuses a switch twice, one of another name, a value neither true nor false, and another document, MalformedXML', () => {
    for (const switches of ['<BlockPublicAcls>true</BlockPublicAcls><BlockPublicAcls>false</BlockPublicAcls>', '<BlockAll>true</BlockAll>', '<BlockPublicPolicy>yes</BlockPublicPolicy>']) {
      expect(codeOf(() => publicAccessBlockFromXml(document(switches)))).toMatch(/^400 MalformedXML/);
    }
    expect(codeOf(() => publicAccessBlockFromXml('<Tagging><TagSet/></Tagging>'))).toMatch(/^400 MalformedXML/);
  });
});
