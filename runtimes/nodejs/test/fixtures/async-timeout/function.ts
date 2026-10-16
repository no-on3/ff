export async function handler(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  return 'too late';
}
