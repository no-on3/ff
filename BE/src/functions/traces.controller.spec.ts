/**
 * L1: who reads a trace, as the route declares it for the global guard: every member, as they read the logs, and a key
 * with logs:read; the trace's ID as given reaches the service.
 */
import { Reflector } from '@nestjs/core';
import { AccountStatus } from '../accounts/entities/account.entity';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { TracesController } from './traces.controller';
import { TracesService } from './traces.service';

describe('GET /traces/:id (L1)', () => {
  const reflector = new Reflector();

  it('lets every member read a trace, viewers included, and a key with logs:read', () => {
    const method = TracesController.prototype.get;
    expect([reflector.get(ROLES, method), reflector.get(ACTIVE_ACCOUNT, method), reflector.get(SCOPE, method)]).toEqual([undefined, undefined, 'logs:read']);
  });

  it("reads the trace of the caller's account", async () => {
    const view = { traceId: '1-6730a1f2-0123456789abcdef01234567', calls: [], truncated: false };
    const traces = { get: jest.fn(async () => view) };
    const controller = new TracesController(traces as unknown as TracesService);

    const read = await controller.get(view.traceId, { accountId: '000000000001', accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'viewer' });

    expect(read).toBe(view);
    expect(traces.get).toHaveBeenCalledWith('000000000001', view.traceId);
  });
});
