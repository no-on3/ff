/**
 * A function URL's CORS, as AWS Lambda applies it. The questions and their
 * answers are function-url-examples.json's, which ff local's front door reads
 * too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UrlCors } from '../functions/entities/function-url.entity';
import { allowsOrigin, isCorsHeader, isPreflight, preflightHeaders, responseCorsHeaders } from './url-cors';

/** A question and its answer; of the table's configuration unless the case gives its own CORS. */
interface CorsExample {
  ask: 'isPreflight' | 'allowsOrigin' | 'preflightHeaders' | 'responseCorsHeaders' | 'isCorsHeader';
  cors?: UrlCors;
  method?: string;
  headers?: Record<string, string>;
  origin?: string | null;
  name?: string;
  is: unknown;
}

const table = JSON.parse(readFileSync(join(__dirname, 'function-url-examples.json'), 'utf8')) as {
  cors: { configuration: UrlCors } & Record<string, CorsExample[]>;
};

/** What the case asks, answered. */
function answer({ ask, cors = table.cors.configuration, method, headers, origin, name }: CorsExample): unknown {
  const from = origin ?? undefined;
  switch (ask) {
    case 'isPreflight':
      return isPreflight(method as string, headers ?? {});
    case 'allowsOrigin':
      return allowsOrigin(cors, from);
    case 'preflightHeaders':
      return preflightHeaders(cors, from);
    case 'responseCorsHeaders':
      return responseCorsHeaders(cors, from);
    case 'isCorsHeader':
      return isCorsHeader(name as string);
  }
}

const answersAsItSays = (examples: CorsExample[]) => {
  for (const example of examples) expect([example, answer(example)]).toEqual([example, example.is]);
};

describe("a function URL's CORS", () => {
  it("knows a browser's preflight: OPTIONS, an origin, a method asked for", () => {
    answersAsItSays(table.cors.preflight);
  });

  it('lets in the origins it names, compared without case, or any with "*"', () => {
    answersAsItSays(table.cors.origins);
  });

  it("answers an allowed origin's preflight with the configuration, the origin echoed", () => {
    answersAsItSays(table.cors.allowedPreflight);
  });

  it("answers another origin's preflight with nothing, which the browser refuses", () => {
    answersAsItSays(table.cors.otherPreflight);
  });

  it('says "*" to any origin without credentials, and echoes the origin with them, as browsers require', () => {
    answersAsItSays(table.cors.credentials);
  });

  it("adds to an allowed origin's answers the origin and the headers it may read", () => {
    answersAsItSays(table.cors.answers);
  });

  it("knows the function's own CORS headers, which the configuration replaces", () => {
    answersAsItSays(table.cors.corsHeaders);
  });
});
