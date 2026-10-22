export async function handler(event: { n: number }) {
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { n: event.n, start, end: Date.now() };
}
