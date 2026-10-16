// With spin=true the handler never yields: only terminating the worker stops it.
export function handler(event: { body: { spin?: boolean } }): string {
  if (event.body.spin) {
    for (;;) {
      // busy
    }
  }
  return 'ok';
}
