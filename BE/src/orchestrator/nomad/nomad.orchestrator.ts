import { Injectable } from '@nestjs/common';
import { Function } from '../../functions/entities/function.entity';
import { NomadService } from '../../nomad/nomad.service';
import { FunctionWorkload, InvokeResult, Orchestrator } from '../orchestrator.types';

/**
 * Deprecated driver: delegates to the existing NomadService unchanged, so the
 * Kubernetes migration can switch drivers without touching callers.
 * Removed in K-09 (see docs/kubernetes-migration-plan.md).
 */
@Injectable()
export class NomadOrchestrator implements Orchestrator {
  /** invokeFunction needs a running allocation; there is no cold start from zero. */
  readonly supportsScaleToZero = false;

  constructor(private readonly nomadService: NomadService) {}

  deploy(fn: FunctionWorkload): Promise<void> {
    return this.nomadService.deployFunction(fn as Function);
  }

  update(fn: FunctionWorkload): Promise<void> {
    return this.nomadService.updateFunction(fn as Function);
  }

  remove(fn: FunctionWorkload): Promise<void> {
    return this.nomadService.removeFunction(fn as Function);
  }

  async waitUntilReady(): Promise<void> {
    // The Nomad driver has never waited for readiness; keep that behaviour.
  }

  async invoke(fn: FunctionWorkload, payload: Record<string, unknown>): Promise<InvokeResult> {
    const raw = await this.nomadService.invokeFunction(fn as Function, payload);
    // NomadService spreads the wrapper response and adds memoryUsed/cpuUsed;
    // callers used `raw.output || raw` as the stored output.
    return {
      output: raw?.output || raw,
      memoryUsedMb: raw?.memoryUsed,
      cpuUsed: raw?.cpuUsed,
    };
  }

  scale(fn: FunctionWorkload, replicas: number): Promise<void> {
    return this.nomadService.scaleFunction(fn.id, replicas);
  }

  readyInstances(fn: FunctionWorkload): Promise<number> {
    return this.nomadService.getActiveInstanceCount(fn.id);
  }
}
