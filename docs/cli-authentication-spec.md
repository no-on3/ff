# FF CLI Authentication and Configuration Specification

## Overview

The FF CLI requires authentication to interact with the FF platform. Users must have an account on the backend service to deploy and manage their lambda functions. This document outlines the authentication flow and configuration management for the CLI.

## Authentication Flow

### 1. User Registration/Login
- Users must first create an account through the FF platform's web interface
- Upon successful registration/login, users receive:
  - User ID
  - API Token for CLI authentication

### 2. CLI Configuration

The CLI will provide a configuration command to set up user credentials:

```bash
ff config set
```

This interactive command will:
1. Prompt for the FF platform URL
2. Request the API token
3. Store credentials securely in the user's home directory

Alternative non-interactive setup:
```bash
ff config set --token <api-token> --url <platform-url>
```

Configuration file location: `~/.ff/config.json`

```json
{
  "platformUrl": "https://api.ff.example.com",
  "userId": "user-uuid",
  "apiToken": "jwt-token",
  "defaultRegion": "us-east-1"
}
```

### 3. Configuration Management Commands

```bash
# View current configuration
ff config view

# Update specific setting
ff config set <key> <value>

# Remove configuration
ff config clear

# Test configuration
ff config test
```

## Function Deployment Structure

### Storage Organization
Functions are stored in MinIO with the following structure:
```
functions/                  # Root bucket
├── {user-id}/            # User-specific directory
│   ├── {function-id}/    # Function directory
│   │   ├── code.zip      # Function code
│   │   ├── config.json   # Function configuration
│   │   └── meta.json     # Metadata
```

### Deployment Process

1. **Authentication Check**
   - Validate stored credentials
   - Verify user access rights

2. **Function Creation**
   ```bash
   ff deploy ./my-function
   ```
   - Creates function record in backend
   - Receives function UUID
   - Packages function code
   - Uploads to `functions/{user-id}/{function-id}/code.zip`

3. **Function Configuration**
   ```bash
   ff deploy ./my-function --config
   ```
   Configuration options:
   - Memory allocation (--memory)
   - CPU allocation (--cpu)
   - Timeout (--timeout)
   - Environment variables (--env)
   - Scaling options (--min-instances, --max-instances)

## Security Considerations

1. **Credential Storage**
   - Credentials stored with appropriate file permissions (600)
   - Optional credential encryption
   - Support for environment variables override

2. **Token Management**
   - Token expiration handling
   - Token refresh mechanism
   - Automatic token renewal

3. **API Security**
   - HTTPS for all API communications
   - Token-based authentication for all requests
   - Rate limiting support

## Error Handling

1. **Authentication Errors**
   - Invalid credentials
   - Expired tokens
   - Missing configuration

2. **Deployment Errors**
   - Invalid function structure
   - Upload failures
   - Configuration validation

## Implementation Tasks

1. **CLI Enhancements**
   - [ ] Add config command and subcommands
   - [ ] Implement secure credential storage
   - [ ] Add authentication middleware
   - [ ] Update deploy command to use authentication

2. **Backend Integration**
   - [ ] Create authentication endpoints
   - [ ] Implement token validation
   - [ ] Add user-specific function management

3. **Storage Updates**
   - [ ] Update MinIO path structure
   - [ ] Add user isolation
   - [ ] Implement function versioning

4. **Documentation**
   - [ ] Update CLI documentation
   - [ ] Add authentication guide
   - [ ] Create troubleshooting guide

## Migration Plan

For existing users:
1. CLI will prompt for authentication on next use
2. Existing functions will be migrated to new path structure
3. Backward compatibility for existing deployments

## Testing Requirements

1. **Unit Tests**
   - Configuration management
   - Authentication flow
   - Deployment process

2. **Integration Tests**
   - End-to-end deployment
   - Authentication scenarios
   - Error conditions

3. **Security Tests**
   - Credential storage
   - Token handling
   - Access control
