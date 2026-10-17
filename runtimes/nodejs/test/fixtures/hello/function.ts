// Uses TypeScript-only syntax (enum, interfaces) to prove full transpilation.
enum Greeting {
  Hello = 'Hello',
}

interface Event {
  body: { name?: string };
}

interface Context {
  functionName: string;
  memoryLimitInMB: string;
  awsRequestId: string;
  getRemainingTimeInMillis(): number;
}

export async function handler(event: Event, context: Context) {
  return {
    message: `${Greeting.Hello} ${event.body.name ?? 'world'}`,
    functionName: context.functionName,
    memoryLimitInMB: context.memoryLimitInMB,
    requestId: context.awsRequestId,
    remainingMs: context.getRemainingTimeInMillis(),
    // Removed with callback handlers, as in Lambda's Node.js 24 runtime.
    hasCallbackWaitsForEmptyEventLoop: 'callbackWaitsForEmptyEventLoop' in context,
  };
}
