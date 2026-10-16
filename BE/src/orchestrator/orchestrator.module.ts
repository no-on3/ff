import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KubeClient } from './kubernetes/kube-client';
import { KubernetesOrchestrator } from './kubernetes/kubernetes.orchestrator';
import { resolveKubernetesSettings } from './kubernetes/kubernetes.settings';
import { ORCHESTRATOR, Orchestrator } from './orchestrator.types';

export const SUPPORTED_DRIVERS = ['kubernetes'] as const;

/**
 * Provides the ORCHESTRATOR token. Kubernetes is the only driver
 * (docs/adr/0001-orchestrator-kubernetes.md); the token and the Orchestrator
 * interface keep callers independent of it. Unknown drivers fail at boot.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: ORCHESTRATOR,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Orchestrator => {
        const driver = config.get<string>('orchestrator.driver');
        if (driver !== 'kubernetes') {
          throw new Error(
            `Unsupported ORCHESTRATOR driver "${driver}". Supported: ${SUPPORTED_DRIVERS.join(', ')}`,
          );
        }
        const settings = resolveKubernetesSettings(config);
        const client = new KubeClient({ server: settings.apiUrl, tokenFile: settings.tokenFile, caFile: settings.caFile });
        return new KubernetesOrchestrator(settings, client);
      },
    },
  ],
  exports: [ORCHESTRATOR],
})
export class OrchestratorModule {}
