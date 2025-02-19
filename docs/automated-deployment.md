# Automated Deployment Scripts

This guide covers the automated deployment scripts available for setting up, deploying, and maintaining the serverless platform.

## Available Scripts

The following scripts are available in the `scripts/` directory:

- `setup-dev.sh`: Sets up the development environment
- `deploy-prod.sh`: Handles production deployment
- `update-app.sh`: Updates an existing deployment

## Development Environment Setup

The `setup-dev.sh` script automates the setup of your development environment.

### Usage

```bash
chmod +x scripts/setup-dev.sh
./scripts/setup-dev.sh
```

### What it does

1. Checks prerequisites:
   - Node.js
   - Docker
   - Docker Compose

2. Sets up environment:
   - Creates `.env` files from examples
   - Installs dependencies
   - Initializes database
   - Starts development services

### Output

You'll see colored output indicating the progress:
```bash
Starting development environment setup...
Checking prerequisites...
Setting up environment files...
Installing backend dependencies...
Installing frontend dependencies...
Initializing database...
Starting development services...
Starting development servers...

Development environment setup complete!
Backend running at: http://localhost:3000
Frontend running at: http://localhost:3001
MinIO running at: http://localhost:9000
Nomad running at: http://localhost:4646
```

## Production Deployment

The `deploy-prod.sh` script handles complete production deployment.

### Prerequisites

- Root access
- Domain name
- SSL certificate (will be automatically obtained)
- Production environment file

### Usage

```bash
chmod +x scripts/deploy-prod.sh
sudo ./scripts/deploy-prod.sh -d yourdomain.com -e /path/to/prod.env
```

### Parameters

- `-d`: Domain name (required)
- `-e`: Path to production environment file (required)

### What it does

1. Creates backup of current deployment
2. Installs system dependencies
3. Sets up SSL certificates
4. Configures Nginx
5. Deploys application
6. Sets up monitoring
7. Configures maintenance tasks

### Example Deployment

```bash
# Create production environment file
cp BE/.env.example prod.env
vim prod.env  # Edit configuration

# Run deployment
sudo ./scripts/deploy-prod.sh -d serverless.example.com -e prod.env
```

### Output

```bash
Starting production deployment...
Creating backup of current deployment...
Installing system dependencies...
Setting up SSL certificate...
Configuring Nginx...
Deploying application...
Setting up monitoring...
Setting up maintenance scripts...

Deployment complete!
Application deployed at: https://serverless.example.com
Grafana dashboard: https://serverless.example.com/grafana
MinIO console: https://serverless.example.com/minio
```

## Application Updates

The `update-app.sh` script handles application updates with automatic rollback.

### Usage

```bash
chmod +x scripts/update-app.sh
sudo ./scripts/update-app.sh
```

### What it does

1. Creates backup before update
2. Updates application code
3. Runs database migrations
4. Verifies deployment
5. Rolls back automatically if update fails

### Example Update

```bash
# Update application
sudo ./scripts/update-app.sh
```

### Output

```bash
Starting application update...
Creating backup before update...
Updating application...
Verifying deployment...
Backend health check passed
Frontend check passed
Update completed successfully!
```

### Rollback Process

If the update fails, the script automatically:
1. Restores the latest backup
2. Rolls back database changes
3. Restarts services

```bash
Update failed!
Rolling back...
Restoring from backup: /opt/backups/20250206_164854
Rollback complete
```

## Best Practices

### Development

1. **Environment Configuration**
   ```bash
   # Review and update environment variables before setup
   vim BE/.env
   vim FE/.env
   ```

2. **Custom Configuration**
   ```bash
   # Edit script configuration if needed
   vim scripts/setup-dev.sh
   ```

### Production

1. **Backup Verification**
   ```bash
   # Verify backup location
   ls -l /opt/backups
   ```

2. **SSL Certificate**
   ```bash
   # Verify SSL certificate
   certbot certificates
   ```

3. **Monitoring Setup**
   ```bash
   # Check monitoring status
   systemctl status prometheus
   systemctl status grafana-server
   ```

### Updates

1. **Pre-update Checks**
   ```bash
   # Check system resources
   df -h
   free -m
   ```

2. **Post-update Verification**
   ```bash
   # Check application logs
   journalctl -u pm2-root
   ```

## Troubleshooting

### Common Issues

1. **Permission Errors**
   ```bash
   # Fix script permissions
   chmod +x scripts/*.sh
   ```

2. **Port Conflicts**
   ```bash
   # Check port usage
   netstat -tulpn | grep -E '3000|3001|9000|4646'
   ```

3. **Backup Issues**
   ```bash
   # Check backup space
   du -sh /opt/backups
   ```

### Logs

1. **Development Logs**
   ```bash
   # View development logs
   tail -f BE/logs/development.log
   ```

2. **Production Logs**
   ```bash
   # View production logs
   tail -f /var/log/serverless-platform/production.log
   ```

3. **Deployment Logs**
   ```bash
   # View deployment logs
   tail -f /var/log/serverless-platform/deploy.log
   ```

## Maintenance

### Regular Tasks

1. **Check Backups**
   ```bash
   # List recent backups
   ls -l /opt/backups
   ```

2. **Monitor Disk Space**
   ```bash
   # Check disk usage
   df -h /opt/serverless-platform
   ```

3. **Review Logs**
   ```bash
   # Check for errors
   grep ERROR /var/log/serverless-platform/*.log
   ```

### Security

1. **SSL Certificate**
   ```bash
   # Check SSL expiry
   certbot certificates
   ```

2. **Audit Logs**
   ```bash
   # Check auth logs
   tail -f /var/log/auth.log
   ```

### Performance

1. **Monitor Resources**
   ```bash
   # Check system load
   top -b -n 1
   ```

2. **Database Performance**
   ```bash
   # Check database status
   pg_top -d serverless_prod
   ```
