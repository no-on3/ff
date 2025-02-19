# Installation and Deployment Guide

This guide covers the installation and deployment of the NestJS-based serverless platform.

## Local Development Setup

### Prerequisites

1. **Node.js and npm**
   ```bash
   # Install Node.js 18.x
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs

   # Verify installation
   node --version  # Should be 18.x or higher
   npm --version   # Should be 8.x or higher
   ```

2. **TypeScript**
   ```bash
   # Install TypeScript globally
   npm install -g typescript @nestjs/cli

   # Verify installation
   tsc --version   # Should be 5.1.x or higher
   nest --version  # Should be 10.x or higher
   ```

3. **Docker and Docker Compose**
   ```bash
   # Install Docker
   curl -fsSL https://get.docker.com | sudo sh

   # Install Docker Compose
   sudo apt-get install docker-compose

   # Add your user to docker group
   sudo usermod -aG docker $USER
   ```

4. **PostgreSQL**
   ```bash
   # Install PostgreSQL
   sudo apt-get install postgresql postgresql-contrib

   # Start PostgreSQL service
   sudo systemctl start postgresql
   sudo systemctl enable postgresql
   ```

### Development Installation

1. **Clone the Repository**
   ```bash
   git clone https://github.com/yourusername/serverless-platform.git
   cd serverless-platform
   ```

2. **Backend Setup**
   ```bash
   cd BE

   # Install dependencies
   npm install

   # Copy environment file
   cp .env.example .env

   # Edit environment variables
   nano .env

   # Run database migrations
   npm run migration:run

   # Start development server
   npm run start:dev
   ```

3. **Frontend Setup**
   ```bash
   cd FE

   # Install dependencies
   npm install

   # Copy environment file
   cp .env.example .env

   # Start development server
   npm start
   ```

## Docker-based Local Development

For a quick and consistent development environment, you can use Docker and Docker Compose. This method ensures that all developers have the same environment and dependencies.

### Prerequisites

1. **Docker**
   ```bash
   # Install Docker (if not already installed)
   curl -fsSL https://get.docker.com | sudo sh
   ```

2. **Docker Compose**
   ```bash
   # Install Docker Compose (if not already installed)
   sudo apt-get install docker-compose
   ```

### Starting the Development Environment

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd ff
   ```

2. **Start the infrastructure services**
   ```bash
   # Start all required services (PostgreSQL, MinIO, Prometheus, Grafana, and Nomad)
   docker-compose up -d
   ```

   This command will start:
   - PostgreSQL (port 5432)
   - MinIO (ports 9000, 9001)
   - Prometheus (port 9090)
   - Grafana (port 3001)
   - Nomad (port 4646)

3. **Access the services**
   - MinIO Console: http://localhost:9001 (credentials: minioadmin/minioadmin)
   - Grafana: http://localhost:3001 (credentials: admin/admin)
   - Prometheus: http://localhost:9090
   - Nomad UI: http://localhost:4646

### Development Workflow

1. **Backend Development**
   ```bash
   # Navigate to backend directory
   cd BE

   # Install dependencies
   npm install

   # Start the development server
   npm run dev
   ```

   The backend will be available at http://localhost:3000

2. **Frontend Development**
   ```bash
   # Navigate to frontend directory
   cd FE

   # Install dependencies
   npm install

   # Start the development server
   npm run dev
   ```

   The frontend will be available at http://localhost:5173

### Useful Docker Commands

1. **View running containers**
   ```bash
   docker-compose ps
   ```

2. **View container logs**
   ```bash
   # View logs for a specific service
   docker-compose logs [service-name]

   # Follow logs in real-time
   docker-compose logs -f [service-name]
   ```

3. **Stop the development environment**
   ```bash
   # Stop all containers
   docker-compose down

   # Stop and remove volumes (will delete all data)
   docker-compose down -v
   ```

4. **Rebuild services**
   ```bash
   # Rebuild a specific service
   docker-compose build [service-name]

   # Rebuild all services
   docker-compose build
   ```

### Troubleshooting

1. **Port Conflicts**
   If you see errors about ports being in use, make sure no other services are running on the required ports:
   - 3000 (Backend API)
   - 5173 (Frontend Dev Server)
   - 5432 (PostgreSQL)
   - 9000, 9001 (MinIO)
   - 9090 (Prometheus)
   - 3001 (Grafana)
   - 4646 (Nomad)

2. **Database Connection Issues**
   - Check if the PostgreSQL container is running: `docker-compose ps`
   - Verify the database credentials in your `.env` file match those in `docker-compose.yml`
   - Try recreating the containers: `docker-compose down && docker-compose up -d`

3. **Container Health Checks**
   ```bash
   # Check container health status
   docker-compose ps

   # Inspect container logs for issues
   docker-compose logs [service-name]
   ```

## Production Deployment

### System Requirements

- Ubuntu 20.04 LTS or later
- 4 CPU cores
- 8GB RAM minimum
- 20GB storage
- PostgreSQL 13 or later
- Node.js 18 or later
- Docker and Docker Compose
- Nginx
- SSL certificate

### Production Installation

1. **System Preparation**
   ```bash
   # Update system
   sudo apt-get update
   sudo apt-get upgrade -y

   # Install required packages
   sudo apt-get install -y curl git build-essential
   ```

2. **Install Node.js and npm**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs

   # Install NestJS CLI globally
   npm install -g @nestjs/cli
   ```

3. **Clone and Build**
   ```bash
   # Clone repository
   git clone https://github.com/yourusername/serverless-platform.git
   cd serverless-platform

   # Install dependencies and build
   cd BE
   npm install
   npm run build
   ```

4. **Database Setup**
   ```bash
   # Create production database
   sudo -u postgres psql -c "CREATE DATABASE serverless_prod;"
   sudo -u postgres psql -c "CREATE USER serverless WITH PASSWORD 'your_password';"
   sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE serverless_prod TO serverless;"

   # Run migrations
   NODE_ENV=production npm run migration:run
   ```

5. **Environment Configuration**
   ```bash
   # Copy and edit production environment file
   cp .env.example .env.production
   nano .env.production
   ```

6. **Process Manager Setup**
   ```bash
   # Install PM2
   npm install -g pm2

   # Create PM2 configuration
   cat > ecosystem.config.js << EOL
   module.exports = {
     apps: [{
       name: 'serverless-api',
       script: 'dist/main.js',
       instances: 'max',
       exec_mode: 'cluster',
       env_production: {
         NODE_ENV: 'production'
       }
     }]
   }
   EOL

   # Start application
   pm2 start ecosystem.config.js --env production
   pm2 save
   ```

7. **Nginx Configuration**
   ```bash
   # Install Nginx
   sudo apt-get install -y nginx

   # Configure Nginx
   sudo nano /etc/nginx/sites-available/serverless-platform

   # Add configuration
   server {
     listen 80;
     server_name your-domain.com;

     location / {
       proxy_pass http://localhost:3000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection 'upgrade';
       proxy_set_header Host $host;
       proxy_cache_bypass $http_upgrade;
     }
   }

   # Enable site
   sudo ln -s /etc/nginx/sites-available/serverless-platform /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   ```

8. **SSL Setup**
   ```bash
   # Install Certbot
   sudo apt-get install -y certbot python3-certbot-nginx

   # Obtain SSL certificate
   sudo certbot --nginx -d your-domain.com
   ```

### Automated Deployment

Use the provided deployment scripts:

```bash
# Development setup
./scripts/setup-dev.sh

# Production deployment
./scripts/deploy-prod.sh -d your-domain.com -e path/to/env/file
```

## Monitoring Setup

1. **Prometheus Installation**
   ```bash
   # Install Prometheus
   sudo apt-get install -y prometheus

   # Configure Prometheus
   sudo nano /etc/prometheus/prometheus.yml

   # Add scrape configuration
   scrape_configs:
     - job_name: 'serverless-platform'
       static_configs:
         - targets: ['localhost:3000']
       metrics_path: '/metrics'
   ```

2. **Grafana Setup**
   ```bash
   # Install Grafana
   sudo apt-get install -y grafana

   # Start Grafana
   sudo systemctl start grafana-server
   sudo systemctl enable grafana-server
   ```

## Backup and Maintenance

1. **Database Backup**
   ```bash
   # Create backup script
   cat > backup-db.sh << EOL
   #!/bin/bash
   BACKUP_DIR="/opt/backups/database"
   TIMESTAMP=$(date +%Y%m%d_%H%M%S)
   mkdir -p "$BACKUP_DIR"
   pg_dump serverless_prod > "$BACKUP_DIR/backup_$TIMESTAMP.sql"
   find "$BACKUP_DIR" -type f -mtime +30 -delete
   EOL

   chmod +x backup-db.sh
   ```

2. **Log Rotation**
   ```bash
   # Configure log rotation
   sudo nano /etc/logrotate.d/serverless-platform

   /var/log/serverless-platform/*.log {
     daily
     rotate 14
     compress
     delaycompress
     notifempty
     create 0640 www-data adm
     sharedscripts
     postrotate
       pm2 reloadLogs
     endscript
   }
   ```

## Troubleshooting

1. **Check Application Logs**
   ```bash
   # View NestJS logs
   pm2 logs serverless-api

   # View Nginx logs
   sudo tail -f /var/log/nginx/error.log
   ```

2. **Check System Resources**
   ```bash
   # Monitor system resources
   htop
   
   # Check disk space
   df -h
   ```

3. **Database Maintenance**
   ```bash
   # Connect to database
   psql -U serverless -d serverless_prod

   # Check active connections
   SELECT * FROM pg_stat_activity;
   ```

## Security Considerations

1. **Firewall Configuration**
   ```bash
   # Configure UFW
   sudo ufw allow ssh
   sudo ufw allow http
   sudo ufw allow https
   sudo ufw enable
   ```

2. **SSL/TLS**
   - Use strong SSL configuration
   - Enable HTTP/2
   - Configure HSTS

3. **Database Security**
   - Use strong passwords
   - Limit database access
   - Regular security updates

4. **Application Security**
   - Keep dependencies updated
   - Regular security audits
   - Implement rate limiting
