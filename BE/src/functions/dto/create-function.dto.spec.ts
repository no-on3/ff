import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Runtime } from '../entities/function.entity';
import { CreateFunctionDto } from './create-function.dto';
import { UpdateFunctionDto } from './update-function.dto';

/** A body as the API validates it, with main.ts's pipe: the instance it passes on, or why it answers 400. */
async function validated(metatype: typeof CreateFunctionDto | typeof UpdateFunctionDto, body: object): Promise<{ name?: unknown } | string[]> {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  try {
    return (await pipe.transform(body, { type: 'body', metatype })) as { name?: unknown };
  } catch (error) {
    return ((error as BadRequestException).getResponse() as { message: string[] }).message;
  }
}

describe("a function's name, as the API takes it: AWS Lambda's rule", () => {
  const create = { runtime: Runtime.NODEJS, code: 'exports.handler = async () => 1;', memory: 128, timeout: 5 };
  const RULE = "name must be 1 to 64 letters, digits, hyphens or underscores, as an AWS Lambda function's name";

  it.each(['hello', 'Hello_World-2', 'a', 'x'.repeat(64)])('takes %s', async (name) => {
    expect(await validated(CreateFunctionDto, { ...create, name })).toMatchObject({ name });
    expect(await validated(UpdateFunctionDto, { name })).toMatchObject({ name });
  });

  // Each of these would be a name only in FF, which the CLI couldn't address as Lambda does.
  it.each([
    ['empty', ''],
    ['with a space inside', 'my function'],
    ['with spaces around it', ' hello '],
    ['with a dot', 'hello.v2'],
    ['with a slash', 'a/b'],
    ['with a letter outside ASCII', 'café'],
    ['65 characters long', 'x'.repeat(65)],
  ])('refuses a name %s, naming the rule, on create and on update', async (_case, name) => {
    expect(await validated(CreateFunctionDto, { ...create, name })).toEqual([RULE]);
    expect(await validated(UpdateFunctionDto, { name })).toEqual([RULE]);
  });

  it('keeps its case: "Hello" and "hello" are two names, as on AWS Lambda', async () => {
    expect(await validated(CreateFunctionDto, { ...create, name: 'Hello' })).toMatchObject({ name: 'Hello' });
  });

  it('is a string', async () => {
    expect(await validated(CreateFunctionDto, { ...create, name: 42 })).toEqual(expect.arrayContaining(['name must be a string']));
  });

  it('may be left out of an update, which then keeps the name, even one given before the rule', async () => {
    expect(await validated(UpdateFunctionDto, { memory: 256 })).not.toHaveProperty('name');
  });
});
