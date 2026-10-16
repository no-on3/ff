// A Node.js function in TypeScript. FF calls handler(event, context), as AWS Lambda does.
// event.body is the "input" sent to POST /functions/:id/invoke.
export async function handler(event: { body: { name?: string } }, context: { awsRequestId: string }) {
  const name = event.body.name ?? 'world';
  console.log(`greeting ${name}`); // shows up in the function pod's logs
  return { message: `Hello ${name}`, requestId: context.awsRequestId };
}
