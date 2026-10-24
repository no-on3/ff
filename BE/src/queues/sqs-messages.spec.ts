import { createHash } from 'node:crypto';
import { SqsError } from './sqs-error';
import { attributesMd5, checkBody, checkMessageAttributes, checkSystemAttributes, messageSize, parseReceiptHandle, receiptHandle } from './sqs-messages';

const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex');
/** A part of SQS's encoding of attributes: its length in 4 bytes, big-endian, then its bytes. */
const part = (bytes: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes]);
const utf8 = (text: string) => Buffer.from(text, 'utf8');

function refusal(check: () => unknown): { type: string; message: string } {
  try {
    check();
  } catch (error) {
    if (error instanceof SqsError) return { type: error.type, message: error.message };
    throw error;
  }
  throw new Error('not refused');
}

describe("SQS's messages", () => {
  describe('a body', () => {
    it("takes any text of the characters SQS allows: Arabic, emoji, tabs and new lines", () => {
      const body = 'سلام 👋\tline\nnext\r\n{"item":"harissa"}';
      expect(checkBody(body)).toBe(body);
    });

    it('refuses an empty body, or none, as SQS does', () => {
      expect(refusal(() => checkBody(''))).toEqual({ type: 'InvalidParameterValue', message: 'The request must contain a non-empty message body.' });
      expect(refusal(() => checkBody(undefined)).type).toBe('MissingParameter');
      expect(refusal(() => checkBody(42)).type).toBe('InvalidParameterValue');
    });

    it("refuses characters XML 1.0 doesn't allow: control characters, a lone surrogate, U+FFFE", () => {
      for (const body of ['a\u0000b', 'bell\u0007', 'lone \ud800 surrogate', 'not a character ￾', '￿']) {
        expect(refusal(() => checkBody(body)).type).toBe('InvalidMessageContents');
      }
    });
  });

  describe("a message's attributes", () => {
    it('takes strings, numbers and binary, with custom types', () => {
      const attributes = {
        color: { DataType: 'String', StringValue: 'red' },
        quantity: { DataType: 'Number.int', StringValue: '-2.5e3' },
        picture: { DataType: 'Binary.png', BinaryValue: Buffer.from([1, 2, 3]).toString('base64') },
      };
      expect(checkMessageAttributes(attributes)).toEqual(attributes);
    });

    it('refuses more than ten, as SQS does', () => {
      const attributes = Object.fromEntries(Array.from({ length: 11 }, (_, n) => [`a${n}`, { DataType: 'String', StringValue: 'x' }]));
      expect(refusal(() => checkMessageAttributes(attributes))).toEqual({
        type: 'InvalidParameterValue',
        message: 'Number of message attributes [11] exceeds the allowed maximum [10].',
      });
    });

    it("refuses names SQS refuses: AWS.'s and Amazon.'s, dots first, last or twice, other characters", () => {
      for (const name of ['AWS.thing', 'amazon.thing', '.first', 'last.', 'two..dots', 'space name', 'é']) {
        expect(refusal(() => checkMessageAttributes({ [name]: { DataType: 'String', StringValue: 'x' } })).type).toBe('InvalidParameterValue');
      }
    });

    it('refuses a value that is not its type: a number that is none, binary that is not base64, none at all, lists', () => {
      const refused = (attribute: unknown) => refusal(() => checkMessageAttributes({ thing: attribute })).type;
      expect(refused({ DataType: 'Number', StringValue: 'twelve' })).toBe('InvalidParameterValue');
      expect(refused({ DataType: 'Binary', BinaryValue: 'not base64!' })).toBe('InvalidParameterValue');
      expect(refused({ DataType: 'Binary', StringValue: 'text' })).toBe('InvalidParameterValue');
      expect(refused({ DataType: 'String', StringValue: '' })).toBe('InvalidParameterValue');
      expect(refused({ DataType: 'Date', StringValue: 'today' })).toBe('InvalidParameterValue');
      expect(refused({ DataType: 'String', StringListValues: ['a', 'b'] })).toBe('InvalidParameterValue');
      expect(refused({ DataType: 'String', StringValue: 'nul\u0000' })).toBe('InvalidMessageContents');
    });

    it('takes AWSTraceHeader alone as a system attribute', () => {
      const trace = { AWSTraceHeader: { DataType: 'String', StringValue: 'Root=1-5759e988-bd862e3fe1be46a994272793' } };
      expect(checkSystemAttributes(trace)).toEqual(trace);
      expect(refusal(() => checkSystemAttributes({ SenderId: { DataType: 'String', StringValue: 'me' } })).type).toBe('InvalidParameterValue');
    });
  });

  describe("SQS's MD5 of a message's attributes", () => {
    it("is the MD5 of each attribute's name, type and value, each length-prefixed, a byte 1 before a string's value", () => {
      // The encoding as SQS's documentation describes it, written out by hand.
      const bytes = Buffer.concat([part(utf8('color')), part(utf8('String')), Buffer.from([1]), part(utf8('red'))]);
      expect(attributesMd5({ color: { DataType: 'String', StringValue: 'red' } })).toBe(md5(bytes));
    });

    it("takes the attributes by name, and a byte 2 before binary's value, its bytes rather than its base64", () => {
      const picture = Buffer.from([0xff, 0x00, 0x7f]);
      const bytes = Buffer.concat([
        part(utf8('a-picture')),
        part(utf8('Binary.png')),
        Buffer.from([2]),
        part(picture),
        part(utf8('b-quantity')),
        part(utf8('Number')),
        Buffer.from([1]),
        part(utf8('12')),
      ]);
      expect(
        attributesMd5({
          'b-quantity': { DataType: 'Number', StringValue: '12' },
          'a-picture': { DataType: 'Binary.png', BinaryValue: picture.toString('base64') },
        }),
      ).toBe(md5(bytes));
    });

    it('is none for no attributes: SQS answers no MD5 then', () => {
      expect(attributesMd5({})).toBeUndefined();
    });
  });

  it("counts a message's size as SQS does: its body and its attributes' names, types and values, in bytes", () => {
    expect(messageSize('سلام', {})).toBe(8);
    expect(messageSize('body', { color: { DataType: 'String', StringValue: 'red' }, bits: { DataType: 'Binary', BinaryValue: 'AAEC' } })).toBe(4 + 5 + 6 + 3 + 4 + 6 + 3);
  });

  describe('a receipt handle', () => {
    const receipt = { id: '1234567890123', receiveCount: 3, messageId: '6b5a8a52-6f0b-4c3e-9d4e-3c4b8f1e2a77' };

    it('names the message and the receive it was given at', () => {
      const handle = receiptHandle(receipt);
      expect(handle).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(parseReceiptHandle(handle)).toEqual(receipt);
      expect(receiptHandle({ ...receipt, receiveCount: 4 })).not.toBe(handle);
    });

    it('is none for a string no receive gave', () => {
      for (const handle of ['', 'not a handle', Buffer.from('1:2:not-a-uuid').toString('base64url'), 'a'.repeat(300), 42, undefined]) {
        expect(parseReceiptHandle(handle)).toBeUndefined();
      }
    });
  });
});
