import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { EventFormat, Runtime } from '../entities/function.entity';
import { CreateFunctionDto } from './create-function.dto';
import { UpdateFunctionDto } from './update-function.dto';
import { UpdateSecretsDto } from './secrets.dto';
import { InvokeFunctionDto } from './invoke-function.dto';

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

describe("a function's environment variables, as the API takes them: AWS Lambda's rules", () => {
  const create = { name: 'hello', runtime: Runtime.NODEJS, code: 'exports.handler = async () => 1;', memory: 128, timeout: 5 };
  const both = async (environment: unknown) => [await validated(CreateFunctionDto, { ...create, environment }), await validated(UpdateFunctionDto, { environment })];

  it('takes a map of names to strings, on create and on update, and an empty one, which removes them all', async () => {
    const environment = { TABLE_NAME: 'orders', LOG_LEVEL: 'info', AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1', TZ: 'Africa/Tunis', ab: '' };

    for (const result of await both(environment)) expect(result).toMatchObject({ environment });
    for (const result of await both({})) expect(result).toMatchObject({ environment: {} });
  });

  it.each([
    ['a digit first', '1ST'],
    ['an underscore first', '_PRIVATE'],
    ['one character', 'X'],
    ['a hyphen', 'MY-VAR'],
    ['a dot', 'my.var'],
    ['a letter outside ASCII', 'CAFÉ'],
  ])('refuses a name with %s, naming the rule', async (_case, name) => {
    for (const result of await both({ [name]: 'v' })) {
      expect(result).toEqual([`"${name}" is not a variable name: a letter first, then letters, digits or underscores, two characters at least, as on AWS Lambda`]);
    }
  });

  it.each(['AWS_REGION', 'AWS_LAMBDA_FUNCTION_NAME', 'AWS_ACCESS_KEY_ID', 'LAMBDA_TASK_ROOT', 'FUNCTION_TIMEOUT', 'PORT', 'PATH'])(
    "refuses %s: AWS Lambda or FF's runtime sets it",
    async (name) => {
      for (const result of await both({ [name]: 'v' })) expect(result).toEqual([`${name} is reserved: AWS Lambda or FF's runtime sets it`]);
    },
  );

  it("refuses every name starting with FF_, FF's own", async () => {
    for (const result of await both({ FF_HANDLER: 'x.handler' })) expect(result).toEqual(['FF_HANDLER is reserved: names starting with FF_ are FF\'s own']);
  });

  it('refuses values that are not strings, naming the variable, never the value', async () => {
    for (const result of await both({ PORT_NUMBER: 8080, DEBUG: true, LIST: ['a'] })) {
      expect(result).toEqual([
        "PORT_NUMBER's value must be a string, as every variable's is on AWS Lambda; " +
          "DEBUG's value must be a string, as every variable's is on AWS Lambda; " +
          "LIST's value must be a string, as every variable's is on AWS Lambda",
      ]);
    }
  });

  it('refuses what is not a map, null included: an empty map removes the variables', async () => {
    for (const environment of [['A=1'], 'A=1', null, 42]) {
      for (const result of await both(environment)) expect(result).toEqual(['environment must be a JSON object of variable names to string values']);
    }
  });

  it('takes 4 KB as AWS Lambda counts it, the JSON text of the map, and not one byte more', async () => {
    // {"BIG":"…"} is 10 bytes around the value.
    const exactly = { BIG: 'x'.repeat(4096 - 10) };
    const over = { BIG: 'x'.repeat(4096 - 9) };

    expect(await validated(CreateFunctionDto, { ...create, environment: exactly })).toMatchObject({ environment: exactly });
    expect(await validated(CreateFunctionDto, { ...create, environment: over })).toEqual([
      "The environment is 4097 bytes as JSON text: AWS Lambda allows 4096 (4 KB) for a function's variables and secrets together",
    ]);
  });

  it('counts bytes, not characters: a value outside ASCII takes two each', async () => {
    // 2,054 characters, far under 4,096, but 4,098 bytes: each é is two bytes in UTF-8.
    const accented = { BIG: 'é'.repeat(2044) };

    expect(await validated(CreateFunctionDto, { ...create, environment: accented })).toEqual([
      "The environment is 4098 bytes as JSON text: AWS Lambda allows 4096 (4 KB) for a function's variables and secrets together",
    ]);
  });
});

describe("a function's secrets, as the API takes them", () => {
  const create = { name: 'hello', runtime: Runtime.NODEJS, code: 'exports.handler = async () => 1;', memory: 128, timeout: 5 };
  const changes = async (secrets: unknown) => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
    try {
      return await pipe.transform({ secrets }, { type: 'body', metatype: UpdateSecretsDto });
    } catch (error) {
      return ((error as BadRequestException).getResponse() as { message: string[] }).message;
    }
  };

  it('takes names to strings on create, with the variables rule for names, never echoing a value', async () => {
    expect(await validated(CreateFunctionDto, { ...create, secrets: { DB_PASSWORD: 'hunter2' } })).toMatchObject({ secrets: { DB_PASSWORD: 'hunter2' } });
    const refused = await validated(CreateFunctionDto, { ...create, secrets: { AWS_SECRET_ACCESS_KEY: 'k', 'bad name': 'v', TOKEN: 42 } });
    expect(refused).toEqual([
      "AWS_SECRET_ACCESS_KEY is reserved: AWS Lambda or FF's runtime sets it; " +
        '"bad name" is not a variable name: a letter first, then letters, digits or underscores, two characters at least, as on AWS Lambda; ' +
        "TOKEN's value must be a string, as every variable's is on AWS Lambda",
    ]);
  });

  it("isn't part of an update: secrets change through their own route alone", async () => {
    expect(await validated(UpdateFunctionDto, { secrets: { DB_PASSWORD: 'x' } })).toEqual(['property secrets should not exist']);
  });

  it('takes a change of names to strings, which set, or to null, which removes', async () => {
    expect(await changes({ DB_PASSWORD: 'new', OLD_TOKEN: null })).toMatchObject({ secrets: { DB_PASSWORD: 'new', OLD_TOKEN: null } });
  });

  it('refuses a change naming nothing, or what is not a map, or a value neither a string nor null, never echoing one', async () => {
    expect(await changes({})).toEqual(['secrets must name at least one secret to set or remove']);
    expect(await changes(['DB_PASSWORD'])).toEqual(['secrets must be a JSON object of secret names to string values, or to null to remove one']);
    expect(await changes({ DB_PASSWORD: 12345 })).toEqual(["DB_PASSWORD's value must be a string, or null to remove the secret"]);
    expect(await changes(undefined)).toEqual(['secrets must be a JSON object of secret names to string values, or to null to remove one']);
  });
});

describe("a function's handler, as the API takes it: AWS Lambda's", () => {
  const create = { name: 'hello', runtime: Runtime.PYTHON, code: 'def main(event, context):\n    return 1\n', memory: 128, timeout: 5 };

  it('takes one on create and on update, or none, which keeps function.handler or the one the function has', async () => {
    expect(await validated(CreateFunctionDto, { ...create, handler: 'function.main' })).toMatchObject({ handler: 'function.main' });
    // A file in a folder is a package's: the function's own package type decides.
    expect(await validated(UpdateFunctionDto, { handler: 'src/app.handler' })).toMatchObject({ handler: 'src/app.handler' });
    expect(await validated(CreateFunctionDto, create)).toMatchObject({ handler: undefined });
    expect(await validated(UpdateFunctionDto, { memory: 256 })).not.toHaveProperty('handler');
  });

  it('refuses one no runtime takes, saying why, and what is not a string, null included', async () => {
    expect(await validated(CreateFunctionDto, { ...create, handler: 'function. main' })).toEqual(['handler must not contain whitespace, as on AWS Lambda']);
    expect(await validated(UpdateFunctionDto, { handler: '../app.handler' })).toEqual([
      'handler must name a file inside the package, from its root: no leading /, no backslash, no . or .. folder',
    ]);
    expect(await validated(UpdateFunctionDto, { handler: 'main' })).toEqual([
      'handler must be <file>.<function>, as on AWS Lambda: function.handler, or src/app.handler for a file in a folder',
    ]);
    expect(await validated(UpdateFunctionDto, { handler: null })).toEqual(['handler must be a string']);
    expect(await validated(UpdateFunctionDto, { handler: 42 })).toEqual(['handler must be a string']);
  });
});

describe('an update, as the API takes it', () => {
  // Null used to pass for each, as if it were a value, and failed further on.
  it.each([
    ['name', 'name must be a string'],
    ['runtime', 'runtime must be one of the following values: nodejs, python'],
    ['code', 'code must be a string'],
    ['memory', 'memory must be a number conforming to the specified constraints'],
    ['timeout', 'timeout must be a number conforming to the specified constraints'],
    ['eventFormat', 'eventFormat must be one of the following values: lambda, wrapped'],
  ])('refuses null for %s: no value, rather than "unchanged", which leaving it out says', async (field, message) => {
    expect(await validated(UpdateFunctionDto, { [field]: null })).toEqual(expect.arrayContaining([message]));
  });

  it('takes null for metadata, which it removes', async () => {
    expect(await validated(UpdateFunctionDto, { metadata: null })).toMatchObject({ metadata: null });
  });

  it('refuses null for the event format on create too, where the database would have refused it', async () => {
    const create = { name: 'hello', runtime: Runtime.NODEJS, code: 'exports.handler = async () => 1;', memory: 128, timeout: 5 };

    expect(await validated(CreateFunctionDto, { ...create, eventFormat: null })).toEqual(['eventFormat must be one of the following values: lambda, wrapped']);
  });
});

describe("the event a function receives, as the API takes it", () => {
  const create = { name: 'hello', runtime: Runtime.NODEJS, code: 'exports.handler = async () => 1;', memory: 128, timeout: 5 };

  it("takes lambda or wrapped as a function's event format, on create and on update, and nothing else", async () => {
    expect(await validated(CreateFunctionDto, { ...create, eventFormat: 'wrapped' })).toMatchObject({ eventFormat: EventFormat.WRAPPED });
    expect(await validated(UpdateFunctionDto, { eventFormat: 'lambda' })).toMatchObject({ eventFormat: EventFormat.LAMBDA });
    expect(await validated(UpdateFunctionDto, { eventFormat: 'v2' })).toEqual(['eventFormat must be one of the following values: lambda, wrapped']);
  });

  it('takes any JSON value as invoke input, as AWS Lambda takes a payload', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
    for (const input of ['text', 42, [1, 'two'], null, true, { a: 1 }]) {
      expect(await pipe.transform({ input }, { type: 'body', metatype: InvokeFunctionDto })).toEqual({ input });
    }
    expect(await pipe.transform({}, { type: 'body', metatype: InvokeFunctionDto })).toEqual({});
  });
});

describe("a function's code and metadata, as the API takes them: what a ConfigMap holds, labels rather than data", () => {
  const create = { name: 'hello', runtime: Runtime.NODEJS, memory: 128, timeout: 5 };

  it('takes code up to 900 KiB of UTF-8, on create and on update', async () => {
    const code = `// ${'x'.repeat(921_600 - 3)}`;

    expect(await validated(CreateFunctionDto, { ...create, code })).toMatchObject({ code });
    expect(await validated(UpdateFunctionDto, { code })).toMatchObject({ code });
  });

  it("refuses code over 900 KiB, counting bytes as stored, and says how many it has", async () => {
    // 460,801 characters, two bytes each in UTF-8: 921,602 bytes.
    const code = 'é'.repeat(460_801);
    const message = "code is 921,602 bytes of UTF-8; it may have 921,600 at most, what a function's ConfigMap holds (900 KiB)";

    expect(await validated(CreateFunctionDto, { ...create, code })).toEqual([message]);
    expect(await validated(UpdateFunctionDto, { code })).toEqual([message]);
  });

  it('takes metadata as an object of up to 4 KB as JSON, and nothing else', async () => {
    const code = 'exports.handler = async () => 1;';

    expect(await validated(CreateFunctionDto, { ...create, code, metadata: { team: 'billing', tier: 2 } })).toMatchObject({ metadata: { team: 'billing', tier: 2 } });
    expect(await validated(UpdateFunctionDto, { metadata: ['team'] })).toEqual(['metadata must be an object']);
    expect(await validated(UpdateFunctionDto, { metadata: { notes: 'x'.repeat(4_096) } })).toEqual([
      'metadata is 4,108 bytes as JSON; it may have 4,096 at most, for labels rather than data (4 KB)',
    ]);
  });
});
