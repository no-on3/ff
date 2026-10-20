# FF's edge proxy: Caddy 2.11.7 alone, without a site, on Alpine 3.24.2. Its Caddyfile, the hostnames and the
# certificates come from the deployment (deploy/k8s/platform/edge/Caddyfile, its environment, and a volume).
#   docker build -t ff-edge deploy/edge
# Caddy's binary is copied without the capability its image gives it to bind ports below 1024, which a container
# without any capability may not execute: it listens on 8080 and 8443, which the Service maps to 80 and 443.
FROM caddy:2.11.7-alpine AS caddy
RUN cp /usr/bin/caddy /tmp/caddy

FROM alpine:3.24.2
LABEL org.opencontainers.image.title="ff-edge" \
      org.opencontainers.image.description="FF's edge proxy: Caddy, with automatic TLS"
COPY --from=caddy /tmp/caddy /usr/bin/caddy
# Its certificates and keys, on the volume the deployment mounts; its own settings, which it doesn't keep, in /tmp.
ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/tmp/caddy
USER 65532:65532
EXPOSE 8080 8443
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
