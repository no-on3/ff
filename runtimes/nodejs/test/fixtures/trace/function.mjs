// Gives back the trace the runtime set for the call, as Lambda sets _X_AMZN_TRACE_ID for each.
export const handler = async () => ({ trace: process.env._X_AMZN_TRACE_ID ?? null });
