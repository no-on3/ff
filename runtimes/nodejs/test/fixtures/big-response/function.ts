// 7 MB: above the 6 MB response limit.
export async function handler(): Promise<string> {
  return 'x'.repeat(7 * 1024 * 1024);
}
