import { randomBytes } from 'node:crypto';
import { ValidationOptions, registerDecorator } from 'class-validator';

/** AWS Lambda's rule for a variable's name: a letter first, then letters, digits or underscores, two characters at least. */
export const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]+$/;

/**
 * The most a function's environment may hold, as AWS Lambda counts it: the
 * JSON text of all its variables, 4 KB. Secrets count too, so that both fit
 * in Lambda's variables when the function moves there.
 */
export const MAX_ENVIRONMENT_BYTES = 4096;

/** The names AWS Lambda sets itself and refuses in a function's configuration (its documentation's "reserved environment variables"). */
const LAMBDA_RESERVED = [
  '_HANDLER',
  '_X_AMZN_TRACE_ID',
  'AWS_DEFAULT_REGION',
  'AWS_REGION',
  'AWS_EXECUTION_ENV',
  'AWS_LAMBDA_FUNCTION_NAME',
  'AWS_LAMBDA_FUNCTION_MEMORY_SIZE',
  'AWS_LAMBDA_FUNCTION_VERSION',
  'AWS_LAMBDA_INITIALIZATION_TYPE',
  'AWS_LAMBDA_LOG_GROUP_NAME',
  'AWS_LAMBDA_LOG_STREAM_NAME',
  'AWS_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_LAMBDA_RUNTIME_API',
  'LAMBDA_TASK_ROOT',
  'LAMBDA_RUNTIME_DIR',
  'AWS_LAMBDA_MAX_CONCURRENCY',
  'AWS_LAMBDA_METADATA_API',
  'AWS_LAMBDA_METADATA_TOKEN',
];

/**
 * FF's runtimes read these, and start with PATH: a function setting one would
 * change how its runtime runs, not just its own code. Every name starting with
 * FF_ is FF's too.
 */
const FF_RESERVED = ['FUNCTION_NAME', 'FUNCTION_VERSION', 'FUNCTION_MEMORY_LIMIT', 'FUNCTION_TIMEOUT', 'PORT', 'PATH'];

const RESERVED = new Set([...LAMBDA_RESERVED, ...FF_RESERVED]);

/** Why a name can't be a variable's, or undefined when it can. */
export function nameProblem(name: string): string | undefined {
  if (!VARIABLE_NAME.test(name)) {
    const shown = name.length > 64 ? `${name.slice(0, 64)}…` : name;
    return `${JSON.stringify(shown)} is not a variable name: a letter first, then letters, digits or underscores, two characters at least, as on AWS Lambda`;
  }
  if (RESERVED.has(name)) return `${name} is reserved: AWS Lambda or FF's runtime sets it`;
  if (name.startsWith('FF_')) return `${name} is reserved: names starting with FF_ are FF's own`;
  return undefined;
}

/** The size of variables as AWS Lambda measures it: the bytes of their JSON text. */
export function environmentBytes(values: Record<string, string>): number {
  return Buffer.byteLength(JSON.stringify(values), 'utf8');
}

/** The answer when the variables and secrets together are larger than Lambda allows. */
export function tooLarge(bytes: number): string {
  return `The environment is ${bytes} bytes as JSON text: AWS Lambda allows ${MAX_ENVIRONMENT_BYTES} (4 KB) for a function's variables and secrets together`;
}

/**
 * What is wrong with an environment as an API caller sent it: a JSON object of
 * names to strings, the names free, and 4 KB at most. Each problem names the
 * variable, never its value.
 */
export function environmentProblems(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['environment must be a JSON object of variable names to string values'];
  }
  const problems: string[] = [];
  for (const [name, variable] of Object.entries(value)) {
    const problem = nameProblem(name);
    if (problem) problems.push(problem);
    else if (typeof variable !== 'string') problems.push(`${name}'s value must be a string, as every variable's is on AWS Lambda`);
  }
  if (problems.length === 0) {
    const bytes = environmentBytes(value as Record<string, string>);
    if (bytes > MAX_ENVIRONMENT_BYTES) problems.push(tooLarge(bytes));
  }
  return problems;
}

/** Validates an environment property: environmentProblems' rules, one message for all its problems. */
export function IsEnvironment(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: 'isEnvironment',
      target: target.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate: (value: unknown) => environmentProblems(value).length === 0,
        defaultMessage: (args) => environmentProblems(args?.value).join('; '),
      },
    });
}

/** A secret, as the function's environment keeps it: its value, and when it was set. */
export interface StoredSecret {
  value: string;
  updatedAt: string;
}

/** A function's environment, as it is sealed in the database. */
export interface EnvironmentDocument {
  /** Configuration: readable by whoever reads the function. */
  variables: Record<string, string>;
  /** Write-only values: read by the function alone. */
  secrets: Record<string, StoredSecret>;
}

/** A function's environment, with the revision its Deployment names. */
export interface FunctionEnvironmentValues extends EnvironmentDocument {
  /** Random, new with every change; never derived from the values. Empty when there is nothing. */
  revision: string;
}

export const NO_ENVIRONMENT: FunctionEnvironmentValues = { revision: '', variables: {}, secrets: {} };

/** A new revision: random, so that it says nothing about the values. */
export function newRevision(): string {
  return randomBytes(8).toString('hex');
}

/** Whether the environment holds anything at all. */
export function isEmpty(environment: EnvironmentDocument): boolean {
  return Object.keys(environment.variables).length === 0 && Object.keys(environment.secrets).length === 0;
}

/** What the function's process gets: its variables and its secrets' values, as one map. */
export function processEnvironment(environment: EnvironmentDocument): Record<string, string> {
  const secrets = Object.fromEntries(Object.entries(environment.secrets).map(([name, secret]) => [name, secret.value]));
  return { ...environment.variables, ...secrets };
}

/** Whether two maps of variables hold the same names and values. */
export function sameVariables(a: Record<string, string>, b: Record<string, string>): boolean {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((name) => Object.prototype.hasOwnProperty.call(b, name) && a[name] === b[name]);
}

/** Which variables a change added, changed and removed: names only, for the audit log. */
export function variableChanges(before: Record<string, string>, after: Record<string, string>): { added: string[]; changed: string[]; removed: string[] } {
  const has = (map: Record<string, string>, name: string) => Object.prototype.hasOwnProperty.call(map, name);
  return {
    added: Object.keys(after).filter((name) => !has(before, name)).sort(),
    changed: Object.keys(after).filter((name) => has(before, name) && before[name] !== after[name]).sort(),
    removed: Object.keys(before).filter((name) => !has(after, name)).sort(),
  };
}
