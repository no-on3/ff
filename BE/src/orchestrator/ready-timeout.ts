import { ConfigService } from '@nestjs/config';

/** How long a create or an update waits for its version to be ready (FF_READY_TIMEOUT_SECONDS, 90 s by default), in milliseconds. */
export const readyTimeoutMs = (config: ConfigService): number => config.get<number>('orchestrator.readyTimeoutSeconds', 90) * 1000;
