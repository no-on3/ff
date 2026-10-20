import * as fs from 'node:fs';

// A relative path finds a file next to the code, as on AWS Lambda.
export async function handler() {
  return { cwd: process.cwd(), data: fs.readFileSync('data.txt', 'utf8').trim() };
}
