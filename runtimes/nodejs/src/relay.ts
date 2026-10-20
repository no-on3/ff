import { END_OF_CALL } from './protocol';

/**
 * Forwards a worker's stdout or stderr to this process's, as it comes, and
 * takes out the end-of-call markers the worker writes (END_OF_CALL), calling
 * `onEndOfCall` with a call's ID once everything the worker wrote before it
 * is forwarded. A marker may come split across chunks: what may be its start
 * is held back until the next chunk.
 */
export class OutputRelay {
  private carry = '';
  private atLineStart = true;

  constructor(
    private readonly out: { write(text: string): unknown },
    private readonly onEndOfCall: (id: number) => void,
  ) {}

  write(chunk: string): void {
    let text = this.carry + chunk;
    this.carry = '';
    for (let at = text.indexOf(END_OF_CALL); at >= 0; at = text.indexOf(END_OF_CALL)) {
      const end = text.indexOf('\n', at);
      if (end < 0) break; // the marker's ID isn't all here yet
      this.forward(text.slice(0, at));
      const id = Number(text.slice(at + END_OF_CALL.length, end));
      text = text.slice(end + 1);
      this.onEndOfCall(id);
    }
    const held = this.heldFrom(text);
    this.forward(text.slice(0, held));
    this.carry = text.slice(held);
  }

  /** What is held back, forwarded as it is: the worker has exited. */
  flush(): void {
    this.forward(this.carry);
    this.carry = '';
  }

  /** Ends a line the user's output left open, so that the runtime's next line starts a line of its own. */
  endLine(): void {
    if (!this.atLineStart) this.forward('\n');
  }

  /** Where a marker, whole or only begun, starts at the end of the text; the text's length when none does. */
  private heldFrom(text: string): number {
    const whole = text.indexOf(END_OF_CALL);
    if (whole >= 0) return whole;
    for (let i = Math.max(0, text.length - END_OF_CALL.length + 1); i < text.length; i++) {
      if (END_OF_CALL.startsWith(text.slice(i))) return i;
    }
    return text.length;
  }

  private forward(text: string): void {
    if (!text) return;
    this.out.write(text);
    this.atLineStart = text.endsWith('\n');
  }
}
