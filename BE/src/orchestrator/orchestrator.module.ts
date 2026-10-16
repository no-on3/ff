import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { NomadModule } from '../nomad/nomad.module';
import { NomadOrchestrator } from './nomad/nomad.orchestrator';
import { ORCHESTRATOR, Orchestrator } from './orchestrator.types';

export const SUPPORTED_DRIVERS = ['nomad'] as const;

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
