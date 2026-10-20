// Whether this thread loaded the TypeScript compiler: it must have, to compile this file.
export async function handler(): Promise<{ typescriptLoaded: boolean }> {
  return { typescriptLoaded: Object.keys(require.cache).some((file) => file.includes('/node_modules/typescript/')) };
}
