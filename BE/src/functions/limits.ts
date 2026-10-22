/** A function's inline code, one file: 3 MiB, as AWS Lambda's console takes code in its editor; more comes as a package. */
export const MAX_CODE_BYTES = 3 * 1024 * 1024;

/** An invocation's input, once serialized: AWS Lambda's limit for a synchronous call's payload, 6 MB. */
export const MAX_INPUT_BYTES = 6 * 1024 * 1024;

/** A function's metadata, as JSON: labels for its owner, not a store. */
export const MAX_METADATA_BYTES = 4 * 1024;
