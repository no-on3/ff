// Replaces process.stdout.write when it loads, as a logging library might, to prefix what it writes.
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string, ...rest: never[]) => write(`[app] ${chunk}`, ...rest)) as typeof process.stdout.write;

export async function handler(_event: unknown, context: { awsRequestId: string }) {
  console.log(`${context.awsRequestId}: hello`);
  return 'ok';
}
