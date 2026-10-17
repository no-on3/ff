# FF function runtime for Node.js (runtime protocol v2).
# Build:  docker build -t ff-runtime-nodejs:24-v2 runtimes/nodejs
# The final image holds only the compiled runtime and TypeScript (used to
# transpile user .ts files). Nothing is installed when a function starts.
FROM node:24-alpine AS build
WORKDIR /opt/ff
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
LABEL org.opencontainers.image.title="ff-runtime-nodejs" \
      org.opencontainers.image.description="FF function runtime for Node.js, protocol v2"
WORKDIR /opt/ff
COPY --from=build /opt/ff/package.json ./
COPY --from=build /opt/ff/node_modules ./node_modules
COPY --from=build /opt/ff/dist ./dist
ENV NODE_ENV=production \
    LAMBDA_TASK_ROOT=/var/task \
    FF_HANDLER=function.handler \
    PORT=8080
# Non-root, numeric so Kubernetes runAsNonRoot can verify it.
USER 10001:10001
EXPOSE 8080
CMD ["node", "/opt/ff/dist/main.js"]
