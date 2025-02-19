# API Reference

## Authentication

All API endpoints require authentication using JWT tokens from Auth0. Include the token in the Authorization header:

```
Authorization: Bearer YOUR_TOKEN
```

## Functions API

### Create Function
```http
POST /api/functions

Request:
{
    "name": "my-function",
    "runtime": "nodejs",
    "code": "module.exports = async function(event) { ... }",
    "memory": 128,
    "timeout": 30
}

Response:
{
    "id": "function-id",
    "name": "my-function",
    "status": "CREATING",
    "created_at": "2025-02-06T15:30:00Z"
}
```

### List Functions
```http
GET /api/functions?page=1&limit=10

Response:
{
    "functions": [{
        "id": "function-id",
        "name": "my-function",
        "status": "ACTIVE",
        "created_at": "2025-02-06T15:30:00Z"
    }],
    "total": 1,
    "page": 1,
    "limit": 10
}
```

### Get Function
```http
GET /api/functions/{functionId}

Response:
{
    "id": "function-id",
    "name": "my-function",
    "runtime": "nodejs",
    "memory": 128,
    "timeout": 30,
    "status": "ACTIVE",
    "created_at": "2025-02-06T15:30:00Z",
    "updated_at": "2025-02-06T15:30:00Z"
}
```

### Invoke Function
```http
POST /api/functions/{functionId}/invoke

Request:
{
    "name": "World"
}

Response:
{
    "result": {
        "message": "Hello, World"
    },
    "duration": 123,
    "memory": 45678912
}
```

### Delete Function
```http
DELETE /api/functions/{functionId}

Response:
Status: 204 No Content
```

## Debug API

### Get Function Debug Info
```http
GET /api/debug/functions/{functionId}/debug

Response:
{
    "function": {
        "id": "function-id",
        "status": "ACTIVE",
        ...
    },
    "metrics": {
        "invocations": 100,
        "avg_duration": 123,
        "error_rate": 0.01
    },
    "environment": {
        "nomad": { ... },
        "container": { ... },
        "system": { ... }
    }
}
```

### Stream Live Logs
```http
GET /api/debug/functions/{functionId}/logs/stream

Response:
event: log
data: {"timestamp":"2025-02-06T15:30:00Z","level":"info","message":"Function started"}

event: log
data: {"timestamp":"2025-02-06T15:30:01Z","level":"info","message":"Function completed"}
```

### Get Performance Profile
```http
POST /api/debug/functions/{functionId}/profile

Request:
{
    "duration": 30
}

Response:
{
    "cpu_profile": { ... },
    "memory_profile": { ... },
    "stack_traces": [ ... ]
}
```

### Get Memory Snapshot
```http
GET /api/debug/functions/{functionId}/memory-snapshot

Response:
{
    "heap": { ... },
    "objects": [ ... ],
    "references": [ ... ]
}
```

### Get Function Traces
```http
GET /api/debug/functions/{functionId}/traces?startTime=2025-02-06T15:00:00Z&endTime=2025-02-06T16:00:00Z

Response:
{
    "traces": [{
        "trace_id": "trace-id",
        "spans": [ ... ],
        "duration": 123,
        "status": "ok"
    }]
}
```

## Monitoring API

### Get Function Metrics
```http
GET /api/functions/{functionId}/metrics?period=1h

Response:
{
    "summary": {
        "total_invocations": 100,
        "avg_duration_ms": 123,
        "error_rate": 0.01,
        "cold_start_rate": 0.05
    },
    "timeSeries": [{
        "timestamp": "2025-02-06T15:00:00Z",
        "invocations": 10,
        "avg_duration": 125,
        "errors": 0
    }]
}
```

### Get Function Logs
```http
GET /api/functions/{functionId}/logs?limit=100

Response:
{
    "logs": [{
        "timestamp": "2025-02-06T15:30:00Z",
        "level": "info",
        "message": "Function executed successfully",
        "metadata": { ... }
    }]
}
```

## Error Responses

All endpoints may return the following error responses:

### 400 Bad Request
```json
{
    "error": "Invalid input",
    "details": "Function name is required"
}
```

### 401 Unauthorized
```json
{
    "error": "Unauthorized",
    "details": "Invalid or missing token"
}
```

### 403 Forbidden
```json
{
    "error": "Forbidden",
    "details": "Insufficient permissions"
}
```

### 404 Not Found
```json
{
    "error": "Not Found",
    "details": "Function not found"
}
```

### 500 Internal Server Error
```json
{
    "error": "Internal Server Error",
    "request_id": "request-id"
}
```
