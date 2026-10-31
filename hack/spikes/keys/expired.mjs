// Answers every signed request as AWS answers one signed with a key that has expired, in the words of the service its
// signature names (the credential's scope): S3's ExpiredToken in XML; SQS's ExpiredToken in its JSON protocol, the
// query protocol's code in x-amzn-query-error as SQS sends it; SES's and Lambda's ExpiredTokenException in JSON. It
// counts the requests each service got: GET /count, unsigned, answers them as JSON. It prints the port it listens on.
//   node expired.mjs
import http from 'node:http';

const counts = {};
const EXPIRED = 'The security token included in the request is expired';

function answer(service, response) {
  if (service === 's3') {
    response.writeHead(400, { 'content-type': 'application/xml' });
    response.end('<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>ExpiredToken</Code><Message>The provided token has expired.</Message>' +
      '<RequestId>SPIKE</RequestId><HostId>SPIKE</HostId></Error>');
  } else if (service === 'sqs') {
    response.writeHead(403, { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-query-error': 'ExpiredToken;Sender' });
    response.end(JSON.stringify({ __type: 'com.amazon.coral.service#ExpiredTokenException', message: EXPIRED }));
  } else {
    response.writeHead(403, { 'content-type': 'application/json', 'x-amzn-errortype': 'ExpiredTokenException' });
    response.end(JSON.stringify({ message: EXPIRED }));
  }
}

const server = http.createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    if (request.method === 'GET' && request.url === '/count') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(counts));
      return;
    }
    // AWS4-HMAC-SHA256 Credential=<key>/<date>/<region>/<service>/aws4_request, …
    const service = /Credential=[^/]+\/[^/]+\/[^/]+\/([^/]+)\//.exec(request.headers.authorization ?? '')?.[1] ?? 'unsigned';
    counts[service] = (counts[service] ?? 0) + 1;
    answer(service, response);
  });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
