export interface FunctionEvent {
  body: any;
  headers: Record<string, string>;
  method: string;
  query: Record<string, string>;
  path: string;
}

export interface FunctionContext {
  functionName: string;
  functionVersion: string;
  memoryLimitInMB: number;
  getRemainingTimeInMillis: () => number;
}

export async function handler(event: FunctionEvent, context: FunctionContext): Promise<any> {
  console.log('Event:', event);
  console.log('Context:', context);
  
  // Your function logic here
  return {
    message: 'Hello from TypeScript function!',
    input: event.body,
    remainingTime: context.getRemainingTimeInMillis(),
  };
}
