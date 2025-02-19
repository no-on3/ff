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
  nomad: {
    address: process.env.NOMAD_ADDR || 'http://localhost:4646',
    host: process.env.NOMAD_HOST || 'http://localhost',
    token: process.env.NOMAD_TOKEN || '',
  },
  auth: {
    domain: process.env.AUTH0_DOMAIN || '',
    audience: process.env.AUTH0_AUDIENCE || '',
  },
  monitoring: {
    prometheusEnabled: process.env.ENABLE_PROMETHEUS === 'true',
    tracingEnabled: process.env.ENABLE_TRACING === 'true',
  },
  function: {
    defaultMemory: parseInt(process.env.DEFAULT_FUNCTION_MEMORY || '128', 10),
    defaultTimeout: parseInt(process.env.DEFAULT_FUNCTION_TIMEOUT || '30', 10),
    maxMemory: parseInt(process.env.MAX_FUNCTION_MEMORY || '1024', 10),
    maxTimeout: parseInt(process.env.MAX_FUNCTION_TIMEOUT || '300', 10),
  },
});
