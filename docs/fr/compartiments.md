# Fichiers dans des compartiments (buckets)

FF donne à chaque compte des compartiments pour ses fichiers, **comme AWS S3** : les SDK et la CLI d'AWS s'en servent tels quels, seule l'adresse du service change, et un compartiment passe vers S3 avec `aws s3 sync`, sans rien de FF entre les deux ([ADR 0009](../adr/0009-buckets.md), en anglais).

## Ce que c'est

| | FF | AWS S3 |
|---|---|---|
| API | Celle de S3, signée avec AWS Signature Version 4 : envoyer, lire, copier, lister et supprimer des fichiers, l'envoi en plusieurs parties, les URL présignées (7 jours au plus) ; le reste répond `NotImplemented` | L'API de S3 entière |
| Outils | Les SDK et la CLI d'AWS, l'adresse de FF dans `AWS_ENDPOINT_URL_S3` | Les mêmes |
| Noms | Les règles d'AWS, sans point : de 3 à 63 minuscules, chiffres et tirets, uniques dans tout FF ; dans le stockage, un nom de FF, `ff-` et 24 caractères, qui ne dit rien du compte | Uniques dans tout AWS |
| Région | `tn-tunis-1` | La vôtre |
| Clés d'accès | Deux par compte, comme IAM en donne deux à un utilisateur : un identifiant `AKFF…` et un secret montré une seule fois ; tous les compartiments du compte ou ceux qu'elle nomme, en lecture et écriture ou en lecture seule | Celles d'IAM, et ses politiques |
| Depuis vos fonctions | Sans réglage : chaque fonction a sa propre clé dans son environnement | Le rôle de la fonction |
| Versions des fichiers | Non : un fichier supprimé ou remplacé l'est pour de bon | Au choix |
| Limites | Celles de l'offre : sur la bêta, 5 compartiments, 5 Go à eux tous, 100 requêtes par seconde, 5 Go par envoi simple (un envoi en plusieurs parties va au-delà) | Pas de limite de stockage |
| Facturation | Comme S3 Standard : le stockage au Go-mois, les requêtes selon les deux classes de S3, aux prix de S3 en dinars ; offerts chaque mois, 5 Go-mois, 2 000 requêtes PUT et 20 000 GET ; les suppressions sont gratuites. Les octets envoyés sont comptés, pas facturés | Le stockage, les requêtes, et les données envoyées vers Internet au-delà de 100 Go par mois |
| Copie ailleurs | Aucune sur un second site : la redondance du stockage les garde | Plusieurs zones de disponibilité |

## Créer un compartiment et une clé

Dans la console, la page « Buckets » ; ou avec l'outil `ff` :

```bash
ff buckets create photos
eval "$(ff buckets keys create --bucket photos | grep '^export ')"
aws s3 cp ./chat.jpg s3://photos/2026/chat.jpg
```

`ff buckets keys create` n'affiche le secret de la clé qu'à ce moment-là, sous la forme des quatre variables que lisent les outils d'AWS : `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` et `AWS_ENDPOINT_URL_S3`, l'adresse de FF. Avec elles, la CLI et les SDK d'AWS n'ont besoin d'aucune autre option. Seuls les propriétaires du compte voient, créent et révoquent les clés ; une clé révoquée est refusée aussitôt : `ff buckets keys revoke AKFF…`.

## Depuis une fonction

Rien à régler : à son premier déploiement, une fonction reçoit sa propre clé, qui atteint tous les compartiments du compte, avec la région et l'adresse de FF dans son environnement. `new S3Client({})` en Node.js (`@aws-sdk/client-s3` dans le paquet de la fonction) et `boto3.client("s3")` en Python marchent tels quels, comme sur AWS Lambda avec un rôle. La clé est révoquée quand la fonction est supprimée.

## Sa vie

- **Ce qu'il contient :** `ff buckets get photos`, ou sa page dans la console : ce qu'il contenait à sa dernière mesure et ses fichiers, ses adresses, ses dernières heures. FF mesure chaque compartiment toutes les heures.
- **Au-delà du stockage de l'offre :** les compartiments du compte comptent ensemble. Ses propriétaires reçoivent un e-mail à 80 % et à 100 % ; à 100 %, les envois sont refusés (`AccountProblem`) jusqu'à ce que les compartiments contiennent moins. La lecture et la suppression continuent, et les envois reprennent dans la minute qui suit une suppression.
- **Sans crédit :** les envois attendent du crédit ; la lecture et la suppression continuent. FF ne supprime jamais de données pour un impayé.
- **Métriques et alarmes :** comme CloudWatch pour S3 : `BucketSizeBytes` et `NumberOfObjects`, les requêtes, les erreurs 4xx et 5xx, les octets envoyés et reçus.
- **Le mois :** `ff usage`, ou la page « Usage » de la console : ses Go-mois, ses requêtes par classe, ce qu'il a envoyé, son coût estimé.
- **Compte suspendu :** ses clés sont refusées, ses fichiers restent. **Compte fermé :** ses compartiments sont vidés et supprimés avec ses autres données, à la date de suppression annoncée.
- **Supprimer un compartiment :** `ff buckets delete photos`, après confirmation. Un compartiment qui contient des fichiers n'est supprimé qu'avec `--force`, qui supprime d'abord ses fichiers ; son nom est libre aussitôt.

## Pas de copie sur un second site

FF ne garde aucune copie de vos compartiments ailleurs : la redondance du stockage les protège d'un disque en panne, comme celle de S3, mais pas d'une suppression par erreur, ni de la perte du site. Pour les fichiers importants, gardez-en une copie à vous, par exemple `aws s3 sync s3://photos ./photos` avec une clé du compte, ou la première moitié du script ci-dessous.

## Partir vers AWS S3

`aws s3 sync` de FF vers un dossier, puis du dossier vers un compartiment S3 : le script [`cli/templates/export/data/s3-sync.sh`](../../cli/templates/export/data/s3-sync.sh), que `ff export` mettra dans son kit de sortie, fait les deux, avec une clé de FF pour la première moitié et vos identifiants AWS pour la seconde. Relancé, il ne copie que ce qui a changé ; avec `--delete-gone`, ce qui a disparu de FF disparaît aussi du dossier et de S3. Le code pointe alors vers S3 (sur AWS Lambda, un rôle et aucune adresse), et le compartiment se supprime sur FF.
