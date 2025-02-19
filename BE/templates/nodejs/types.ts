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
