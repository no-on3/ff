# FF's backend: the API, the scheduler's jobs and the operator's metrics, built from BE/.
#   docker build -t ff-backend BE
# The image holds the compiled backend and its production dependencies only. It runs as a numeric non-root
# user, so that Kubernetes' runAsNonRoot can check it, on a read-only root: it writes nothing but to /tmp,
# which the deployment mounts. The migrations run from it too, as a step before each rollout:
#   node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js
FROM node:24.21.0-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# The production dependencies alone. Optional ones too are left out: TypeORM's optional peer ts-node, which
# brings TypeScript, for its CLI on .ts files the image never has; and pg's for Cloudflare Workers.
FROM node:24.21.0-alpine3.24 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund

FROM node:24.21.0-alpine3.24
LABEL org.opencontainers.image.title="ff-backend" \
      org.opencontainers.image.description="FF's backend: the functions API, the jobs, the operator's metrics"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The base image's package managers, which the backend never runs: npm's own dependencies carry advisories that
# the image scan reports (hack/ci.sh), and fewer tools means less to use for whoever got in.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
USER 10001:10001
# The API, and the operator's metrics (FF_METRICS_PORT).
EXPOSE 3000 9464
CMD ["node", "dist/main.js"]
