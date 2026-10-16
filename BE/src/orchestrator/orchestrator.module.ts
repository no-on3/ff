import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { NomadModule } from '../nomad/nomad.module';
import { KubeClient } from './kubernetes/kube-client';
import { KubernetesOrchestrator } from './kubernetes/kubernetes.orchestrator';
import { resolveKubernetesSettings } from './kubernetes/kubernetes.settings';
import { NomadOrchestrator } from './nomad/nomad.orchestrator';
import { ORCHESTRATOR, Orchestrator } from './orchestrator.types';

export const SUPPORTED_DRIVERS = ['kubernetes', 'nomad'] as const;

/**
 * Provides the ORCHESTRATOR token. Only the configured driver is
 * instantiated (via ModuleRef.create), so unused drivers never open
 * connections or read credentials at boot. Unknown drivers fail fast.
 */
@Module({
  imports: [ConfigModule, NomadModule],
  providers: [
    {
      provide: ORCHESTRATOR,
      inject: [ConfigService, ModuleRef],
      useFactory: async (config: ConfigService, moduleRef: ModuleRef): Promise<Orchestrator> => {
        const driver = config.get<string>('orchestrator.driver');
        switch (driver) {
          case 'kubernetes': {
            const settings = resolveKubernetesSettings(config);
            const client = new KubeClient({
              server: settings.apiUrl,
              tokenFile: settings.tokenFile,
              caFile: settings.caFile,
            });
            return new KubernetesOrchestrator(settings, client);
          }
          case 'nomad':
            return moduleRef.create(NomadOrchestrator);
          default:
            throw new Error(
              `Unsupported ORCHESTRATOR driver "${driver}". Supported: ${SUPPORTED_DRIVERS.join(', ')}`,
            );
        }
      },
    },
  ],
  exports: [ORCHESTRATOR],
})
export class OrchestratorModule {}
