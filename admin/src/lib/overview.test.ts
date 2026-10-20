import { describe, expect, it } from 'vitest';
import { functionsLine, gbS, operatorDashboards, reservedOverBilled } from './overview';

describe('the overview', () => {
  it('writes GB-seconds to the thousandth, thousands apart', () => {
    expect([gbS(0), gbS(0.0625), gbS(11250), gbS(1.28)]).toEqual(['0.000', '0.063', '11,250.000', '1.280']);
  });

  it("says how many times what it billed FF held, and a day with capacity but nothing billed, or neither", () => {
    expect(reservedOverBilled({ reservedGbS: 45, billedGbS: 0.004 })).toBe('11,250×');
    expect(reservedOverBilled({ reservedGbS: 75, billedGbS: 1.28 })).toBe('59×');
    expect(reservedOverBilled({ reservedGbS: 75, billedGbS: 0 })).toBe('nothing billed');
    expect(reservedOverBilled({ reservedGbS: 0, billedGbS: 0 })).toBe('');
  });

  it("links the operator's two dashboards in Grafana when the build says where it is, and none otherwise", () => {
    expect(operatorDashboards('http://localhost:3001').map(({ title, url }) => [title, url])).toEqual([
      ['FF platform', 'http://localhost:3001/d/ff-platform'],
      ['FF cluster', 'http://localhost:3001/d/ff-cluster'],
    ]);
    expect(operatorDashboards(undefined)).toEqual([]);
  });

  it('counts the functions by status, the active first, a status it has no word for as it comes', () => {
    expect(functionsLine({ total: 4, byStatus: { ERROR: 1, ACTIVE: 2, CREATING: 1 } })).toBe('4 functions: 2 active, 1 being created, 1 in error');
    expect(functionsLine({ total: 1, byStatus: { ACTIVE: 1 } })).toBe('1 function: 1 active');
    expect(functionsLine({ total: 2, byStatus: { ACTIVE: 1, PAUSED: 1 } })).toBe('2 functions: 1 active, 1 paused');
    expect(functionsLine({ total: 0, byStatus: {} })).toBe('0 functions');
  });
});
