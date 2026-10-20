#!/usr/bin/env python3
"""
Writes the production realm, deploy/k8s/platform/keycloak/ff-realm.json, from the development realm,
deploy/keycloak/ff-realm.json, so that the two never drift apart. What differs:
  - the console's and the admin app's addresses, and the mail server, are Keycloak's environment variables,
    which it reads when it imports the realm (${FF_CONSOLE_URL}, ${FF_ADMIN_URL}, ${FF_SMTP_HOST}, ...);
  - no test client (ff-e2e), and no password grant on the admin app's client: operators log in through the
    browser, with their one-time password;
  - no user: the first operator is made in Keycloak's admin console (deploy/k8s/README.md);
  - a password policy: 12 characters at least, 128 at most, neither the username nor the e-mail address. The
    development realm has none, so that its test users keep short passwords.
  deploy/keycloak/production-realm.py            # writes it
  deploy/keycloak/production-realm.py --check    # says whether the file is up to date, for the tests
"""
import json
import pathlib
import sys

here = pathlib.Path(__file__).resolve().parent
source = here / 'ff-realm.json'
target = here.parent / 'k8s' / 'platform' / 'keycloak' / 'ff-realm.json'


def production(realm: dict) -> dict:
    realm = json.loads(json.dumps(realm))
    realm['clients'] = [client for client in realm['clients'] if client['clientId'] != 'ff-e2e']
    apps = {'ff-console': '${FF_CONSOLE_URL}', 'ff-admin': '${FF_ADMIN_URL}'}
    for client in realm['clients']:
        origin = apps.get(client['clientId'])
        if origin is None:
            continue
        client['redirectUris'] = [f'{origin}/*']
        client['webOrigins'] = [origin]
        client.setdefault('attributes', {})['post.logout.redirect.uris'] = f'{origin}/*'
        client['directAccessGrantsEnabled'] = False
    realm['users'] = []
    realm['passwordPolicy'] = 'length(12) and maxLength(128) and notUsername(undefined) and notEmail(undefined)'
    realm['smtpServer'] = {
        'host': '${FF_SMTP_HOST}',
        'port': '${FF_SMTP_PORT}',
        'from': '${FF_SMTP_FROM}',
        'fromDisplayName': 'FF',
        'auth': 'true',
        'user': '${FF_SMTP_USER}',
        'password': '${FF_SMTP_PASSWORD}',
        'starttls': 'true',
        'ssl': 'false',
    }
    return realm


text = json.dumps(production(json.loads(source.read_text())), indent=2, ensure_ascii=False) + '\n'
if '--check' in sys.argv:
    if not target.exists() or target.read_text() != text:
        sys.exit(f'{target} is not what {source} gives: run {pathlib.Path(__file__).name} again')
    print(f'{target.name}: up to date with the development realm')
else:
    target.write_text(text)
    print(f'wrote {target}')
