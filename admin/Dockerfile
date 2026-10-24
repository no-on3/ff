# The admin, as a static build served by Caddy, built from admin/.
#   docker build -t ff-admin --build-arg VITE_API_URL=https://api.example --build-arg VITE_OIDC_AUTHORITY=https://login.example/realms/ff admin
# Vite bakes these into the bundle: each environment builds its own image. The build refuses to go without them:
# a production admin always logs in. Caddy serves it on :8080 as a numeric non-root user, on a read-only root.
FROM node:24.21.0-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_API_URL
ARG VITE_OIDC_AUTHORITY
ARG VITE_OIDC_CLIENT_ID=ff-admin
RUN test -n "$VITE_API_URL" && test -n "$VITE_OIDC_AUTHORITY" \
      || { echo "VITE_API_URL and VITE_OIDC_AUTHORITY are required: the production admin logs in and calls the API" >&2; exit 1; }
RUN npm run build

# Caddy 2.11.7, built here with Go 1.26.9 and golang.org/x/net v0.60.0, which fix advisories in its release's
# binary (Go 1.26.8, x/net v0.59.0); the console's image builds it the same way. Without the capability to bind
# ports below 1024 (XCADDY_SETCAP), which a container without any capability may not execute. It listens on 8080.
FROM golang:1.26.9-alpine3.24 AS caddy
RUN go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.7 \
 && XCADDY_SETCAP=0 xcaddy build v2.11.7 --replace golang.org/x/net=golang.org/x/net@v0.60.0 --output /tmp/caddy

FROM alpine:3.24.2
LABEL org.opencontainers.image.title="ff-admin" \
      org.opencontainers.image.description="FF's admin, a static build served by Caddy"
COPY --from=caddy /tmp/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
# Caddy's own files, which it doesn't keep with the admin API off, go to /tmp, which the deployment mounts.
ENV XDG_CONFIG_HOME=/tmp/caddy XDG_DATA_HOME=/tmp/caddy
USER 65532:65532
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
