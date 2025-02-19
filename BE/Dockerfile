# Build stage
FROM node:18-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage
FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Copy templates
COPY templates ./templates

# Create app user
RUN addgroup -S app && adduser -S app -G app

# Set ownership
RUN chown -R app:app /usr/src/app

# Use non-root user
USER app

EXPOSE 3000

CMD ["npm", "run", "start:prod"]
