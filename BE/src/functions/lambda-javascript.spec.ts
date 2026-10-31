import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { runInThisContext } from 'node:vm';
import { lambdaJavaScript } from './lambda-javascript';

type Handler = (event?: { name?: string }) => Promise<unknown>;

/** What a CommonJS file exports, loaded as Node.js loads one, and so Lambda's Node.js runtime: in its wrapper, with require. */
function load(javascript: string): { handler?: Handler } {
  const module = { exports: {} };
  const wrapper = runInThisContext(`(function (exports, require, module) {${javascript}\n})`, { filename: 'function.js' }) as (
    exports: object,
    require: NodeJS.Require,
    module: object,
  ) => void;
  wrapper(module.exports, require, module);
  return module.exports;
}

describe("inline TypeScript as the JavaScript AWS Lambda's Node.js runtime loads", () => {
  it('is CommonJS that runs as the TypeScript ran on FF: its types gone, an enum and a namespace kept, its imports required', async () => {
    const code = [
      "import { createHash } from 'node:crypto';",
      'enum Greeting { Hello = "Ahlan" }',
      'namespace Places { export const home = "Sfax"; }',
      'interface Event { name?: string }',
      'export async function handler(event?: Event): Promise<{ message: string; digest: string }> {',
      '  const message = `${Greeting.Hello}, ${event?.name ?? Places.home}`;',
      "  return { message, digest: createHash('sha256').update(message).digest('hex') };",
      '}',
    ].join('\n');

    const javascript = await lambdaJavaScript(code);
    const { handler } = load(javascript);

    expect(javascript).toContain('require("node:crypto")');
    expect(javascript).not.toMatch(/interface|Promise<|sourceMappingURL/);
    await expect(handler!({ name: 'Gabès' })).resolves.toEqual({ message: 'Ahlan, Gabès', digest: createHash('sha256').update('Ahlan, Gabès').digest('hex') });
    await expect(handler!()).resolves.toMatchObject({ message: 'Ahlan, Sfax' });
  });

  it("reads a default import of a CommonJS module as FF's runtime does, its module.exports", async () => {
    const { handler } = load(await lambdaJavaScript("import path from 'node:path';\nexport const handler = async () => path.basename('/var/task/function.js');\n"));

    await expect(handler!()).resolves.toBe('function.js');
  });

  it("checks no types, as FF doesn't: code that ran there runs on Lambda", async () => {
    // A string where the handler's type says a number: tsc refuses it, the transpile doesn't.
    const { handler } = load(await lambdaJavaScript("export const handler = async (): Promise<number> => 'not a number';\n"));

    await expect(handler!()).resolves.toBe('not a number');
  });

  it('refuses code with a syntax error, which never loaded on FF either, naming where: its first three errors', async () => {
    const error = await lambdaJavaScript('export const handler = async () => {\n  return {{{;\n};\n').catch((thrown: unknown) => thrown);
    const many = await lambdaJavaScript('let = ;\nlet = ;\nlet = ;\nlet = ;\n').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe("The function's code doesn't transpile to JavaScript: function.ts:2:11 Property assignment expected.; function.ts:4:1 '}' expected.");
    expect((many as Error).message.match(/function\.ts:\d+:\d+/g)).toHaveLength(3);
  });
});
