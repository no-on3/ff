# The status page's web server on FF's development server (../../README.md, "The status page"): Caddy, beside the
# cluster, serving the page the probe's renderer writes, which Docker Compose mounts read-only in /srv, so that the
# page answers when the cluster or the backend doesn't. The server's proxy reaches it on its own network.
#   docker build -t ff-status-web deploy/dev-server/status/web
# Caddy built as the console's image builds it (FE/Dockerfile), the same lines, so that each build reuses the other's:
# Caddy 2.11.7 with Go 1.26.10, golang.org/x/net v0.62.0 and go-jose v4.1.6, which fix advisories in its release's
# binary, and without the capability to bind ports below 1024, which a container without any capability may not
# execute. It listens on 8080, as a numeric non-root user, on a read-only root.
FROM golang:1.26.10-alpine3.24 AS caddy
RUN go install github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.7 \
 && XCADDY_SETCAP=0 xcaddy build v2.11.7 --replace golang.org/x/net=golang.org/x/net@v0.62.0 \
      --replace github.com/go-jose/go-jose/v4=github.com/go-jose/go-jose/v4@v4.1.6 --output /tmp/caddy

FROM alpine:3.24.3
LABEL org.opencontainers.image.title="ff-status-web" \
      org.opencontainers.image.description="FF's status page, served by Caddy"
COPY --from=caddy /tmp/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
# Caddy's own files, which it doesn't keep with the admin API off, go to /tmp, which Compose mounts.
ENV XDG_CONFIG_HOME=/tmp/caddy XDG_DATA_HOME=/tmp/caddy
USER 65532:65532
EXPOSE 8080
# Alive when it answers: Compose waits for it, with busybox's wget, which Alpine has.
HEALTHCHECK --interval=5s --timeout=3s --retries=12 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
