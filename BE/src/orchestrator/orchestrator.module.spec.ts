import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import configuration from '../config/configuration';
import { KubernetesOrchestrator } from './kubernetes/kubernetes.orchestrator';
import { OrchestratorModule } from './orchestrator.module';
import { ORCHESTRATOR } from './orchestrator.types';

function compileWithDriver(driver: string) {
  const defaults = configuration();
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            orchestrator: { driver },
            // An http:// URL needs no CA file, and the token is read lazily: nothing touches a cluster.
            kubernetes: { ...defaults.kubernetes, apiUrl: 'http://127.0.0.1:1' },
          }),
        ],
      }),
      OrchestratorModule,
    ],
  }).compile();
}

describe('OrchestratorModule', () => {
  it('provides the Kubernetes driver', async () => {
    const moduleRef = await compileWithDriver('kubernetes');

    expect(moduleRef.get(ORCHESTRATOR)).toBeInstanceOf(KubernetesOrchestrator);
  });

  it.each(['nomad', 'bogus'])('fails fast at boot on an unsupported driver (%s)', async (driver) => {
    await expect(compileWithDriver(driver)).rejects.toThrow(`Unsupported ORCHESTRATOR driver "${driver}"`);
  });
});
