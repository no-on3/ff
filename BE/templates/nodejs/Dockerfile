FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install

# Copy function code
COPY index.js ./

# Install runtime dependencies
RUN npm install express

# Add wrapper script
COPY wrapper.js ./

EXPOSE 8080

CMD ["node", "wrapper.js"]
