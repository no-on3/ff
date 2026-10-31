# The server of customers' mail (ADR 0012): Postfix 3.11, which delivers what the backend hands it, signed already with
# each customer's DKIM key, and takes back what comes for the return-path domains, bounces.mail.<domain>, into one
# Maildir; FF's agent (agent.mjs, Node.js's standard library alone) keeps Postfix running and gives the backend those
# bounces over HTTPS. Development runs it from docker-compose.yml's mail (its profile "mail"); production runs it on a
# server and an address of its own (README.md).
#   docker build -t ff-mail deploy/mail
FROM alpine:3.24.2
# Node.js for the agent, OpenSSL for a development certificate; the user whose Maildir takes the bounces.
RUN apk add --no-cache postfix nodejs openssl && adduser -D -H -s /sbin/nologin -u 10025 ff-bounces && postconf -h mail_version
COPY agent.mjs entrypoint.sh /opt/ff-mail/
ENV FF_MAIL_DIR=/var/lib/ff-mail
VOLUME /var/lib/ff-mail
# SMTP, then the agent's API.
EXPOSE 25 6391
ENTRYPOINT ["/bin/sh", "/opt/ff-mail/entrypoint.sh"]
