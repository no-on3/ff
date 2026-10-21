import { createHash } from 'node:crypto';
import { DEFAULT_HANDLER, codeFileName, handlerProblem, handlerSyntaxProblem, inlineCodeFacts, packageHandlerProblem } from './code-package';
import { PackageType, Runtime } from './entities/function.entity';

describe("inline code's CodeSha256 and CodeSize, as AWS Lambda gives a package's", () => {
  it('hashes the UTF-8 bytes with SHA-256, in base64, as Lambda reports it', () => {
    expect(inlineCodeFacts('')).toEqual({ codeSha256: '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=', codeSize: 0 });
    expect(inlineCodeFacts('abc')).toEqual({ codeSha256: 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=', codeSize: 3 });
  });

  it('counts bytes, not characters: a letter outside ASCII takes two', () => {
    const code = "export const handler = async () => 'café';";

    expect(inlineCodeFacts(code)).toEqual({
      codeSha256: createHash('sha256').update(Buffer.from(code, 'utf8')).digest('base64'),
      codeSize: code.length + 1,
    });
  });
});

describe("a handler, as AWS Lambda writes one, whatever the runtime", () => {
  it.each([
    DEFAULT_HANDLER,
    'src/app.handler',
    'src/handlers/orders.create',
    // Node.js follows the rest through the module's exports; Python's module may be a dotted path.
    'app.handlers.main',
    'index.default',
    'my_package.module.lambda_handler',
    `${'a'.repeat(120)}.handler`,
  ])('takes %s', (handler) => {
    expect(handlerSyntaxProblem(handler)).toBeUndefined();
  });

  it.each([
    ['empty', '', 'handler must be 1 to 128 characters, as on AWS Lambda'],
    ['129 characters long', `${'a'.repeat(121)}.handler`, 'handler must be 1 to 128 characters, as on AWS Lambda'],
    ['with a space', 'function. handler', 'handler must not contain whitespace, as on AWS Lambda'],
    ['with a line break', 'function.handler\n', 'handler must not contain whitespace, as on AWS Lambda'],
  ])('refuses one %s', (_case, handler, message) => {
    expect(handlerSyntaxProblem(handler)).toBe(message);
  });

  const OUTSIDE = 'handler must name a file inside the package, from its root: no leading /, no backslash, no . or .. folder';
  it.each([
    ['an absolute path', '/opt/nodejs/index.handler'],
    ['a parent folder', '../app.handler'],
    ['a parent folder inside', 'src/../app.handler'],
    ['two dots anywhere, as Lambda refuses', 'function..handler'],
    ['a backslash', 'src\\app.handler'],
    ['a . folder', './app.handler'],
    ['an empty folder', 'src//app.handler'],
  ])('refuses %s', (_case, handler) => {
    expect(handlerSyntaxProblem(handler)).toBe(OUTSIDE);
  });

  const SHAPE = 'handler must be <file>.<function>, as on AWS Lambda: function.handler, or src/app.handler for a file in a folder';
  it.each([
    ['no function', 'function'],
    ['no file', '.handler'],
    ['a folder and no file', 'src/.handler'],
    ['a trailing dot', 'function.handler.'],
    ['nothing after the dot', 'function.'],
    ['a folder alone', 'src/'],
  ])('refuses %s', (_case, handler) => {
    expect(handlerSyntaxProblem(handler)).toBe(SHAPE);
  });
});

describe("a handler for a function's runtime and package", () => {
  it('names a function of the one file inline code is, function.ts or function.py', () => {
    expect(codeFileName(Runtime.NODEJS)).toBe('function.ts');
    expect(codeFileName(Runtime.PYTHON)).toBe('function.py');
    expect(handlerProblem('function.handler', Runtime.NODEJS, PackageType.INLINE)).toBeUndefined();
    expect(handlerProblem('function.handlers.main', Runtime.NODEJS, PackageType.INLINE)).toBeUndefined();
    expect(handlerProblem('function.lambda_handler', Runtime.PYTHON, PackageType.INLINE)).toBeUndefined();
    expect(handlerProblem('function.café', Runtime.PYTHON, PackageType.INLINE)).toBeUndefined();
  });

  it.each([
    [Runtime.NODEJS, 'src/app.handler', 'function.ts'],
    [Runtime.NODEJS, 'index.handler', 'function.ts'],
    [Runtime.PYTHON, 'lambda_function.lambda_handler', 'function.py'],
    // Python's runtime would import a module function.handlers, which inline code hasn't.
    [Runtime.PYTHON, 'function.handlers.main', 'function.py'],
    [Runtime.PYTHON, 'function.lambda-handler', 'function.py'],
    [Runtime.PYTHON, 'function.2nd', 'function.py'],
  ])('refuses, for inline code in %s, %s, naming its file', (runtime, handler, file) => {
    expect(handlerProblem(handler, runtime, PackageType.INLINE)).toBe(
      `handler must be function.<name> for inline code, which is the file ${file}: function.handler, for example`,
    );
  });

  it('takes a handler in any file and folder of a zip package', () => {
    expect(handlerProblem('src/app.handler', Runtime.NODEJS, PackageType.ZIP)).toBeUndefined();
    expect(handlerProblem('lambda_function.lambda_handler', Runtime.PYTHON, PackageType.ZIP)).toBeUndefined();
  });

  it('refuses what no runtime takes before anything else', () => {
    expect(handlerProblem('../function.handler', Runtime.NODEJS, PackageType.INLINE)).toBe(
      'handler must name a file inside the package, from its root: no leading /, no backslash, no . or .. folder',
    );
  });
});

describe("a handler's module, looked for in a package's files", () => {
  const NODE = ['index.mjs', 'src/handlers/orders.js', 'lib/greet/index.js', 'node_modules/left-pad/index.js'];
  const PYTHON = ['lambda_function.py', 'app/__init__.py', 'app/api.py', 'fast.cpython-313-x86_64-linux-gnu.so', 'numpy/__init__.py'];

  it.each([
    ['index.handler', 'an ES module'],
    ['src/handlers/orders.create', 'a file in a folder'],
    ['src/handlers/orders.api.v1.get', 'a path through its exports'],
    ['lib/greet.handler', 'a folder, which Node.js loads index.js of'],
  ])('finds Node.js handler %s: %s', (handler) => {
    expect(packageHandlerProblem(NODE, handler, Runtime.NODEJS)).toBeUndefined();
  });

  it.each([
    ['lambda_function.lambda_handler', 'a module'],
    ['app.handler', "a package's __init__.py"],
    ['app/api.handler', 'a module in a package, written with a slash'],
    ['app.api.handler', 'the same, with a dot'],
    ['fast.handler', 'a compiled extension'],
  ])('finds Python handler %s: %s', (handler) => {
    expect(packageHandlerProblem(PYTHON, handler, Runtime.PYTHON)).toBeUndefined();
  });

  it('says which file it looked for, and how the runtime would have taken it', () => {
    expect(packageHandlerProblem(NODE, 'function.handler', Runtime.NODEJS)).toBe(
      'The package has no function.js, .mjs, .cjs or .ts, nor a folder function/, which the handler function.handler names',
    );
    expect(packageHandlerProblem(PYTHON, 'src/app.handler', Runtime.PYTHON)).toBe(
      'The package has no src/app.py, nor a package src/app/, which the handler src/app.handler names',
    );
    // A name that only starts like the module is another module, and another runtime's file is no module of this one.
    expect(packageHandlerProblem(['indexes.js', 'index.json'], 'index.handler', Runtime.NODEJS)).toMatch(/^The package has no index\.js/);
    expect(packageHandlerProblem(['src/app.js'], 'src/app.handler', Runtime.PYTHON)).toMatch(/^The package has no src\/app\.py/);
    expect(packageHandlerProblem(['src/app.py'], 'src/app.handler', Runtime.NODEJS)).toMatch(/^The package has no src\/app\.js/);
  });
});
