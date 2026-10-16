# FF CLI Tool

This document outlines the implementation steps for the FF CLI tool that helps developers package and deploy their TypeScript/JavaScript lambda functions to the platform.

## Overview

The CLI tool will provide functionality to:
1. Package TypeScript/JavaScript lambda functions into deployable zip files
2. Upload the packaged functions directly to MinIO storage
3. Handle necessary dependencies and type definitions

## Implementation Tasks

### 1. CLI Framework Setup
- [ ] Set up a new Node.js project with TypeScript
- [ ] Implement CLI framework using Commander.js or Yargs
- [ ] Create basic command structure (pack, upload, deploy)
- [ ] Add configuration management for MinIO credentials and endpoints

### 2. Lambda Packaging Implementation
- [ ] Create workspace validation to ensure lambda function structure is correct
- [ ] Implement TypeScript compilation with proper tsconfig settings
- [ ] Set up dependency analysis to identify required node_modules
- [ ] Handle type definitions packaging (@types/*)
- [ ] Implement zip file creation with proper structure:
  ```
  lambda.zip/
  ├── dist/           # Compiled JavaScript files
  ├── node_modules/   # Required dependencies
  └── package.json    # Function metadata and dependencies
  ```

### 3. MinIO Integration
- [ ] keep in mind that we have already working code that uploads code to minio, make sure to adapt it corretly
- [ ] Implement MinIO client configuration
- [ ] Create bucket management functionality
- [ ] Add upload functionality with proper error handling
- [ ] Implement versioning support for lambda packages

### 4. Development Features
- [ ] Add local testing capabilities
- [ ] Implement watch mode for development
- [ ] Add validation for lambda function structure
- [ ] Create development server for local testing

### 5. Documentation and Examples
- [ ] Write comprehensive CLI usage documentation
- [ ] Create example lambda functions
- [ ] Document best practices for lambda development
- [ ] Add troubleshooting guide

## Usage Example

```bash
# Initialize a new lambda function
ff init my-lambda

# Package a lambda function
ff pack ./my-lambda

# Upload to MinIO
ff upload ./my-lambda.zip

# Combined pack and upload
ff deploy ./my-lambda
```

## Technical Requirements

- Node.js >= 18
- TypeScript support
- MinIO client library
- Zip creation utilities
- Dependency management tools

## Security Considerations

- Secure handling of MinIO credentials
- Package validation before upload
- Proper error handling and logging
- Version control integration

## Future Enhancements

- Support for different runtime versions
- Custom dependency inclusion/exclusion
- Integration with CI/CD pipelines
- Multi-function deployment support
- Hot reload capabilities for development
