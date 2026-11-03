// The log of a call a caller of Lambda's Invoke asks for: both streams merged line by line, its last 4 KB.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOG_TAIL_BYTES, LogTail } from '../dist/log-tail.js';

const textOf = (tail) => Buffer.from(tail.base64(), 'base64').toString('utf8');

describe('LogTail', () => {
  it("keeps a line written in parts whole, the other stream's lines after it", () => {
    const tail = new LogTail();

    tail.line('START');
    tail.add('stdout', 'one, ');
    tail.add('stderr', 'an error\n');
    tail.add('stdout', 'two\nthree, ');
    tail.add('stdout', 'four\n');
    tail.line('END');

    assert.equal(textOf(tail), 'START\nan error\none, two\nthree, four\nEND\n');
  });

  it("ends the lines the streams left open before the runtime's own", () => {
    const tail = new LogTail();

    tail.add('stdout', 'open on stdout');
    tail.add('stderr', 'open on stderr');
    tail.line('END');
    tail.line('REPORT');

    assert.equal(textOf(tail), 'open on stdout\nopen on stderr\nEND\nREPORT\n');
  });

  it('gives back the last 4 KB, of a line left open as of the others', () => {
    const tail = new LogTail();

    tail.add('stdout', 'x'.repeat(3 * LOG_TAIL_BYTES));
    tail.line('END');
    const kept = Buffer.from(tail.base64(), 'base64');

    assert.equal(kept.length, LOG_TAIL_BYTES);
    assert.equal(kept.toString('utf8'), `${'x'.repeat(LOG_TAIL_BYTES - '\nEND\n'.length)}\nEND\n`);
  });
});
