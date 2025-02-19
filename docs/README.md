# Serverless Platform

A modern, NestJS-based serverless platform for running and managing serverless functions.

## Features

- Built with NestJS and TypeScript for type safety and modern development experience
- Support for multiple runtimes (Node.js, Python)
- Function monitoring and metrics with Prometheus
- Object storage with MinIO
- Container orchestration with Nomad
- Authentication and authorization
- API documentation with Swagger/OpenAPI
- Database management with TypeORM

## Prerequisites

- Node.js 18 or later
- Docker and Docker Compose
- PostgreSQL
- MinIO
- Nomad
- TypeScript knowledge for function development

## Quick Start

1. Clone the repository:
```bash
git clone https://github.com/yourusername/serverless-platform.git
cd serverless-platform
```

2. Install dependencies:
```bash
cd BE
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

4. Run database migrations:
```bash
npm run migration:run
```

5. Start the development server:
```bash
npm run start:dev
```

The API will be available at http://localhost:3000
API documentation will be available at http://localhost:3000/api

## Documentation

- [Installation and Deployment Guide](./installation-deployment.md)
- [Function Development Guide](./function-development.md)
- [API Reference](./api-reference.md)
- [Monitoring and Debugging Guide](./monitoring-debugging.md)
- [Automated Deployment Guide](./automated-deployment.md)

## Development

### Project Structure
```
BE/
├── src/
│   ├── auth/           # Authentication module
│   ├── functions/      # Functions module
│   ├── monitoring/     # Monitoring module
│   ├── minio-client/   # MinIO client module
│   ├── nomad/          # Nomad client module
│   ├── migrations/     # TypeORM migrations
│   ├── config/         # Configuration
│   ├── templates/      # Function templates
│   ├── app.module.ts   # Main application module
│   └── main.ts         # Application entry point
├── test/              # Test files
├── dist/              # Compiled files
└── package.json
```

### Available Scripts

- `npm run build` - Build the application
- `npm run start:dev` - Start the development server
- `npm run start:debug` - Start the server in debug mode
- `npm run start:prod` - Start the production server
- `npm run test` - Run tests
- `npm run migration:generate` - Generate database migrations
- `npm run migration:run` - Run database migrations
- `npm run lint` - Lint the code
- `npm run format` - Format the code

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details
