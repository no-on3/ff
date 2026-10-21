/** A function's code, one file: what a ConfigMap holds (1 MiB), less a margin for its keys and metadata. */
export const MAX_CODE_BYTES = 900 * 1024;

/** An invocation's input, once serialized: AWS Lambda's limit for a synchronous call's payload, 6 MB. */
export const MAX_INPUT_BYTES = 6 * 1024 * 1024;

/** A function's metadata, as JSON: labels for its owner, not a store. */
export const MAX_METADATA_BYTES = 4 * 1024;
