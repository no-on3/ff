// FF's status canary (../template.yaml): the probe calls it each minute, through Lambda's endpoint and at its URL, and
// finds these words in its answer.
export const handler = async () => ({
  statusCode: 200,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  body: "FF's status canary\n",
});
