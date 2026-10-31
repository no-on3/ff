#!/bin/sh
# Postfix for the spike: RELAY (host:port) takes every message for elsewhere; BOUNCES' domain is delivered here, every
# address of it to the one user bounces, whose mailbox is /var/mail/bounces.
set -eu
postconf -e \
  "myhostname = mail.spike.test" \
  "mydomain = spike.test" \
  "inet_protocols = ipv4" \
  "mydestination = ${BOUNCES}" \
  "local_recipient_maps =" \
  "luser_relay = bounces@${BOUNCES}" \
  "alias_maps =" \
  "alias_database =" \
  "relayhost = [${RELAY%:*}]:${RELAY#*:}" \
  "mynetworks = 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16" \
  "smtpd_relay_restrictions = permit_mynetworks, reject_unauth_destination" \
  "smtp_tls_security_level = none" \
  "maillog_file = /dev/stdout" \
  "compatibility_level = 3.6"
exec postfix start-fg
