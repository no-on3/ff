import { ValidateBy } from 'class-validator';

/** AWS's limits on a resource's tags, which Lambda's are: 50 a resource, a key of 128 characters, a value of 256. */
export const TAG_LIMITS = { perResource: 50, keyLength: 128, valueLength: 256 } as const;

/** What a tag's key and value may hold, as AWS says: letters, digits and spaces, and + - = . _ : / @. */
const CHARACTERS = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]*$/u;

/** AWS keeps tags whose key starts with aws: for its own. */
const RESERVED = /^aws:/i;

/**
 * Why tags can't be put on a resource that has `existing`, or undefined when
 * they can: a key empty, too long, reserved or with a character AWS doesn't
 * take, a value too long or with one, or more than 50 on the resource once
 * they are put, a key already there counting once.
 */
export function tagsProblem(existing: Record<string, string>, adding: Record<string, string>): string | undefined {
  const keys = Object.keys(adding);
  if (keys.length === 0) return 'Tags must hold at least one tag.';
  for (const key of keys) {
    const value = adding[key];
    if (key.length === 0 || [...key].length > TAG_LIMITS.keyLength) return `A tag's key holds 1 to ${TAG_LIMITS.keyLength} characters: ${key || 'an empty one'} doesn't.`;
    if (RESERVED.test(key)) return `The key ${key} starts with aws:, which AWS keeps for its own tags.`;
    if (!CHARACTERS.test(key)) return `The key ${key} holds a character a tag can't: letters, digits, spaces and + - = . _ : / @ only.`;
    if ([...value].length > TAG_LIMITS.valueLength) return `The value of ${key} is longer than a tag's ${TAG_LIMITS.valueLength} characters.`;
    if (!CHARACTERS.test(value)) return `The value of ${key} holds a character a tag can't: letters, digits, spaces and + - = . _ : / @ only.`;
  }
  const total = new Set([...Object.keys(existing), ...keys]).size;
  if (total > TAG_LIMITS.perResource) return `A resource has at most ${TAG_LIMITS.perResource} tags: these would make it ${total}.`;
  return undefined;
}

/** Why a body's tags, all of a resource's, can't be: not an object of strings, or tags AWS wouldn't take. None is no tags. */
export function allTagsProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return "Tags are an object, each tag's value by its key.";
  const notText = Object.entries(value).find(([, tag]) => typeof tag !== 'string');
  if (notText) return `The value of ${notText[0]} is a string, as every tag's is.`;
  return Object.keys(value).length === 0 ? undefined : tagsProblem({}, value as Record<string, string>);
}

/** A body's tags, all of a resource's, as allTagsProblem checks them. */
export const IsTags = (): PropertyDecorator =>
  ValidateBy({
    name: 'isTags',
    validator: {
      validate: (value: unknown) => allTagsProblem(value) === undefined,
      defaultMessage: (args) => allTagsProblem(args?.value) ?? '',
    },
  });
