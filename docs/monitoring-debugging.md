# Monitoring and Debugging Guide

## Monitoring Overview

The serverless platform provides comprehensive monitoring capabilities through multiple components:

1. **Metrics Collection**
   - Function invocations
   - Execution duration
   - Memory usage
   - Cold starts
   - Error rates

2. **Logging System**
   - Application logs
   - Function logs
   - System logs
   - Error tracking

3. **Tracing System**
   - Distributed tracing
   - Performance profiling
   - Request tracking

## Grafana Dashboard

The platform includes a pre-configured Grafana dashboard for monitoring functions. Access it at:
```
http://localhost:3001
```

Default credentials:
- Username: admin
- Password: admin

### Available Panels

1. **Function Invocations**
   - Real-time invocation rate
   - Historical invocation counts
   - Success/failure ratio

2. **Performance Metrics**
   - Average execution duration
   - P95/P99 latencies
   - Memory usage patterns

3. **System Health**
   - Cold start frequency
   - Error rates
   - Resource utilization

## Debugging Tools

### Live Log Streaming

Access real-time function logs using the SSE endpoint:

```bash
curl http://localhost:3000/api/debug/functions/{functionId}/logs/stream \
  -H "Authorization: Bearer YOUR_TOKEN"
```

The stream provides:
- Function execution logs
- System events
- Error messages
- Performance metrics

### Performance Profiling

Create CPU and memory profiles:

```bash
curl -X POST http://localhost:3000/api/debug/functions/{functionId}/profile \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"duration": 30}'
```

Profile types:
- CPU usage
- Memory allocation
- Heap snapshots
- Stack traces

### Memory Analysis

Take memory snapshots for analysis:

```bash
curl http://localhost:3000/api/debug/functions/{functionId}/memory-snapshot \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Analyze:
- Memory leaks
- Object allocation
- Garbage collection
- Memory fragmentation

### Distributed Tracing

View distributed traces:

```bash
curl http://localhost:3000/api/debug/functions/{functionId}/traces \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Trace information includes:
- Request flow
- Service dependencies
- Timing breakdown
- Error propagation

## Best Practices

### Monitoring

1. **Set Up Alerts**
   - High error rates
   - Unusual latency
   - Memory leaks
   - Cold start spikes

2. **Log Levels**
   ```javascript
   // Development
   LOG_LEVEL=debug

   // Production
   LOG_LEVEL=info
   ```

3. **Metrics Retention**
   - High-resolution: 24 hours
   - Medium-resolution: 30 days
   - Low-resolution: 1 year

### Debugging

1. **Local Development**
   ```bash
   # Enable debug mode
   curl -X POST http://localhost:3000/api/debug/functions/{functionId}/debug-mode \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -d '{"enabled": true, "options": {"verbose": true}}'
   ```

2. **Production Debugging**
   - Use diagnostic reports
   - Collect memory snapshots
   - Enable detailed tracing
   - Analyze cold starts

3. **Performance Optimization**
   - Monitor cold starts
   - Optimize memory usage
   - Cache frequently used data
   - Use appropriate timeout values

## Troubleshooting

### Common Issues

1. **High Cold Start Rate**
   - Check function size
   - Verify memory settings
   - Review dependencies
   - Consider provisioned concurrency

2. **Memory Leaks**
   ```bash
   # Take memory snapshots
   curl http://localhost:3000/api/debug/functions/{functionId}/memory-snapshot \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

3. **High Latency**
   - Review function code
   - Check external dependencies
   - Analyze trace data
   - Monitor resource usage

### Debug Mode Options

```javascript
{
  "verbose": true,          // Enable detailed logging
  "traceAll": true,        // Enable tracing for all requests
  "heapProfiling": true,   // Enable continuous heap profiling
  "cpuProfiling": false    // Enable CPU profiling (high overhead)
}
```

## Metrics Reference

### Function Metrics

1. **Invocation Metrics**
   - `function_invocations_total`
   - `function_errors_total`
   - `function_cold_starts_total`

2. **Performance Metrics**
   - `function_duration_seconds`
   - `function_memory_bytes`
   - `function_cpu_percent`

3. **Custom Metrics**
   ```javascript
   // Add custom metrics in your function
   console.log(JSON.stringify({
     type: 'metric',
     name: 'custom_metric',
     value: 123,
     tags: { category: 'performance' }
   }));
   ```

### System Metrics

1. **Resource Usage**
   - `system_memory_bytes`
   - `system_cpu_percent`
   - `system_network_bytes`

2. **Container Metrics**
   - `container_memory_usage`
   - `container_cpu_usage`
   - `container_network_io`

## Log Formats

### Function Logs
```json
{
  "timestamp": "2025-02-06T15:30:00Z",
  "level": "info",
  "function_id": "function-id",
  "invocation_id": "invocation-id",
  "message": "Function executed successfully",
  "duration_ms": 123,
  "memory_bytes": 45678912
}
```

### System Logs
```json
{
  "timestamp": "2025-02-06T15:30:00Z",
  "level": "error",
  "component": "nomad",
  "message": "Container failed to start",
  "error": {
    "code": "RESOURCE_EXHAUSTED",
    "details": "Insufficient memory"
  }
}
```
