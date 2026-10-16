export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    name: process.env.DB_NAME || 'postgres',
    synchronize: process.env.NODE_ENV !== 'production',
    logging: process.env.NODE_ENV !== 'production',
  },
  minio: {
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9003', 10),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    bucketName: process.env.MINIO_BUCKET_NAME || 'functions',
  },
  orchestrator: {
    // Scheduler driver behind the ORCHESTRATOR token (see OrchestratorModule).
    driver: process.env.ORCHESTRATOR || 'kubernetes',
    // How long create/update wait for a function to become ready.
    readyTimeoutSeconds: parseInt(process.env.FF_READY_TIMEOUT_SECONDS || '90', 10),
  },
  scaling: {
    // Idle time before a function with scaleToZero and minInstances 0 is scaled to zero.
    scaleToZeroIdleSeconds: parseInt(process.env.FF_SCALE_TO_ZERO_IDLE_SECONDS || '900', 10),
    maxRequestsPerInstance: parseInt(process.env.MAX_REQUESTS_PER_INSTANCE || '2', 10),
  },
  // Kubernetes driver settings (docs/kubernetes-migration-plan.md §4.5).
  kubernetes: {
    // Empty: use the in-cluster API server (KUBERNETES_SERVICE_HOST/PORT).
    apiUrl: process.env.K8S_API_URL || '',
    tokenFile: process.env.K8S_TOKEN_FILE || '/var/run/secrets/kubernetes.io/serviceaccount/token',
    caFile: process.env.K8S_CA_FILE || '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    // Empty: "direct" inside the cluster, "proxy" (through the API server) outside.
    invokeMode: process.env.K8S_INVOKE_MODE || '',
    namespacePrefix: process.env.K8S_NAMESPACE_PREFIX || 'ff-t-',
    runtimeImages: {
      nodejs: process.env.K8S_RUNTIME_IMAGE_NODEJS || 'ff-runtime-nodejs:24-v1',
      python: process.env.K8S_RUNTIME_IMAGE_PYTHON || 'ff-runtime-python:3.13-v1',
    },
    imagePullPolicy: process.env.K8S_IMAGE_PULL_POLICY || 'IfNotPresent',
    runtimeClass: process.env.K8S_RUNTIME_CLASS || '',
    readyTimeoutSeconds: parseInt(process.env.K8S_READY_TIMEOUT_SECONDS || '90', 10),
    egressInternet: process.env.K8S_EGRESS_INTERNET !== 'false',
    ingressAllowCidrs: (process.env.K8S_INGRESS_ALLOW_CIDRS || '')
      .split(',')
      .map((cidr) => cidr.trim())
      .filter(Boolean),
    tenantQuota: {
      pods: process.env.K8S_TENANT_QUOTA_PODS || '20',
      cpu: process.env.K8S_TENANT_QUOTA_CPU || '8',
      memory: process.env.K8S_TENANT_QUOTA_MEMORY || '8Gi',
    },
  },
});
