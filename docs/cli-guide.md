# FF CLI Guide

The FF CLI tool helps developers package and deploy their TypeScript/JavaScript lambda functions to the FF platform. It handles dependency management, TypeScript compilation, and uploads to MinIO storage.

## Installation

1. Clone the repository and navigate to the CLI directory:
```bash
cd cli
```

2. Install dependencies:
```bash
npm install
```

3. Build the CLI:
```bash
npm run build
```

4. Create a `.env` file in the CLI directory (copy from `.env.example`):
```env
MINIO_ENDPOINT=localhost
MINIO_PORT=9003
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=your_access_key
MINIO_SECRET_KEY=your_secret_key
MINIO_BUCKET_NAME=lambda-functions
```

5. Make the CLI globally available (choose one method):
   
   a. Install the package globally:
   ```bash
   npm install -g .
   ```
   
   b. Or create a symbolic link (recommended for development):
   ```bash
   npm link
   ```

   After this step, the `ff` command will be available globally in your terminal.

   Note: If you don't want to install globally, you can run the CLI directly using:
   ```bash
   node dist/index.js <command>
   # or
   npm run start -- <command>
   ```

## Usage

### Basic Commands

The CLI provides three main commands:

1. **Pack** - Package a lambda function into a zip file:
```bash
ff pack <function-directory> [--output <output-path>]
```

2. **Upload** - Upload a packaged lambda to MinIO:
```bash
ff upload <zip-file>
```

3. **Deploy** - Package and upload a lambda function in one command:
```bash
ff deploy <function-directory>
```

### Lambda Function Structure

Your lambda function directory should have the following structure:

```
my-lambda/
├── src/
│   └── index.ts      # Main lambda function code
├── package.json      # Dependencies and scripts
└── tsconfig.json    # TypeScript configuration (if using TypeScript)
```

#### Required Files

1. **package.json**
```json
{
  "name": "my-lambda",
  "version": "1.0.0",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    // Your lambda dependencies
  },
  "devDependencies": {
    "typescript": "^5.2.2",
    "@types/node": "^20.8.0"
  }
}
```

2. **tsconfig.json** (for TypeScript lambdas)
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*"]
}
```

### Example Usage

1. Create a new lambda function:
```bash
mkdir my-lambda
cd my-lambda
npm init -y
```

2. Add TypeScript support:
```bash
npm install --save-dev typescript @types/node
```

3. Create the lambda function code in `src/index.ts`:
```typescript
export async function handler(event: any): Promise<any> {
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Hello from FF!' })
  };
}
```

4. Package and deploy the function:
```bash
ff deploy ./my-lambda
```

## How It Works

1. **Packaging Process**
   - Installs production dependencies (`npm install --production`)
   - Compiles TypeScript if present (`npm run build`)
   - Creates a zip file containing:
     - Compiled code (`dist/`)
     - Dependencies (`node_modules/`)
     - Configuration files (`package.json`, `tsconfig.json`)

2. **Upload Process**
   - Ensures MinIO bucket exists
   - Uploads the zip file to MinIO storage
   - Uses the same MinIO integration as the main platform

## Troubleshooting

Common issues and solutions:

1. **Missing Dependencies**
   - Ensure all dependencies are listed in `package.json`
   - Run `npm install` before packaging

2. **TypeScript Compilation Errors**
   - Check `tsconfig.json` configuration
   - Ensure all required types are installed
   - Run `npm run build` locally to debug

3. **MinIO Connection Issues**
   - Verify `.env` configuration
   - Check MinIO server status
   - Ensure network connectivity

4. **Zip File Size Issues**
   - Remove unnecessary dependencies
   - Use `.npmignore` or `files` in `package.json` to exclude dev files
   - Consider using layer for large dependencies

## Best Practices

1. **Lambda Function Structure**
   - Keep functions focused and single-purpose
   - Properly handle async operations
   - Include error handling

2. **Dependencies**
   - Use specific versions in `package.json`
   - Regularly update dependencies
   - Minimize package size

3. **TypeScript**
   - Enable strict mode
   - Use proper types for events and responses
   - Keep compiled code compatible with the runtime

4. **Testing**
   - Test locally before deployment
   - Include unit tests
   - Use TypeScript for better type safety

## Contributing

To contribute to the CLI tool:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Support

For issues and support:
- Open an issue in the GitHub repository
- Check existing documentation
- Contact the development team
