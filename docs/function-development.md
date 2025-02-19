# Function Development Guide

## Overview

This guide covers best practices and patterns for developing serverless functions on our platform. We support multiple runtimes and provide tools for local development, testing, and deployment.

## Supported Runtimes

### Node.js
- Version: 18.x
- Event-driven architecture
- Async/await support
- TypeScript support

### Python
- Version: 3.11
- Async support
- Type hints
- Virtual environment support

## Function Structure

### Node.js Function
```javascript
module.exports = async function(event, context) {
    // Access event data
    const { name } = event;
    
    // Access context information
    const { functionId, invocationId } = context;
    
    // Function logic
    const result = await processData(name);
    
    // Return response
    return {
        statusCode: 200,
        body: {
            message: `Hello, ${name}!`,
            result: result
        }
    };
};

// Optional: Custom initialization
module.exports.initialize = async () => {
    // Perform initialization
    // This runs once when the container starts
};
```

### Python Function
```python
async def handler(event: dict, context: dict) -> dict:
    # Access event data
    name = event.get('name')
    
    # Access context information
    function_id = context.get('function_id')
    invocation_id = context.get('invocation_id')
    
    # Function logic
    result = await process_data(name)
    
    # Return response
    return {
        'statusCode': 200,
        'body': {
            'message': f'Hello, {name}!',
            'result': result
        }
    }

# Optional: Custom initialization
async def initialize():
    # Perform initialization
    # This runs once when the container starts
    pass
```

### TypeScript Function
```typescript
import { FunctionEvent, FunctionContext } from './types';

export async function handler(event: FunctionEvent, context: FunctionContext): Promise<any> {
  // Your function logic here
  return {
    message: 'Hello from TypeScript function!',
    input: event.body,
  };
}
```

## Event Object

The event object contains the input data for your function:

```javascript
{
    // HTTP trigger data
    "path": "/api/resource",
    "method": "POST",
    "headers": {
        "content-type": "application/json",
        "authorization": "Bearer ..."
    },
    "queryStringParameters": {
        "page": "1",
        "limit": "10"
    },
    "body": {
        "name": "John"
    },

    // Custom event data
    "type": "custom.event",
    "data": { ... }
}
```

## Context Object

The context object provides runtime information:

```javascript
{
    "functionId": "function-id",
    "functionName": "my-function",
    "invocationId": "invocation-id",
    "deadline": "2025-02-06T15:35:00Z",
    "memory": 128,
    "runtime": "nodejs",
    "environment": "production"
}
```

## Local Development

### Setup Local Environment

1. Install the development tools:
```bash
npm install -g @ff/cli
```

2. Initialize a new function:
```bash
ff init my-function --runtime nodejs
```

3. Run locally:
```bash
ff local start
```

### Testing

1. Unit Tests (Node.js):
```javascript
// function.test.js
const handler = require('./function');

test('handler returns greeting', async () => {
    const event = { name: 'John' };
    const context = {
        functionId: 'test-function',
        invocationId: 'test-invocation'
    };
    
    const response = await handler(event, context);
    
    expect(response.statusCode).toBe(200);
    expect(response.body.message).toBe('Hello, John!');
});
```

2. Integration Tests:
```javascript
// integration.test.js
const { invokeFunction } = require('@ff/testing');

test('function integration', async () => {
    const response = await invokeFunction({
        functionId: 'my-function',
        payload: { name: 'John' }
    });
    
    expect(response.statusCode).toBe(200);
});
```

## Best Practices

### 1. Error Handling

```javascript
module.exports = async function(event, context) {
    try {
        // Function logic
        const result = await processData(event);
        return {
            statusCode: 200,
            body: result
        };
    } catch (error) {
        console.error('Error processing request:', error);
        
        // Return appropriate error response
        return {
            statusCode: error.statusCode || 500,
            body: {
                error: error.message,
                requestId: context.invocationId
            }
        };
    }
};
```

### 2. Environment Variables

```javascript
// Access environment variables
const {
    DATABASE_URL,
    API_KEY,
    ENVIRONMENT
} = process.env;

// Validate required variables
function validateEnv() {
    const required = ['DATABASE_URL', 'API_KEY'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
        throw new Error(`Missing required env vars: ${missing.join(', ')}`);
    }
}
```

### 3. Logging

```javascript
// Structured logging
function log(level, message, data = {}) {
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...data
    }));
}

// Usage
log('info', 'Processing request', { userId: '123' });
log('error', 'Failed to process', { error: err.message });
```

### 4. Performance Optimization

```javascript
// Cache expensive operations
const cache = new Map();

async function expensiveOperation(key) {
    if (cache.has(key)) {
        return cache.get(key);
    }
    
    const result = await computeResult(key);
    cache.set(key, result);
    return result;
}

// Clean up resources
module.exports.cleanup = async () => {
    await closeConnections();
    cache.clear();
};
```

### 5. Security

```javascript
// Input validation
function validateInput(event) {
    const schema = {
        name: {
            type: 'string',
            required: true,
            minLength: 1,
            maxLength: 100
        }
    };
    
    const errors = validate(event, schema);
    if (errors) {
        throw new ValidationError(errors);
    }
}

// Secure configuration
function getConfig() {
    return {
        database: {
            url: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production'
        },
        api: {
            key: process.env.API_KEY,
            timeout: parseInt(process.env.API_TIMEOUT, 10) || 5000
        }
    };
}
```

## Deployment

### 1. Deploy Function

```bash
# Deploy new function
ff deploy my-function \
    --runtime nodejs \
    --memory 128 \
    --timeout 30

# Update existing function
ff update my-function \
    --code ./function.js \
    --env-vars "KEY1=value1,KEY2=value2"
```

### 2. Function Configuration

```yaml
# function.yaml
name: my-function
runtime: nodejs
handler: function.handler
memory: 128
timeout: 30
environment:
  DATABASE_URL: ${DATABASE_URL}
  API_KEY: ${API_KEY}
triggers:
  - type: http
    path: /api/resource
    method: POST
```

### 3. Version Management

```bash
# List versions
ff versions my-function

# Deploy specific version
ff deploy my-function --version v1.0.0

# Rollback to previous version
ff rollback my-function
```

## Monitoring and Debugging

### 1. Metrics

```javascript
// Custom metrics
function recordMetric(name, value, tags = {}) {
    console.log(JSON.stringify({
        type: 'metric',
        name,
        value,
        tags,
        timestamp: Date.now()
    }));
}

// Usage
recordMetric('process_duration', 123, { status: 'success' });
```

### 2. Tracing

```javascript
// Enable detailed tracing
const tracer = require('@ff/tracing');

async function handler(event, context) {
    const span = tracer.startSpan('process-request');
    
    try {
        const result = await processData(event);
        span.setTag('status', 'success');
        return result;
    } catch (error) {
        span.setTag('status', 'error');
        span.setTag('error', error.message);
        throw error;
    } finally {
        span.finish();
    }
}
```

### 3. Debugging

```javascript
// Enable debug mode locally
ff local start --debug

// Remote debugging
ff debug my-function
```

## TypeScript-Specific Information

### Function Structure

Functions are written in TypeScript and must export a `handler` function with the following signature:

```typescript
import { FunctionEvent, FunctionContext } from './types';

export async function handler(event: FunctionEvent, context: FunctionContext): Promise<any> {
  // Your function logic here
  return {
    message: 'Hello from TypeScript function!',
    input: event.body,
  };
}
```

### Types

The platform provides TypeScript types for your functions:

```typescript
interface FunctionEvent {
  body: any;              // Request body
  headers: Record<string, string>;  // Request headers
  method: string;         // HTTP method
  query: Record<string, string>;    // Query parameters
  path: string;           // Request path
}

interface FunctionContext {
  functionName: string;   // Name of the function
  functionVersion: string;// Version of the function
  memoryLimitInMB: number;// Memory limit
  getRemainingTimeInMillis: () => number; // Get remaining execution time
}
```

### Development Environment

#### Prerequisites

1. Node.js 18 or later
2. TypeScript 5.1 or later
3. Your favorite TypeScript-enabled IDE (VS Code recommended)

#### Local Development

1. Create a new function using the template:

```bash
# Copy the function template
cp templates/nodejs/function.template.ts myfunction.ts
```

2. Implement your function logic in the handler.

3. Test your function locally:

```bash
# Install dependencies
npm install

# Build the function
npm run build

# Run the function
npm start
```

### Function Configuration

Functions are configured using TypeScript decorators and configuration objects:

```typescript
import { FunctionConfig } from './types';

export const config: FunctionConfig = {
  memory: 128,  // Memory limit in MB
  timeout: 30,  // Timeout in seconds
  runtime: 'nodejs'
};

export async function handler(event: FunctionEvent, context: FunctionContext) {
  // Function logic
}
```

### Best Practices

1. **Type Safety**
   - Always use TypeScript types for function parameters and return values
   - Enable strict TypeScript checks in tsconfig.json
   - Use interfaces for complex data structures

2. **Error Handling**
```typescript
export async function handler(event: FunctionEvent, context: FunctionContext) {
  try {
    // Function logic
    return { success: true };
  } catch (error) {
    console.error('Function error:', error);
    throw new Error('Function execution failed: ' + error.message);
  }
}
```

3. **Async Operations**
   - Use async/await for asynchronous operations
   - Handle promise rejections properly
   - Be mindful of the function timeout

4. **Memory Management**
   - Clean up resources in try/finally blocks
   - Be aware of memory limits
   - Use streams for large data processing

5. **Testing**
```typescript
import { handler } from './function';
import { FunctionEvent, FunctionContext } from './types';

describe('Function', () => {
  it('should handle requests', async () => {
    const event: FunctionEvent = {
      body: { test: true },
      headers: {},
      method: 'POST',
      query: {},
      path: '/',
    };
    
    const context: FunctionContext = {
      functionName: 'test',
      functionVersion: '1.0.0',
      memoryLimitInMB: 128,
      getRemainingTimeInMillis: () => 30000,
    };

    const result = await handler(event, context);
    expect(result).toBeDefined();
  });
});
```

### Deployment

Functions are automatically compiled during deployment. The platform:

1. Compiles TypeScript to JavaScript
2. Bundles dependencies
3. Creates a container with the runtime
4. Deploys to the Nomad cluster

### Monitoring

Functions include built-in monitoring:

```typescript
export async function handler(event: FunctionEvent, context: FunctionContext) {
  // Custom metrics
  console.log('Memory usage:', process.memoryUsage());
  console.log('Execution time remaining:', context.getRemainingTimeInMillis());
  
  // Function logic
}
```

### Examples

#### HTTP API Function
```typescript
export async function handler(event: FunctionEvent, context: FunctionContext) {
  switch (event.method) {
    case 'GET':
      return handleGet(event);
    case 'POST':
      return handlePost(event);
    default:
      throw new Error(`Method ${event.method} not supported`);
  }
}

async function handleGet(event: FunctionEvent) {
  const { id } = event.query;
  // Handle GET request
}

async function handlePost(event: FunctionEvent) {
  const data = event.body;
  // Handle POST request
}
```

#### Data Processing Function
```typescript
interface ProcessingResult {
  processed: number;
  errors: string[];
}

export async function handler(event: FunctionEvent, context: FunctionContext): Promise<ProcessingResult> {
  const items = event.body.items;
  const result: ProcessingResult = {
    processed: 0,
    errors: [],
  };

  for (const item of items) {
    try {
      await processItem(item);
      result.processed++;
    } catch (error) {
      result.errors.push(`Error processing item ${item.id}: ${error.message}`);
    }
  }

  return result;
}
```

### Troubleshooting

Common issues and solutions:

1. **Type Errors**
   - Ensure your tsconfig.json is properly configured
   - Check that all dependencies have type definitions
   - Use proper type imports

2. **Runtime Errors**
   - Check function logs using the monitoring dashboard
   - Verify memory and timeout settings
   - Test locally before deployment

3. **Deployment Issues**
   - Verify all dependencies are listed in package.json
   - Check TypeScript compilation errors
   - Verify runtime compatibility
