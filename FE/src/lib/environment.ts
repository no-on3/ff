/**
 * AWS Lambda's rule for a variable's name, which the API applies: a letter
 * first, then letters, digits or underscores, two characters at least.
 * contract.test.ts checks it, and the lists below, against the API's.
 */
export const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]+$/;

/** The most a function's variables and secrets may hold together, as AWS Lambda counts it: the JSON text of the map. */
export const MAX_ENVIRONMENT_BYTES = 4096;

/** The names AWS Lambda sets itself, which the API refuses. */
export const LAMBDA_RESERVED = [
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

/** The names FF's runtimes read or start with, which the API refuses too; and every name starting with FF_. */
export const FF_RESERVED = ['FUNCTION_NAME', 'FUNCTION_VERSION', 'FUNCTION_MEMORY_LIMIT', 'FUNCTION_TIMEOUT', 'PORT', 'PATH'];

const RESERVED = new Set([...LAMBDA_RESERVED, ...FF_RESERVED]);

/** One row of the editor: a name and its value, as typed. */
export interface VariableRow {
  name: string;
  value: string;
}

/** A function's variables as rows, by name. */
export function rowsOf(environment: Record<string, string> | undefined): VariableRow[] {
  return Object.entries(environment ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value }));
}

/** The rows as the API takes them: a map, without the rows left empty. */
export function environmentOf(rows: VariableRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter((row) => row.name.trim() !== '' || row.value !== '').map((row) => [row.name.trim(), row.value]));
}

/** The size of variables as AWS Lambda measures it: the bytes of their JSON text. */
export function environmentBytes(environment: Record<string, string>): number {
  return new TextEncoder().encode(JSON.stringify(environment)).length;
}

/** Why a name can't be a variable's, as the API would say it; undefined when it can. */
export function nameProblem(name: string): string | undefined {
  if (!VARIABLE_NAME.test(name)) return `"${name}" is not a variable name: a letter first, then letters, digits or underscores, two characters at least`;
  if (RESERVED.has(name)) return `${name} is reserved: AWS Lambda or FF's runtime sets it`;
  if (name.startsWith('FF_')) return `${name} is reserved: names starting with FF_ are FF's own`;
  return undefined;
}

/**
 * What would keep the rows from being saved: a name twice, a name the API
 * refuses or a secret has, or more than 4 KB. Empty when they can be saved.
 * The API counts the secrets in the 4 KB too, which only it can.
 */
export function environmentProblems(rows: VariableRow[], secretNames: string[] = []): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (name === '' && row.value === '') continue;
    const problem = name === '' ? 'Every variable needs a name' : nameProblem(name);
    if (problem) problems.push(problem);
    else if (seen.has(name)) problems.push(`${name} is there twice`);
    else if (secretNames.includes(name)) problems.push(`${name} is a secret already: a name is a variable or a secret, not both`);
    seen.add(name);
  }
  const bytes = environmentBytes(environmentOf(rows));
  if (bytes > MAX_ENVIRONMENT_BYTES) problems.push(`The variables are ${bytes} bytes as JSON text: AWS Lambda allows ${MAX_ENVIRONMENT_BYTES} (4 KB)`);
  return problems;
}

/** Whether two maps of variables hold the same names and values. */
export function sameEnvironment(a: Record<string, string>, b: Record<string, string>): boolean {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((name) => Object.prototype.hasOwnProperty.call(b, name) && a[name] === b[name]);
}
