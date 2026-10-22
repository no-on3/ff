// A Node.js function in TypeScript. FF calls handler(event, context), as AWS Lambda does.
// The event is the "input" sent to POST /functions/:id/invoke, as a payload is on AWS Lambda.
export async function handler(event: { name?: string }, context: { awsRequestId: string }) {
  const name = event.name ?? 'world';
  console.log(`greeting ${name}`); // shows up in the function pod's logs
  return { message: `Hello ${name}`, requestId: context.awsRequestId };
}
