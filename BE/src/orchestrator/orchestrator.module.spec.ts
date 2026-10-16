import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MinioClientService } from '../minio-client/minio-client.service';
import { NomadService } from '../nomad/nomad.service';
import { NomadOrchestrator } from './nomad/nomad.orchestrator';
import { OrchestratorModule } from './orchestrator.module';
import { ORCHESTRATOR } from './orchestrator.types';

function compileWithDriver(driver: string) {
  return (
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ orchestrator: { driver } })],
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
  it('provides the Nomad driver when ORCHESTRATOR=nomad', async () => {
    const moduleRef = await compileWithDriver('nomad');

    expect(moduleRef.get(ORCHESTRATOR)).toBeInstanceOf(NomadOrchestrator);
  });

  it('fails fast at boot on an unknown driver', async () => {
    await expect(compileWithDriver('bogus')).rejects.toThrow('Unsupported ORCHESTRATOR driver "bogus"');
  });
});
