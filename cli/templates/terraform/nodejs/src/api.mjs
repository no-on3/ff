// {{name}}'s API, called through its URL with Lambda's event for one (its payload's version 2.0); the answer is
// the URL's: a status, headers and a body.
export async function handler(event) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: process.env.APP, method: event.requestContext?.http?.method, path: event.rawPath }),
  };
}
