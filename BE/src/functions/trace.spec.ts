import {
  batchTrace,
  isTraceId,
  messageTrace,
  newTraceId,
  rootHeader,
  traceAttributes,
  traceOf,
  traceOfAttributes,
  traceRoot,
  traceSystemAttributes,
} from './trace';

const TRACE = '1-5759e988-bd862e3fe1be46a994272793';

describe("one request's trail: trace IDs as AWS X-Ray writes them (L1)", () => {
  it('makes a new ID of the time in seconds and 96 random bits, as X-Ray does', () => {
    const at = new Date('2016-06-09T22:11:20Z');
    const made = newTraceId(at);
    expect(made).toMatch(/^1-5759e988-[0-9a-f]{24}$/);
    expect(isTraceId(made)).toBe(true);
    expect(newTraceId(at)).not.toBe(made);
    expect(isTraceId(newTraceId())).toBe(true);
  });

  it("reads the trace a header names: its Root field's, the fields in any order, their names in any case", () => {
    expect(traceRoot(`Root=${TRACE}`)).toBe(TRACE);
    expect(traceRoot(`Root=${TRACE};Parent=53995c3f42cd8ad8;Sampled=1`)).toBe(TRACE);
    expect(traceRoot(`Sampled=0; root = ${TRACE.toUpperCase()} ;Lineage=a87bd80c:0`)).toBe(TRACE);
    expect(traceRoot([`Root=${TRACE}`, 'Root=1-00000000-000000000000000000000000'])).toBe(TRACE);
  });

  it('names none when the header names no trace in X-Ray\'s format', () => {
    for (const header of [undefined, '', TRACE, 'Root=', 'Root=1-5759e98-bd862e3fe1be46a994272793', `Root=2-${TRACE.slice(2)}`, `Root=${TRACE}0`, 'Parent=53995c3f42cd8ad8', 'Root=1-5759e988-bd862e3fe1be46a99427279g']) {
      expect(traceRoot(header)).toBeUndefined();
    }
    expect(traceRoot([])).toBeUndefined();
  });

  it("takes the caller's trace, or starts a new one, and names it as an answer gives it back", () => {
    expect(traceOf(`Root=${TRACE};Sampled=1`)).toBe(TRACE);
    expect(isTraceId(traceOf('nonsense'))).toBe(true);
    expect(traceOf(undefined)).not.toBe(traceOf(undefined));
    expect(rootHeader(TRACE)).toBe(`Root=${TRACE}`);
    expect(traceRoot(rootHeader(TRACE))).toBe(TRACE);
  });

  it("keeps an asynchronous call's trace beside its event, and reads it back; an event kept before has none", () => {
    expect(traceOfAttributes({ qualifier: 'live', ...traceAttributes(TRACE), failures: 1 })).toBe(TRACE);
    expect([traceOfAttributes(null), traceOfAttributes(undefined), traceOfAttributes({ trace: 42 }), traceOfAttributes({ trace: 'Root=1-…' })]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("carries a trace in a queue message's AWSTraceHeader, as SQS keeps one, and reads it back", () => {
    expect(traceSystemAttributes(TRACE)).toEqual({ AWSTraceHeader: { DataType: 'String', StringValue: `Root=${TRACE}` } });
    expect(messageTrace(traceSystemAttributes(TRACE))).toBe(TRACE);
    expect(messageTrace({ AWSTraceHeader: { DataType: 'String', StringValue: `Root=${TRACE};Parent=53995c3f42cd8ad8;Sampled=1` } })).toBe(TRACE);
    expect([messageTrace(undefined), messageTrace({}), messageTrace({ AWSTraceHeader: { DataType: 'String', StringValue: 'none' } })]).toEqual([undefined, undefined, undefined]);
  });

  it("joins a batch to its first message's trace that has one, else starts one, named by the batch's first message", () => {
    const message = (messageId: string, header?: string) => ({
      messageId,
      meta: header ? { systemAttributes: { AWSTraceHeader: { DataType: 'String', StringValue: header } } } : {},
    });
    const other = '1-5759e989-000000000000000000000001';
    expect(batchTrace([message('m-1'), message('m-2', 'Root=nope'), message('m-3', `Root=${TRACE}`), message('m-4', `Root=${other}`)])).toEqual({
      traceId: TRACE,
      messageId: 'm-3',
    });
    const started = batchTrace([message('m-1'), message('m-2')]);
    expect(started.messageId).toBe('m-1');
    expect(isTraceId(started.traceId)).toBe(true);
  });
});
