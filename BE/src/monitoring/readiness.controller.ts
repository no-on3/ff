import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { Public } from '../auth/public.decorator';
import { describeError } from '../common/describe-error';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';

/** How long each check may take. */
export const CHECK_MS = 2_000;

/** Each check's result: "ok", or why not. */
export interface Readiness {
  status: 'ready' | 'not ready';
  checks: { database: string; kubernetes: string };
}

/** Rejects when the work takes longer than its time. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms)));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Whether this backend can serve: its database answers, and so does the
 * cluster it runs functions on. For the load balancer and Kubernetes'
 * readiness probe; /healthz says only that the process is alive.
 */
@ApiTags('health')
@Controller('readyz')
export class ReadinessController {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(ORCHESTRATOR) private readonly orchestrator: Orchestrator,
  ) {}

  @Public()
  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'The backend can serve: its database and the cluster answer, each within 2 s; 503 says which did not' })
  @ApiResponse({ status: 200, description: '{"status":"ready","checks":{"database":"ok","kubernetes":"ok"}}' })
  async ready(): Promise<Readiness> {
    const check = (work: () => Promise<unknown>) =>
      within(CHECK_MS, work()).then(
        () => 'ok',
        (error: unknown) => describeError(error),
      );
    const [database, kubernetes] = await Promise.all([check(() => this.dataSource.query('SELECT 1')), check(() => this.orchestrator.ping(CHECK_MS))]);
    const readiness: Readiness = { status: database === 'ok' && kubernetes === 'ok' ? 'ready' : 'not ready', checks: { database, kubernetes } };
    if (readiness.status !== 'ready') throw new ServiceUnavailableException(readiness);
    return readiness;
  }
}
