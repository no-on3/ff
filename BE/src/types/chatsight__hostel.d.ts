declare module '@chatsight/hostel' {
  interface HostelConfig {
    connection: {
      hostname: string;
      port: number;
      sslEnabled?: boolean;
      ssl?: {
        privateKey?: string;
        ca?: string;
        cert?: string;
      };
      ignoreSecretTLSWarning?: boolean;
      ignoreTLSWarning?: boolean;
      keepAlive?: boolean;
    };
    version?: string;
    timeouts?: {
      request?: number;
    };
    secretID?: string;
  }

  interface RequestOptions {
    query?: Record<string, any>;
    body?: Record<string, any>;
    params?: Record<string, any>;
  }

  interface AllocationOptions {
    allocationId?: string;
    allocId?: string;
    Signal?: string;
    Task?: string;
  }

  interface JobOptions {
    jobId?: string;
    Job?: any;
    EnforceIndex?: boolean;
    JobModifyIndex?: number;
    PolicyOverride?: boolean;
    PreserveCounts?: boolean;
    JobHCL?: string;
    Canonicalize?: boolean;
    purge?: boolean;
    Diff?: boolean;
  }

  interface NodeOptions {
    nodeId?: string;
    DrainSpec?: any;
    Eligibility?: string;
  }

  interface HostelResponse<T = any> {
    0: boolean;
    1: T | null;
  }

  interface Allocations {
    list(options?: AllocationOptions): Promise<HostelResponse>;
    read(options: AllocationOptions): Promise<HostelResponse>;
    stop(options: AllocationOptions): Promise<HostelResponse>;
    signal(options: AllocationOptions): Promise<HostelResponse>;
    restart(options: AllocationOptions): Promise<HostelResponse>;
    exec(): Promise<HostelResponse>;
  }

  interface Jobs {
    list(options?: JobOptions): Promise<HostelResponse>;
    read(options: JobOptions): Promise<HostelResponse>;
    create(options: JobOptions): Promise<HostelResponse>;
    parse(options: JobOptions): Promise<HostelResponse>;
    update(options: JobOptions): Promise<HostelResponse>;
    stop(options: JobOptions): Promise<HostelResponse>;
    revert(options: JobOptions): Promise<HostelResponse>;
    plan(options: JobOptions): Promise<HostelResponse>;
  }

  interface Nodes {
    list(options?: NodeOptions): Promise<HostelResponse>;
    read(options: NodeOptions): Promise<HostelResponse>;
    drain(options: NodeOptions): Promise<HostelResponse>;
    purge(options: NodeOptions): Promise<HostelResponse>;
    eligibility(options: NodeOptions): Promise<HostelResponse>;
  }

  interface System {
    forceGC(options?: RequestOptions): Promise<HostelResponse>;
  }

  class Hostel {
    constructor(config: HostelConfig);
    hostname: string;
    port: number;
    version: string;
    ssl: {
      enabled: boolean;
      privateKey: string | null;
      ca: string | null;
      cert: string | null;
    };
    connection: {
      request: number;
    };
    secretID: [string, boolean];
    allocations: Allocations;
    jobs: Jobs;
    nodes: Nodes;
    system: System;
    initialize(): Promise<boolean>;
  }

  // Support both default and named exports
  export = Hostel;
  export default Hostel;
}
