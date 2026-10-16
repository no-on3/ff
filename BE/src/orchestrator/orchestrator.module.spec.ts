import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import configuration from '../config/configuration';
import { MinioClientService } from '../minio-client/minio-client.service';
import { NomadService } from '../nomad/nomad.service';
import { KubernetesOrchestrator } from './kubernetes/kubernetes.orchestrator';
import { NomadOrchestrator } from './nomad/nomad.orchestrator';
import { OrchestratorModule } from './orchestrator.module';
import { ORCHESTRATOR } from './orchestrator.types';

function compileWithDriver(driver: string) {
  const defaults = configuration();
  return (
    Test.createTestingModule({
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
    })
      // Keep the test hermetic: no Nomad, Pulumi, or MinIO connections.
      .overrideProvider(NomadService)
      .useValue({})
      .overrideProvider(MinioClientService)
      .useValue({})
      .compile()
  );
}

describe('OrchestratorModule', () => {
  it('provides the Kubernetes driver when ORCHESTRATOR=kubernetes', async () => {
    const moduleRef = await compileWithDriver('kubernetes');

    expect(moduleRef.get(ORCHESTRATOR)).toBeInstanceOf(KubernetesOrchestrator);
  });

  it('provides the Nomad driver when ORCHESTRATOR=nomad', async () => {
    const moduleRef = await compileWithDriver('nomad');

    expect(moduleRef.get(ORCHESTRATOR)).toBeInstanceOf(NomadOrchestrator);
  });

  it('fails fast at boot on an unknown driver', async () => {
    await expect(compileWithDriver('bogus')).rejects.toThrow('Unsupported ORCHESTRATOR driver "bogus"');
  });
});
