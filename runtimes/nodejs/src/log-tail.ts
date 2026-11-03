/** How much of a call's log Lambda gives back with LogType Tail: its last 4 KB. */
export const LOG_TAIL_BYTES = 4096;

export type Stream = 'stdout' | 'stderr';

/**
 * A call's log, from its START to its REPORT, as the runtime writes it: the
 * runtime's lines and what the handler wrote, on both streams, merged line by
 * line. A line a stream left open waits for its end, so that the other
 * stream's lines don't split it, and the runtime's next line ends it. It gives
 * the last LOG_TAIL_BYTES in base64, as Lambda's X-Amz-Log-Result.
 */
export class LogTail {
  private kept = '';
  /** What each stream wrote of a line it hasn't ended yet. */
  private readonly open: Record<Stream, string> = { stdout: '', stderr: '' };

  /** What the worker wrote on a stream: its lines are kept as they end. */
  add(stream: Stream, text: string): void {
    const held = this.open[stream] + text;
    const end = held.lastIndexOf('\n') + 1;
    this.open[stream] = held.slice(end).slice(-LOG_TAIL_BYTES);
    this.keep(held.slice(0, end));
  }

  /** One of the runtime's own lines, after each line the streams left open, ended. */
  line(text: string): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (this.open[stream]) this.keep(`${this.open[stream]}\n`);
      this.open[stream] = '';
    }
    this.keep(`${text}\n`);
  }

  base64(): string {
    return Buffer.from(this.kept, 'utf8').subarray(-LOG_TAIL_BYTES).toString('base64');
  }

  private keep(text: string): void {
    this.kept += text;
    // A character is one byte of UTF-8 at least: as many characters hold the bytes kept.
    if (this.kept.length > 2 * LOG_TAIL_BYTES) this.kept = this.kept.slice(-LOG_TAIL_BYTES);
  }
}
