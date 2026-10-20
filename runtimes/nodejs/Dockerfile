# FF function runtime for Node.js (runtime protocol v2).
# Build:  docker build -t ff-runtime-nodejs:24-v2 runtimes/nodejs
# The final image holds only the compiled runtime, TypeScript (used to
# transpile user .ts files) and its code cache. Nothing is installed when a function starts.
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
# The TypeScript compiler's V8 code cache, written after a transpile so that it holds the code the transpile
# runs (src/typescript-cache.ts): at 0.1 CPU in gVisor, a cold start's load of the compiler goes from 7 to 10 s
# to about 2.5 s. It belongs to root, read-only.
RUN node -e "require('/opt/ff/dist/ts-hook').writeTypeScriptCache()" && chmod a=r /opt/ff/typescript.codecache
# The base image's package managers, which nothing here runs: a function's code can't install anything at run
# time (read-only root), npm's own dependencies carry advisories the image scan reports (hack/ci.sh), and
# customers' code gets fewer tools.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV NODE_ENV=production \
    LAMBDA_TASK_ROOT=/var/task \
    FF_HANDLER=function.handler \
    PORT=8080
# Non-root, numeric so Kubernetes runAsNonRoot can verify it.
USER 10001:10001
EXPOSE 8080
CMD ["node", "/opt/ff/dist/main.js"]
