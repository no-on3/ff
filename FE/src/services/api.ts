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

export interface Function {
  id: string;
  name: string;
  description: string;
  code: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface FunctionInvocation {
  id: string;
  functionId: string;
  input: any;
  output: any;
  status: 'RUNNING' | 'COMPLETED' | 'ERROR';
  duration?: number;
  memoryUsed?: number;
  cpuUsed?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InvocationResponse {
  id: string;
  status: 'RUNNING' | 'COMPLETED' | 'ERROR';
  input: any;
  output: any;
  metrics: {
    memoryUsed: number;
    cpuUsed: number;
    startTime: string;
    endTime: string;
    duration: number;
  };
}

export const functionsApi = {
  // Get all functions
  getAllFunctions: () => api.get<Function[]>('/functions'),
  
  // Get function by ID
  getFunction: (id: string) => api.get<Function>(`/functions/${id}`),
  
  // Create function
  createFunction: (data: Partial<Function>) => api.post<Function>('/functions', data),
  
  // Update function
  updateFunction: (id: string, data: Partial<Function>) => 
    api.put<Function>(`/functions/${id}`, data),
  
  // Delete function
  deleteFunction: (id: string) => api.delete(`/functions/${id}`),
  
  // Invoke function
  invokeFunction: (id: string, input: any) => 
    api.post<InvocationResponse>(`/functions/${id}/invoke`, { input }),
  
  // Get function invocations
  getFunctionInvocations: (id: string) => 
    api.get<FunctionInvocation[]>(`/functions/${id}/invocations`),
};

export const monitoringApi = {
  // Get metrics
  getMetrics: () => api.get<string>('/metrics'),
};

export default api;
