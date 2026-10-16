// A TypeScript syntax error. The transpiler alone would "recover" and run `return {}`.
export async function handler() {
  return {{{;
}
