export async function handler(event: { body: { n: number } }) {
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { n: event.body.n, start, end: Date.now() };
}
