// L1 tests for OutputRelay, which forwards the worker's output and takes out its end-of-call markers.
// The worker's streams come in chunks of any size, so a marker can be split anywhere. Run: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { END_OF_CALL } from '../dist/protocol.js';
import { OutputRelay } from '../dist/relay.js';

function relay() {
  const out = [];
  const ended = [];
  const r = new OutputRelay({ write: (text) => out.push(text) }, (id) => ended.push({ id, after: out.join('') }));
  return { r, out: () => out.join(''), ended };
}

describe('OutputRelay', () => {
  const stream = `a line\n${END_OF_CALL}7\nnext call's line\n${END_OF_CALL}8\n`;

  it('forwards the output without its markers, and reports each call once all it wrote before is forwarded', () => {
    const { r, out, ended } = relay();
    r.write(stream);
    assert.equal(out(), "a line\nnext call's line\n");
    assert.deepEqual(ended, [
      { id: 7, after: 'a line\n' },
      { id: 8, after: "a line\nnext call's line\n" },
    ]);
  });

  it('finds a marker split at any point between two chunks, or into single characters', () => {
    for (let cut = 1; cut < stream.length; cut++) {
      const { r, out, ended } = relay();
      r.write(stream.slice(0, cut));
      r.write(stream.slice(cut));
      assert.equal(out(), "a line\nnext call's line\n", `cut at ${cut}`);
      assert.deepEqual(ended.map((e) => e.id), [7, 8], `cut at ${cut}`);
    }
    const { r, out, ended } = relay();
    for (const char of stream) r.write(char);
    assert.equal(out(), "a line\nnext call's line\n");
    assert.deepEqual(ended, [
      { id: 7, after: 'a line\n' },
      { id: 8, after: "a line\nnext call's line\n" },
    ]);
  });

  it("holds back only what may begin a marker, forwards it once the next chunk shows it doesn't, and flushes what is held", () => {
    const { r, out, ended } = relay();
    r.write('text\u0000ff-');
    assert.equal(out(), 'text');
    r.write('nothing\n');
    assert.equal(out(), 'text\u0000ff-nothing\n');
    r.write('the end, cut short\u0000ff-end');
    r.flush(); // the worker exited
    assert.equal(out(), 'text\u0000ff-nothing\nthe end, cut short\u0000ff-end');
    assert.deepEqual(ended, []);
  });

  it('ends a line the output left open, and only then', () => {
    const { r, out } = relay();
    r.endLine();
    r.write('left open');
    r.endLine();
    r.endLine();
    r.write(`whole\n${END_OF_CALL}1\n`);
    r.endLine();
    assert.equal(out(), 'left open\nwhole\n');
  });
});
