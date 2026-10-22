# FF's edge proxy: Caddy 2.11.7 with the RFC 2136 DNS module, without a site, on Alpine 3.24.2. Its Caddyfile, the
# hostnames and the certificates come from the deployment (deploy/k8s/platform/edge/Caddyfile, its environment, and
# a volume).
#   docker build -t ff-edge deploy/edge
# The module lets Caddy prove FF's function domain to Let's Encrypt by DNS (DNS-01) through any DNS server that
# takes RFC 2136 updates (BIND, Knot, PowerDNS): the one way to a wildcard certificate, *.<function domain>, which
# every function URL shares. An operator whose DNS is elsewhere builds the edge with that provider's module instead:
# one --with below.
# The builder would give the binary the capability to bind ports below 1024 (XCADDY_SETCAP), which a container
# without any capability may not execute: it is built without, and listens on 8080 and 8443, which the Service maps
# to 80 and 443.
FROM caddy:2.11.7-builder-alpine AS builder
RUN XCADDY_SETCAP=0 xcaddy build v2.11.7 --with github.com/caddy-dns/rfc2136@v1.0.0 --output /tmp/caddy

FROM alpine:3.24.2
LABEL org.opencontainers.image.title="ff-edge" \
      org.opencontainers.image.description="FF's edge proxy: Caddy, with automatic TLS"
COPY --from=builder /tmp/caddy /usr/bin/caddy
# Its certificates and keys, on the volume the deployment mounts; its own settings, which it doesn't keep, in /tmp.
ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/tmp/caddy
USER 65532:65532
EXPOSE 8080 8443
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
