# Bases de données PostgreSQL

FF donne à chaque compte des bases de données PostgreSQL, **comme AWS RDS** donne des instances : les fonctions du compte y gardent leurs données, et une base passe vers RDS avec les outils de PostgreSQL, sans rien de FF entre les deux ([ADR 0008](../adr/0008-customer-databases.md), en anglais).

## Ce que c'est

| | FF | AWS RDS pour PostgreSQL |
|---|---|---|
| Moteur | PostgreSQL 18, jamais plus récent que RDS | PostgreSQL 18 et les précédents |
| Une base | Une base et son utilisateur, propriétaire de la base, sur un serveur à part de celui de FF | Une instance, et ses bases |
| Noms | Le vôtre dans le compte (`commandes`), et sur le serveur un nom opaque, `ff_` et 24 caractères hexadécimaux | Le vôtre |
| Connexion | TLS seulement : `postgresql://…?sslmode=require` | TLS au choix |
| Depuis vos fonctions | Toujours, quel que soit l'accès à Internet du compte | Dans le même VPC |
| Depuis votre poste | Oui, en TLS, comme l'option « publicly accessible » de RDS | Selon l'option |
| Mot de passe | 32 octets aléatoires, montrés une seule fois ; FF n'en garde aucune copie | Le vôtre, ou Secrets Manager |
| Limites | Celles de l'offre : sur la bêta, une base, 1 024 Mo de stockage, 10 sessions à la fois | Celles de l'instance |
| Facturation | Le stockage au Go-mois, au prix de RDS (gp3), 1 Go-mois offert chaque mois | Le stockage, et les heures d'instance |
| Sauvegardes | Restauration à un instant donné, 7 jours, sur un second site | Sauvegardes automatiques, 7 jours par défaut |

## Créer une base

Dans la console, la page « Databases » ; ou avec l'outil `ff` :

```bash
ff db create commandes --secret-for commandes-api
# commandes made: its connection string, shown this once (…)
# postgresql://ff_3f9c…:Xq3v…@db.ffunc.tn:5432/ff_3f9c…?sslmode=require
# DATABASE_URL set on commandes-api
```

La chaîne de connexion, avec son mot de passe, n'est montrée qu'à ce moment-là. `--secret-for` la donne aussi à une fonction, comme secret `DATABASE_URL`, que la fonction lit dans son environnement comme une application écrite pour Lambda et RDS lit le sien. Un mot de passe perdu se remplace : `ff db password commandes`, montré une fois lui aussi ; l'ancien n'ouvre plus de session.

## S'y connecter

- **Depuis une fonction :** avec node-postgres, `new Pool({ connectionString: process.env.DATABASE_URL })`. node-postgres vérifie le certificat du serveur ; FF fournit aux fonctions ce qu'il faut pour cela.
- **Depuis votre poste :** `psql "<la chaîne>"`. psql chiffre la connexion ; pour vérifier aussi le certificat, ajoutez `&sslmode=verify-full` et l'autorité de certification du serveur.

## Sa vie

- **Ce qu'elle occupe :** `ff db get commandes`, ou sa page dans la console : son état, sa taille et ses sessions, et ses dernières heures. FF la mesure toutes les heures.
- **Au-delà du stockage de l'offre :** les propriétaires du compte reçoivent un e-mail à 80 % et à 100 %. Au-delà de 100 %, ses nouvelles sessions démarrent en lecture seule : une écriture est refusée (SQLSTATE 25006) jusqu'à ce que la base repasse en dessous. Une session peut lever la lecture seule pour elle-même, `SET default_transaction_read_only = off`, et supprimer ce dont vous n'avez plus besoin. C'est un signal, pas un mur : le stockage au-delà de l'offre est facturé.
- **Alarmes :** sur ses sessions (`DatabaseConnections`) ou son stockage (`VolumeBytesUsed`), heure par heure, comme CloudWatch pour RDS.
- **Compte suspendu :** son utilisateur ne peut plus se connecter, ses données restent. **Compte fermé :** ses bases sont supprimées avec ses autres données, à la date de suppression annoncée.
- **Supprimer une base :** `ff db delete commandes`, après confirmation ; ses données partent avec elle.
- **Revenir à un instant donné :** écrivez à FF depuis l'adresse d'un propriétaire du compte, avec le nom de la base et l'instant, en UTC, dans les 7 derniers jours. Elle revient dans une nouvelle base du compte, comme RDS restaure dans une nouvelle instance ; l'ancienne reste jusqu'à ce que vous la supprimiez.

## Partir vers AWS RDS

`pg_dump` depuis FF, puis `pg_restore` dans une instance RDS PostgreSQL 18 : les étapes, en anglais, sont dans [`cli/templates/export/data/postgres.md`](../../cli/templates/export/data/postgres.md), que `ff export` mettra dans son kit de sortie.
