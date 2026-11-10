# Les outils du développeur : `ff`

`ff` est l'outil en ligne de commande de FF : un seul programme, qui ne parle qu'à l'API de FF, pour déployer, appeler et lire vos fonctions, et pour faire tourner toute votre application sur votre machine **comme FF la fait tourner**, sans compte ni réseau. La référence complète, en anglais : [`cli/README.md`](../../cli/README.md), qui donne chaque commande, et le [guide](../getting-started.md#3-use-ff).

## Ce que c'est

| | Avec `ff` | Chez AWS |
|---|---|---|
| L'installer | Une ligne, depuis le site de téléchargement de FF : Linux, macOS et Windows, chaque fichier vérifié avant d'être installé | La CLI d'AWS et la CLI de SAM |
| Se connecter | `ff login` dans le navigateur ; une clé d'API pour un script ou une CI | `aws sso login`, ou des clés d'accès |
| Toute l'application sur votre machine | `ff local start template.yaml` : les fonctions, leurs adresses, leurs planifications, les files, les compartiments, les sites, le courrier, une base PostgreSQL et un cache | `sam local`, qui fait tourner les fonctions seules |
| Partir d'un modèle | `ff init <nom> --template <modèle>` : neuf modèles, en Node.js et en Python | `sam init` |
| Depuis votre agent de code IA | `ff mcp` : les commandes de `ff` comme outils d'un agent, Claude Code, Cursor ou celui de VS Code | Les serveurs MCP d'AWS |
| Dans votre CI | Un job pour GitHub Actions, un pour GitLab CI | Les actions et les images d'AWS |
| Suivre une requête | `ff trace <id>` : les appels d'une même requête, d'une fonction à l'autre, en une frise | X-Ray |
| Savoir si c'est FF | La page d'état, chaque partie de FF vérifiée chaque minute | AWS Health Dashboard |

## L'installer

```bash
curl -fsSL https://get.<domaine>/install.sh | sh   # Linux et macOS, dans ~/.local/bin
irm https://get.<domaine>/install.ps1 | iex        # Windows, dans PowerShell
ff version --verbose                              # … release key <ID> : celle de la page de téléchargement
```

Le script choisit la version de votre système et de votre processeur (Linux x86_64 et arm64, macOS sur processeur Apple ou Intel, Windows x86_64), vérifie son SHA-256 et, si [minisign](https://jedisct1.github.io/minisign/) est installé, sa signature avec la clé de FF ; une vérification qui échoue n'installe rien. Une fois par jour au plus, `ff` dit quand une version plus récente est sortie, avec la ligne qui l'installe ; `FF_NO_UPDATE_CHECK=1` ou `ff config set update_check false` l'en empêche.

## Se connecter

```bash
ff config set endpoint https://api.<domaine>
ff login                                          # ouvrez l'adresse affichée, vérifiez le code, connectez-vous
ff whoami                                         # vous, vos comptes et votre rôle dans chacun
ff api-keys create --name ci --expires 90d --scopes functions:read,functions:write,functions:invoke,logs:read
ff logout                                         # la connexion révoquée, ses jetons effacés de cette machine
```

La connexion dure tant que vous utilisez `ff`. Avec plusieurs comptes, `--account` ou `ff config set account <ID>` dit lequel. Un script ou une CI utilise une clé d'API, qu'un propriétaire du compte crée avec les droits qu'il lui faut ; elle n'est affichée qu'une fois, et va dans `FF_TOKEN`. Un script lit `--output json` et les codes de sortie : 4, un déploiement qui n'a pas démarré ; 5, un appel qui a échoué ; 6, un refus du compte (le crédit, les droits de la clé, le débit de l'offre).

## Toute l'application sur votre machine

```bash
ff local start template.yaml --watch                  # chaque fonction, puis son journal au fil de l'eau
curl http://commandes.fn.localhost:3700/articles?id=7  # l'adresse d'une fonction, ici
ff local run Nightly                                  # une planification lancée tout de suite
ff local start template.yaml --with postgres,valkey   # DATABASE_URL et REDIS_URL pour chaque fonction
ff local mail                                         # le courrier gardé, jamais envoyé
ff local reset --yes                                  # ce que ff local a gardé, effacé
ff local konnect                                      # un remplaçant de Konnect, rien n'est payé
```

Il faut Docker, et pas de compte : rien ne quitte votre machine, pas même le courrier. Chaque fonction tourne dans l'image que FF utilise, et une seule porte d'entrée, sur un port, répond comme Lambda, SQS, S3 et SES v2 répondent sur FF, avec les mêmes vérifications et les mêmes refus, dans les mêmes mots : les SDK et la CLI d'AWS s'en servent tels quels. Les secrets viennent de `.env.local`, jamais du modèle. Ce que seul FF fait : HTTPS et vos domaines, les versions et les alias, les instances ajoutées à la demande, l'historique et les traces, les métriques et les alarmes, l'offre, son crédit et sa facture. Le guide en anglais en donne le tableau complet : [The whole app on your laptop](../getting-started.md#the-whole-app-on-your-laptop-ff-local).

## Partir d'un modèle

```bash
ff init --list                                       # les modèles, et ce que chacun fait
ff init travaux --template queue-worker --runtime python
```

| Modèle | Ce qu'il fait |
|---|---|
| `function` | Le dossier d'une fonction : son code, un événement pour l'appeler et un README (le modèle par défaut) |
| `terraform` | Le projet Terraform d'une application, qu'OpenTofu et Terraform appliquent sur FF et chez AWS |
| `sam` | Le « hello world » de `sam init`, tel que FF le prend |
| `rest-api` | Une API REST à l'adresse d'une fonction, ses données dans PostgreSQL |
| `cron-job` | Une tâche chaque matin, qui rend compte de ce que son compartiment a reçu la veille |
| `queue-worker` | Une adresse qui prend des tâches dans une file, une fonction qui les lit par lots |
| `site-with-api` | Une page sur le site d'un compartiment, son API à l'adresse d'une fonction, un livre d'or |
| `image-resize` | Une image déposée dans un compartiment donne sa miniature WebP à côté d'elle |
| `webhook` | Des commandes payées par Konnect, ses notifications reçues comme il faut |

Les sept derniers sont des applications : chaque dossier a un `template.yaml` de SAM, le code dans `src/`, ses tests dans `tests/`, qui tournent sans rien d'autre, et un README en trois parties, « Here », « On FF » et « On AWS » : le même dossier tourne sur votre machine avec `ff local start`, sur FF avec `ff deploy`, et chez AWS avec `sam deploy`, sans changer son code.

## Depuis votre agent de code IA

```bash
claude mcp add ff -- ff mcp                 # Claude Code : les outils qui lisent
claude mcp add ff -- ff mcp --allow-write   # et ceux qui changent le compte
```

Cursor lit `.cursor/mcp.json` et VS Code `.vscode/mcp.json`, avec la même commande, `ff mcp`. L'agent lit les fonctions, leurs journaux, leurs appels, leurs traces et leurs métriques, l'usage et le solde ; avec `--allow-write`, il déploie, appelle, règle les variables d'environnement, publie une version, règle un alias, envoie un message dans une file et déploie un site. Jamais : supprimer, créer une clé, poser un secret ou se connecter, qui restent les commandes d'une personne. Le guide en anglais : [FF from your AI coding agent](../getting-started.md#ff-from-your-ai-coding-agent-ff-mcp).

## Dans votre CI

[`examples/ci/`](../../examples/ci/) a un job pour GitHub Actions et un pour GitLab CI, que le site de téléchargement sert aussi sous `ci/` : chacun installe `ff`, vérifié, puis déploie le `template.yaml` du dépôt à chaque push sur sa branche principale.

```bash
ff api-keys create --name github --expires 90d --scopes stacks:read,stacks:write,functions:read,functions:write
gh secret set FF_TOKEN                                  # dans le dépôt de l'application : demande la clé
gh variable set FF_ENDPOINT --body https://api.<domaine>
gh variable set FF_DOWNLOADS_URL --body https://get.<domaine>
```

Le job échoue avec le code de sortie de `ff` et son message : un 6, un refus du compte, se lit comme tel, et non comme une faute de l'application. Un modèle avec des compartiments ou des files demande aussi `storage:read` et `storage:write`, ou `queues:read` et `queues:write`.

## Suivre une requête

```bash
ff history commandes-api                              # chaque appel avec sa trace, dans la colonne TRACE
ff trace 1-6912b0a3-5f1e2d3c4b5a69788796a5b4          # les appels de la trace, en frise
ff logs --trace 1-6912b0a3-5f1e2d3c4b5a69788796a5b4   # leurs journaux, d'une fonction à l'autre
```

Chaque appel appartient à une trace, comme AWS X-Ray la nomme : celle que nomme l'en-tête `X-Amzn-Trace-Id` de l'appelant, sinon une nouvelle. Les tentatives d'un appel sans attente, sa destination et le lot d'une file qui en lit le message restent dans la même trace. Dans la console, un appel de l'historique d'une fonction a un lien « Trace » vers la page de la trace. **Une fonction qui appelle SQS ou Lambda** y fait entrer son appel en envoyant sa trace, `_X_AMZN_TRACE_ID`, dans `X-Amzn-Trace-Id` : les SDK d'AWS le font d'eux-mêmes sur AWS Lambda, pas sur FF, où deux lignes suffisent, que le modèle `queue-worker` contient, un middleware du client en Node.js et un crochet de botocore en Python. FF n'a pas X-Ray lui-même : ni segments, ni carte des services. Le guide en anglais : [Following one request](../getting-started.md#following-one-request-ff-trace).

## Savoir si c'est FF

La page d'état, `https://status.dev.ffunc.cloud` pour le serveur de développement de FF, montre chaque partie de FF telle que vous la rencontrez : l'API, la console, la connexion, les adresses de Lambda, S3, SQS et SES, celles des fonctions et les sites, vérifiées chaque minute depuis le serveur lui-même, avec leurs 90 derniers jours et les incidents.
