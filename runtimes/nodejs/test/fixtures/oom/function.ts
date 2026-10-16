const hoard: number[][] = [];

export async function handler(): Promise<never> {
  for (;;) hoard.push(new Array(1_000_000).fill(1));
}
