// An ES module, as AWS Lambda's Node.js runtime imports a .mjs handler: its top-level await runs once, before
// the first call. It says whether it is one: an ES module has no require of its own.
const greeting = await Promise.resolve('Hello');

export const handler = async (event) => ({ message: `${greeting} ${event.name ?? 'world'}`, esModule: typeof require === 'undefined' });
