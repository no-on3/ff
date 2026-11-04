// Gives back what the caller said of itself, as Lambda passes a synchronous call's ClientContext on.
export const handler = async (_event, context) => ({ clientContext: context.clientContext ?? null, given: 'clientContext' in context });
