// {{name}}: a function in TypeScript, with AWS Lambda's handler: FF calls handler(event, context),
// and event is what the caller sent, as a payload is on Lambda. The code moves to Lambda as it is.
export async function handler(event: { name?: string }, context: { awsRequestId: string }) {
  const name = event.name ?? 'world';
  console.log(`greeting ${name}`); // a line of the function's log: ff logs {{name}}
  return { message: `Hello ${name}`, requestId: context.awsRequestId };
}
