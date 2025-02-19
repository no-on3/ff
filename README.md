# Serverless Platform

A modern serverless platform that allows users to deploy and manage serverless functions, similar to AWS Lambda.

## Project Structure

```
.
├── BE/                     # Backend services
│   ├── src/
│   │   ├── controllers/    # Request handlers
│   │   ├── services/       # Business logic
│   │   ├── models/        # Database models
│   │   ├── middleware/    # Express middleware
│   │   ├── utils/         # Utility functions
│   │   ├── config/       # Configuration files
│   │   └── routes/       # API routes
│   └── tests/            # Backend tests
│
├── FE/                    # Frontend application
│   ├── src/
│   │   ├── components/   # Reusable React components
│   │   ├── pages/        # Page components
│   │   ├── services/     # API services
│   │   ├── hooks/        # Custom React hooks
│   │   ├── utils/        # Utility functions
│   │   ├── assets/       # Static assets
│   │   ├── styles/       # Global styles
│   │   └── context/      # React context
│   └── tests/            # Frontend tests
│
├── infrastructure/        # Infrastructure as code
│   ├── nomad/           # Nomad configuration
│   ├── docker/          # Docker configuration
└── docs/                # Documentation
- Pay-as-you-go billing with Stripe
- Real-time function monitoring
- Auto-scaling capabilities
- Custom domain support
- Function versioning

## Prerequisites

- Node.js 18+
- Docker
- Nomad
- PostgreSQL
- MinIO
- Auth0 account
- Stripe account

## Getting Started

1. Clone the repository
2. Set up environment variables
3. Install dependencies
4. Start the development servers

### Backend Setup

```bash
cd BE
cp .env.example .env  # Configure your environment variables
npm install
npm run dev
```

### Frontend Setup

```bash
cd FE
cp .env.example .env  # Configure your environment variables
npm install
npm run dev
```

### Infrastructure Setup

Follow the instructions in the infrastructure directory for setting up:
- Nomad cluster
- PostgreSQL database
- MinIO storage
- Monitoring stack

## Development

- Backend API runs on `http://localhost:3000`
- Frontend development server runs on `http://localhost:5173`
- API documentation available at `http://localhost:3000/api-docs`

## Testing

```bash
# Backend tests
cd BE && npm test

# Frontend tests
cd FE && npm test
```

## Deployment

Refer to the deployment guides in the `docs` directory for:
- Production deployment
- Scaling considerations
- Security best practices
- Monitoring setup

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

## License

MIT
