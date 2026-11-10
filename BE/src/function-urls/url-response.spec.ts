/**
 * What a function's return value answers its URL's caller. The return values
 * and their answers are function-url-examples.json's, which ff local's front
 * door reads too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidUrlResponseError, urlAnswer } from './url-response';

/** A case: a return value, and its answer (its body as text, or its bytes in base64), or why it can't be one. */
interface AnswerExample {
  title: string;
  output: unknown;
  answer?: { status: number; headers: Array<[string, string]>; body?: string; bodyBase64?: string };
  refused?: string;
}

const table = JSON.parse(readFileSync(join(__dirname, 'function-url-examples.json'), 'utf8')) as { answers: Record<string, AnswerExample[]> };

/** The case's return value answers as it says, whole. */
function answersAsItSays({ output, answer }: AnswerExample): void {
  if (!answer) throw new Error('A case says its answer, or why there is none');
  const body = answer.bodyBase64 !== undefined ? Buffer.from(answer.bodyBase64, 'base64') : Buffer.from(answer.body ?? '', 'utf8');
  expect(urlAnswer(output)).toEqual({ status: answer.status, headers: answer.headers, body });
}

describe("what a function's return value answers its URL's caller", () => {
  it.each(table.answers.json)('answers 200 with JSON for $title', answersAsItSays);

  it('answers a response as it says: status, headers, body', () => {
    table.answers.response.forEach(answersAsItSays);
  });

  it("says JSON when the response names no type, as Lambda's does", () => {
    table.answers.untyped.forEach(answersAsItSays);
  });

  it('turns each cookie into a Set-Cookie header', () => {
    table.answers.cookies.forEach(answersAsItSays);
  });

  it('decodes a base64 body, for images and other bytes', () => {
    table.answers.base64.forEach(answersAsItSays);
  });

  it("sends a body that isn't text as its JSON, numbers and booleans as headers' text", () => {
    table.answers.notText.forEach(answersAsItSays);
  });

  it('drops the headers the server sets itself: per connection, and the length', () => {
    table.answers.serverHeaders.forEach(answersAsItSays);
  });

  it.each(table.answers.refused)('refuses $title, which the caller gets as 502', ({ output, refused }) => {
    expect(() => urlAnswer(output)).toThrow(new InvalidUrlResponseError(refused as string));
  });
});
