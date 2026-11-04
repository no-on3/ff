import { ALL_FUNCTIONS, type AwsEndpoints, type CreatedStorageKey, type FunctionAccess, type StorageKey } from '../services/api';

/** An access key's name, as an IAM user's: contract.test.ts checks it against the API's. */
export const KEY_NAME = /^[\w+=,.@-]{1,64}$/;

/** Why the API would refuse the name; null when it would take it, an empty one too, which names the key its ID. */
export function keyNameProblem(name: string): string | null {
  return name === '' || KEY_NAME.test(name) ? null : "1 to 64 letters, digits and +=,.@_-, as an IAM user's name";
}

/** What each level lets a key do with its functions, as IAM groups Lambda's actions. */
export const FUNCTION_ACCESS_INFO: Record<FunctionAccess, { label: string; text: string }> = {
  read: { label: 'Read', text: "Lists and reads them, as Lambda's List and Read actions" },
  invoke: { label: 'Invoke', text: 'Reads and calls them, as InvokeFunction' },
  write: { label: 'Write', text: 'Every operation: it deploys, changes and deletes them too' },
};

/**
 * What a key reaches, in words: every bucket and queue of the account, and its
 * mail, when it names nothing; else those it names, its read-only theirs, and
 * its functions at their level.
 */
export function keyReach(key: Pick<StorageKey, 'buckets' | 'queues' | 'readOnly' | 'functions' | 'functionAccess'>): string {
  const storage = [key.buckets && `buckets ${key.buckets.join(', ')}`, key.queues && `queues ${key.queues.join(', ')}`].filter(Boolean).join('; ');
  const functions = key.functions && `${key.functions.includes(ALL_FUNCTIONS) ? 'every function' : `functions ${key.functions.join(', ')}`}, to ${key.functionAccess}`;
  if (!storage && !functions) return key.readOnly ? 'Every bucket and queue, and the mail, read-only' : 'Every bucket and queue, and the mail';
  const reach = [storage && (key.readOnly ? `${storage}, read-only` : storage), functions].filter(Boolean).join('; ');
  return reach.charAt(0).toUpperCase() + reach.slice(1);
}

type Variables = Array<[name: string, value: string]>;

/** What each of those variables is, in words, for the account page. */
export const ENDPOINT_LABELS: Record<string, string> = {
  AWS_REGION: 'Region',
  AWS_ENDPOINT_URL_S3: 'S3, for buckets',
  AWS_ENDPOINT_URL_SQS: 'SQS, for queues',
  AWS_ENDPOINT_URL_SESV2: 'SES, for mail',
  AWS_ENDPOINT_URL_LAMBDA: "Lambda's API, for functions",
};

/** The variables that say where FF is to AWS's SDKs and CLI: its region and its endpoints, functions' own aside. */
export function endpointVariables(aws: Omit<AwsEndpoints, 'sqsFunctionEndpoint'>): Variables {
  return [
    ['AWS_REGION', aws.region],
    ['AWS_ENDPOINT_URL_S3', aws.s3Endpoint],
    ['AWS_ENDPOINT_URL_SQS', aws.sqsEndpoint],
    ['AWS_ENDPOINT_URL_SESV2', aws.sesEndpoint],
    ['AWS_ENDPOINT_URL_LAMBDA', aws.lambdaEndpoint],
  ];
}

/** The variables AWS's SDKs and CLI read, for a key just made: to export in a shell, or set as a function's secrets. */
export function awsVariables(key: CreatedStorageKey): Variables {
  const { region, endpoint: s3Endpoint, sqsEndpoint, sesEndpoint, lambdaEndpoint } = key;
  return [['AWS_ACCESS_KEY_ID', key.id], ['AWS_SECRET_ACCESS_KEY', key.secretAccessKey], ...endpointVariables({ region, s3Endpoint, sqsEndpoint, sesEndpoint, lambdaEndpoint })];
}

/** Variables as shell lines. */
export const shellExports = (variables: Variables): string => variables.map(([name, value]) => `export ${name}=${value}`).join('\n');

/** A key's variables as shell lines. */
export const exportLines = (key: CreatedStorageKey): string => shellExports(awsVariables(key));

/** A command to try a key just made with, as on AWS: null for a key to functions alone. */
export function tryCommand(key: Pick<StorageKey, 'buckets' | 'queues' | 'functions'>, firstBucket?: string): string | null {
  if (key.buckets) return `aws s3 ls s3://${key.buckets[0]}`;
  if (key.queues) return 'aws sqs list-queues';
  if (key.functions) return null;
  return `aws s3 ls s3://${firstBucket ?? '<bucket>'}`;
}

/**
 * The form's choices for a new key. Its buckets and queues: all of them (and
 * the mail), some, or none; its functions: none, all or some, at one level. A
 * key that names functions names its buckets and queues too, or reaches none:
 * so "all" goes with no function, and "none" with some.
 */
export interface KeyDraft {
  name: string;
  storage: 'all' | 'some' | 'none';
  buckets: string[];
  queues: string[];
  readOnly: boolean;
  functions: 'none' | 'all' | 'some';
  functionNames: string[];
  functionAccess: FunctionAccess;
}

export const NEW_KEY: KeyDraft = { name: '', storage: 'all', buckets: [], queues: [], readOnly: false, functions: 'none', functionNames: [], functionAccess: 'invoke' };

/** The buckets-and-queues choices a draft may have: all of them with no function, none with some. */
export const storageChoices = (draft: Pick<KeyDraft, 'functions'>): Array<KeyDraft['storage']> => (draft.functions === 'none' ? ['all', 'some'] : ['none', 'some']);

/** The draft with its functions changed, its buckets and queues kept to a choice that goes with them. */
export function withFunctions(draft: KeyDraft, functions: KeyDraft['functions']): KeyDraft {
  const choices = storageChoices({ functions });
  return { ...draft, functions, storage: choices.includes(draft.storage) ? draft.storage : choices[0] };
}

/** What the draft would reach, in the list's words. */
export const draftReach = (draft: KeyDraft): string => keyReach(viewOf(draft));

/** Why the draft can't be sent yet; null when it can. */
export function draftProblem(draft: KeyDraft): string | null {
  const name = keyNameProblem(draft.name);
  if (name) return name;
  if (draft.storage === 'some' && draft.buckets.length + draft.queues.length === 0) return 'Pick a bucket or a queue, or choose another reach';
  if (draft.functions === 'some' && draft.functionNames.length === 0) return 'Pick a function, or choose all of them';
  return null;
}

/** POST /storage-keys's body for the draft: only what it names. */
export function requestOf(draft: KeyDraft): { name?: string; buckets?: string[]; queues?: string[]; readOnly: boolean; functions?: string[]; functionAccess?: FunctionAccess } {
  const { buckets, queues, readOnly, functions, functionAccess } = viewOf(draft);
  return {
    ...(draft.name !== '' && { name: draft.name }),
    ...(buckets && { buckets }),
    ...(queues && { queues }),
    readOnly,
    ...(functions && { functions, functionAccess: functionAccess ?? undefined }),
  };
}

/** The key the draft would make, as the list shows it. */
function viewOf(draft: KeyDraft): Pick<StorageKey, 'buckets' | 'queues' | 'readOnly' | 'functions' | 'functionAccess'> {
  const some = draft.storage === 'some';
  const functions = draft.functions === 'all' ? [ALL_FUNCTIONS] : draft.functions === 'some' && draft.functionNames.length > 0 ? draft.functionNames : null;
  return {
    buckets: some && draft.buckets.length > 0 ? draft.buckets : null,
    queues: some && draft.queues.length > 0 ? draft.queues : null,
    readOnly: draft.storage !== 'none' && draft.readOnly,
    functions,
    functionAccess: functions ? draft.functionAccess : null,
  };
}
