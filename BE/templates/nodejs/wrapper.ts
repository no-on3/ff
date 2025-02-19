import { Request, Response } from 'express';

interface FunctionEvent {
  body: any;
  headers: Record<string, string>;
  method: string;
  query: Record<string, string>;
  path: string;
}

interface FunctionContext {
  functionName: string;
  functionVersion: string;
  memoryLimitInMB: number;
  getRemainingTimeInMillis: () => number;
}

type FunctionHandler = (event: FunctionEvent, context: FunctionContext) => Promise<any>;

const startTime = Date.now();
const memoryLimitInMB = parseInt(process.env.FUNCTION_MEMORY_LIMIT || '128', 10);

// Load the user's function
const userFunction = require('./function');
const handler: FunctionHandler = userFunction.handler;

// Express app for handling invocations
import express from 'express';
const app = express();
app.use(express.json());

app.get('/', async (req: Request, res: Response) => {
 
  res.json({ ok: true });
   
});

app.post('/invoke', async (req: Request, res: Response) => {
  try {
    // Create the event object
    const event: FunctionEvent = {
      body: req.body,
      headers: req.headers as Record<string, string>,
      method: req.method,
      query: req.query as Record<string, string>,
      path: req.path,
    };

    // Create the context object
    const context: FunctionContext = {
      functionName: process.env.FUNCTION_NAME || 'unknown',
      functionVersion: process.env.FUNCTION_VERSION || '1.0.0',
      memoryLimitInMB,
      getRemainingTimeInMillis: () => {
        const timeoutInMs = parseInt(process.env.FUNCTION_TIMEOUT || '30000', 10);
        return Math.max(0, timeoutInMs - (Date.now() - startTime));
      },
    };

    // Execute the function
    const result = await handler(event, context);

    // Send the response
    res.json(result);
  } catch (error) {
    console.error('Function execution error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal function error',
      stackTrace: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

// Start the server
const port = process.env.NOMAD_PORT_http || 3000;

console.log({ env: process.env });

app.listen(port, () => {
  console.log(`Function wrapper listening on port ${port}`);
});
