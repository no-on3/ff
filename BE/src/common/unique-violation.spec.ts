import { QueryFailedError } from 'typeorm';
import { isUniqueViolation } from './unique-violation';

const failed = (code: string | undefined) => new QueryFailedError('INSERT', [], Object.assign(new Error('refused'), code === undefined ? {} : { code }));

describe('isUniqueViolation', () => {
  it("is a query PostgreSQL refused for a unique index's sake, and nothing else", () => {
    expect(isUniqueViolation(failed('23505'))).toBe(true);
    expect([failed('23503'), failed(undefined), Object.assign(new Error('duplicate key'), { code: '23505' }), undefined].map(isUniqueViolation)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
