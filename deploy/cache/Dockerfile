# The server of customers' caches (ADR 0013): Valkey 9.1.2, a process for each cache under a user of its own, which
# FF's agent (agent.mjs, Node.js's standard library alone) starts, keeps and measures, as the backend tells it over
# HTTPS. Development runs it from docker-compose.yml's cache (its profile "cache"); production runs it on a server of
# its own (README.md).
#   docker build -t ff-cache deploy/cache
FROM valkey/valkey:9.1.2-alpine3.24
# Node.js for the agent, su-exec to start each cache's process as its own user, OpenSSL for a development certificate.
RUN apk add --no-cache nodejs su-exec openssl && node --version && su-exec nobody true
COPY agent.mjs entrypoint.sh /opt/ff-cache/
ENV FF_CACHE_DIR=/var/lib/ff-cache
VOLUME /var/lib/ff-cache
# The agent's API, then the caches' ports (FF_CACHE_PORTS).
EXPOSE 6390 6400-6999
ENTRYPOINT ["/opt/ff-cache/entrypoint.sh"]
