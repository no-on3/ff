# The spike's Postfix: Alpine's, relaying everything to the spike's receiver, and keeping what comes for the bounces'
# domain in one mailbox, as the sending server of customers' mail would get their bounces back.
FROM alpine:3.24.2
RUN apk add --no-cache postfix && adduser -D -H -s /sbin/nologin bounces
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
