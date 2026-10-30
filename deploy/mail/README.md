# The server of customers' mail

Customers' apps send mail with SES v2's API, at FF's SES endpoint ([ADR 0012](../../docs/adr/0012-customer-mail.md)); the backend queues each message and hands it to this server, which delivers it to its recipients' servers. The server has an address of its own, never FF's own mail's, so that one customer's spam doesn't get FF's own mail blocked. What comes back, the bounces and the complaints, comes to this server too, which keeps it for the backend. This folder is the reference server.

## The image

`docker build -t ff-mail deploy/mail`:
- **Postfix 3.11** (Alpine 3.24.2's, the version step 4's spike measured): it relays what the backend hands it, already signed with each customer's DKIM key, from the backend's addresses alone (`FF_MAIL_RELAY_FROM`), to nobody else's; it takes what comes for the return-path domains, `bounces.mail.<domain>` and FF's own, into one Maildir, whatever the address before the `@`: a message's own, `b-<message ID>@`, says whose it is. It refuses everything else from the internet. A message waits a day at most.
- **FF's agent,** `agent.mjs`, Node.js's standard library alone: it starts Postfix (`postfix start-fg`), and again when it stops, and answers the backend's API on port 6391, over HTTPS with the server's certificate, to a bearer token whose SHA-256 alone it has:
  - `GET /bounces?limit=<n>`: what came back and wasn't read, oldest first, each message whole, in base64; the backend asks every 10 seconds;
  - `DELETE /bounces/<id>`: read, and deleted;
  - `GET /health`: whether Postfix runs, and how many messages wait.
- **`entrypoint.sh`:** the certificate checked, or made in development; Postfix's settings; the token's SHA-256.
- The agent runs as root, which Postfix's own start takes; the Maildir belongs to a user of its own, `ff-bounces`.

## Installing it

1. **A machine of its own,** in Tunisia as FF's others (the [decision log](../../docs/decisions.md), 21), with an address of its own whose provider lets port 25 out (many clouds close it by default, and open it on asking), and a firewall: port 25 from the internet (bounces, complaints) and from the backend; the agent's port, 6391, from the backend alone. Nothing else.
2. **Its name,** such as `mail.ffunc.cloud`: an A record to its address, and the address's reverse record (PTR) back to that name, which receiving servers check. `FF_MAIL_HOSTNAME` names it, and the backend's `FF_EMAIL_MAIL_HOST`: each customer's return-path domain's MX record names it, and its SPF record allows it.
3. **FF's own return-path domain,** for a customer's domain whose own isn't found yet, such as `bounces.mail.ffunc.cloud` (`FF_EMAIL_BOUNCE_DOMAIN`): an MX record to the server's name, and a TXT record `v=spf1 a:mail.ffunc.cloud -all`.
4. **Its certificate,** for its name, from a public CA (Let's Encrypt, by DNS or on port 80), in `/var/lib/ff-mail/tls/server.crt` and `server.key`: the backend hands mail over TLS alone, and checks it; receiving servers see it when they ask for TLS. Renew it before it expires, then restart the server.
5. **The backend's token,** 32 random bytes, kept in FF's password manager: the server gets its SHA-256 alone, `FF_MAIL_AGENT_TOKEN_SHA256` (`printf %s "$token" | sha256sum`).
6. **Start it:** `docker run -d --name ff-mail --restart unless-stopped --network host -v /var/lib/ff-mail:/var/lib/ff-mail -e FF_MAIL_HOSTNAME=mail.ffunc.cloud -e FF_MAIL_RELAY_FROM="<the backend's addresses, as CIDRs>" -e FF_MAIL_AGENT_TOKEN_SHA256=… ff-mail`.
7. **The backend's settings** (`deploy/k8s/platform/backend.env`, the token in the Secret): `FF_EMAIL_SMTP_HOST` (the server's name), `FF_EMAIL_SMTP_PORT` (25), `FF_EMAIL_AGENT_URL` (`https://<name>:6391`, or another address the backend reaches it at), `FF_EMAIL_AGENT_TOKEN`, and `FF_EMAIL_CA_FILE` for a CA of the operator's. The backend checks them at its start; without `FF_EMAIL_SMTP_HOST`, the SES endpoint takes no message.

## What the backend does there

- **A message:** handed over SMTP with STARTTLS, signed with its domain's DKIM key, its envelope's sender its return path, `b-<message ID>@bounces.mail.<domain>` once the domain's own MX is found, FF's own until then; a refusal for now is tried again 30 s, 2, 10 and 30 minutes later, then hourly, for a day; a refusal for good fails it.
- **What comes back:** a bounce for good, or a complaint, puts the address on the account's suppression list, as SES's does; past SES's rates over the last 14 days (5% of bounces or 0.1% of complaints, of 100 recipients at least), the account's sending is reviewed, then stopped past 10% or 0.5%, and the operator is told.
- **Functions** never reach this server: their NetworkPolicy keeps FF's network out, and the internet's port 25 too. Their mail goes through the SES endpoint, and its checks and quotas.

## Development

`hack/k8s/mail-up.sh` starts docker-compose.yml's `mail` (its profile `mail`) at 10.199.0.12 on the data network, handing every message to Mailpit (http://localhost:58025) instead of its recipients' servers, copies the development CA out to `hack/.mail-server/ca.crt` and prints the backend's settings. Its token is `ff-mail-dev`, which production refuses. L4 and L5 run their own, with `mail-receiver` (its profile `mail-test`) as recipients' servers: it keeps each message and refuses `bounce-me@` addresses, so that a bounce comes back.
