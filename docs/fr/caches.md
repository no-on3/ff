# Des caches

FF donne à chaque compte des caches Valkey, **comme Amazon ElastiCache** : un serveur Valkey à lui pour chaque cache, en TLS, avec un mot de passe, que joignent les clients Redis et Valkey tels quels ([ADR 0013](../adr/0013-caches.md), en anglais). Un cache passe vers ElastiCache en changeant son adresse, rien d'autre.

## Ce que c'est

| | FF | Amazon ElastiCache |
|---|---|---|
| Moteur | Valkey 9.1, un processus pour chaque cache | Valkey ou Redis OSS |
| Adresse | `rediss://default:<mot de passe>@<hôte>:<port>`, montrée une seule fois : FF n'en garde pas de copie | Celle du cluster, dans son VPC |
| Mémoire | Celle de l'offre : sur la bêta, un cache de 64 Mo ; au-delà, les clés les moins récemment utilisées s'en vont | Celle du type de nœud |
| Sur disque | Rien : un cache redémarré repart vide | Des instantanés, au choix |
| Depuis vos fonctions | Quel que soit leur accès à Internet, et depuis votre machine | De l'intérieur du VPC |
| Commandes | Toutes, sauf celles qui changeraient le serveur (`CONFIG`, `DEBUG`, `MODULE`, `ACL`, `SAVE`, `SHUTDOWN`, `REPLICAOF`…) | Presque les mêmes |
| Facturation | Comme un nœud d'ElastiCache : sa mémoire par Go-heure, au prix d'ElastiCache pour Valkey en dinars ; pas de palier gratuit | Le nœud à l'heure |

## Créer un cache

```bash
ff caches create sessions --secret-for orders-api
# sessions made: its address, shown this once (FF keeps no copy; `ff caches password sessions` makes a new one):
# rediss://default:Hq7v…@cache.ffunc.cloud:6400
# REDIS_URL set on orders-api
```

`--secret-for` met l'adresse dans les secrets des fonctions nommées, sous le nom `REDIS_URL` (ou celui que donne `--secret-name`), comme `ff db create` pour une base. La console a la page « Caches », qui fait de même. `ff caches password sessions` donne un nouveau mot de passe, montré une seule fois aussi ; les connexions en cours gardent le leur.

## Depuis une fonction

Son secret est dans son environnement : `createClient({ url: process.env.REDIS_URL })` avec le paquet `redis` en Node.js, `redis.from_url(os.environ["REDIS_URL"])` en Python. En production, le certificat du serveur vient d'une autorité publique, que les clients vérifient d'eux-mêmes ; en développement, les fonctions reçoivent l'autorité du serveur avec celle des bases de données, et Node.js la lit par `NODE_EXTRA_CA_CERTS`.

## Sa vie

- **Ce qu'il est :** `ff caches get sessions`, ou la page « Caches » : la mémoire qu'utilisent ses clés, ses connexions, ses lectures du dernier jour.
- **Métriques et alarmes :** comme CloudWatch pour ElastiCache : `BytesUsedForCache`, `CurrConnections`, `CacheHits`, `CacheMisses` et `Evictions`, un point par heure.
- **Le mois :** `ff usage`, ou la page « Usage » : ses heures, ses Go-heures, son coût estimé.
- **Sans crédit :** le cache continue. **Compte suspendu :** son utilisateur est refusé et ses connexions coupées, ses clés gardées. **Compte fermé :** ses caches sont supprimés avec ses autres données, à la date de suppression annoncée.
- **Supprimer un cache :** `ff caches delete sessions`, après confirmation, avec ses clés.

## Partir vers ElastiCache

Le kit de sortie a sa page, [`cli/templates/export/data/elasticache.md`](../../cli/templates/export/data/elasticache.md) : un cache ElastiCache pour Valkey en TLS, avec un jeton d'authentification et les mêmes règles de mémoire ; son adresse dans l'environnement des fonctions sur AWS Lambda. Ses clés ne sont pas copiées : c'est un cache, que votre application remplit de nouveau.
