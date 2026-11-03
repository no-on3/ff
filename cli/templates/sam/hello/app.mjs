// {{name}}'s function: AWS Lambda's handler, which FF calls as Lambda does. Its URL's calls bring the query in
// queryStringParameters; ff invoke's, the event itself. STAGE comes from the template.
export const handler = async (event) => {
  const name = event.queryStringParameters?.name ?? event.name ?? 'world';
  console.log(`greeting ${name}`); // a line of the function's log: ff logs <its name>
  return { message: `Hello ${name}`, stage: process.env.STAGE };
};
