import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:3000', // Update with your backend URL
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export type Runtime = 'nodejs' | 'python';
export type FunctionStatus = 'CREATING' | 'ACTIVE' | 'ERROR' | 'DELETED';

/** A function, as the API returns it. */
export interface Function {
  id: string;
  name: string;
  userId: string;
  runtime: Runtime;
  code: string;
  /** MB */
  memory: number;
  /** Seconds */
  timeout: number;
  status: FunctionStatus;
  /** Why the function is in ERROR. */
  error?: string | null;
  minInstances: number;
  maxInstances: number;
  scaleToZero: boolean;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** What POST /functions accepts. */
export type NewFunction = Pick<Function, 'name' | 'runtime' | 'code' | 'memory' | 'timeout'> & {
  metadata?: Record<string, unknown>;
};

/** What PUT /functions/:id accepts: any subset of these. */
export type FunctionUpdate = Partial<Pick<Function, 'name' | 'runtime' | 'code' | 'memory' | 'timeout'>>;

export type InvocationStatus = 'RUNNING' | 'COMPLETED' | 'ERROR' | 'TIMEOUT';

/** An invocation, as the API returns it: from POST /functions/:id/invoke, and in the history. */
export interface FunctionInvocation {
  id: string;
  functionId: string;
  input: unknown;
  output: unknown;
  status: InvocationStatus;
  /** Milliseconds, as the runtime measured it. */
  duration: number;
  /** MB: the runtime's peak memory. */
  memoryUsed?: number | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One page of GET /functions/:id/invocations, newest first. */
export interface InvocationPage {
  invocations: FunctionInvocation[];
  total: number;
}

/** GET and PUT /functions/:id/scaling-config. Each instance serves one call at a time. */
export interface ScalingConfig {
  /** Instances kept running even when idle. */
  minInstances: number;
  /** The most instances autoscaling may run. */
  maxInstances: number;
  /** Whether the function scales to zero when idle: exactly when minInstances is 0. */
  scaleToZero: boolean;
}

export type ScalingLimits = Pick<ScalingConfig, 'minInstances' | 'maxInstances'>;

export const functionsApi = {
  getAllFunctions: () => api.get<Function[]>('/functions'),

  getFunction: (id: string) => api.get<Function>(`/functions/${id}`),

  createFunction: (data: NewFunction) => api.post<Function>('/functions', data),

  updateFunction: (id: string, data: FunctionUpdate) => api.put<Function>(`/functions/${id}`, data),

  deleteFunction: (id: string) => api.delete(`/functions/${id}`),

  /** `input` becomes the handler's event.body. */
  invokeFunction: (id: string, input: Record<string, unknown>) =>
    api.post<FunctionInvocation>(`/functions/${id}/invoke`, { input }),

  getFunctionInvocations: (id: string, limit = 20) =>
    api.get<InvocationPage>(`/functions/${id}/invocations`, { params: { limit } }),
};

// Metrics API endpoints
export const getMetrics = async (functionId: string, start: Date, end: Date) => {
  const response = await api.get(`/metrics/${functionId}`, {
    params: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
  });
  return response.data;
};

export const getScalingConfig = async (functionId: string): Promise<ScalingConfig> => {
  const response = await api.get<ScalingConfig>(`/functions/${functionId}/scaling-config`);
  return response.data;
};

export const updateScalingConfig = async (functionId: string, limits: Partial<ScalingLimits>): Promise<ScalingConfig> => {
  const response = await api.put<ScalingConfig>(`/functions/${functionId}/scaling-config`, limits);
  return response.data;
};

export default api;
