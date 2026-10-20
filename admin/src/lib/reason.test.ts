import { describe, expect, it } from 'vitest';
import { reasonProblem } from './reason';

describe('reasonProblem', () => {
  it('takes a reason of 3 to 500 characters, as the API does', () => {
    expect(reasonProblem('Pilot customers asked for it')).toBeNull();
    expect(reasonProblem('abc')).toBeNull();
    expect(reasonProblem('x'.repeat(500))).toBeNull();
  });

  it('refuses one too short, spaces aside, or too long', () => {
    expect(reasonProblem('  ab  ')).toBe('Say why, in at least 3 characters: the audit log keeps it.');
    expect(reasonProblem('x'.repeat(501))).toBe('At most 500 characters.');
  });
});
