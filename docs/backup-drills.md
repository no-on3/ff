# Restore drills

Each drill restores FF's database and Keycloak's to a point in time from the second site alone, and the bucket's legal records too ([deploy/backup/README.md](../deploy/backup/README.md)). Run one every month, and after any change to the backups: `hack/backup-drill.sh --record` adds its line here. A drill on the production setup notes the provider's or the server's own figures beside it.

The targets (client-readiness plan, P-61): data lost at most 15 minutes before a failure (recovery point), and service back within 4 hours (recovery time).

| Date (UTC) | Commit | What was restored | Time to restore | Outcome |
|---|---|---|---|---|
| 2026-10-20 | 2e3b8c3 | PostgreSQL 15.18 with WAL-G 3.0.9, both databases to a target time; the legal records with rclone 1.75.1 | 9 s | 15 checks passed |
| 2026-10-20 | 92df5d1 | PostgreSQL 15.19 with WAL-G 3.0.9, both databases to a target time; the legal records with rclone 1.75.1 | 7 s | 15 checks passed |
