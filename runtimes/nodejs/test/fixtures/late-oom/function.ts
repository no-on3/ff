// Returns its answer and, unless told not to, leaves work running that fills the heap: the worker dies
// once the call is answered.
export async function handler(event: { body: { hoard?: boolean } }, context: { awsRequestId: string }) {
  console.log(`${context.awsRequestId}: returning`);
  if (event.body.hoard !== false) {
    setImmediate(() => {
      const hoard: number[][] = [];
      for (;;) hoard.push(new Array(100_000).fill(1));
    });
  }
  return 'answered';
}
