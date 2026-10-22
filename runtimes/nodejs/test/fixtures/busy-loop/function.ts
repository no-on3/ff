// With spin=true the handler never yields: only terminating the worker stops it.
export function handler(event: { spin?: boolean }): string {
  if (event.spin) {
    for (;;) {
      // busy
    }
  }
  return 'ok';
}
