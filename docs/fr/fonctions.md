# Fonctions, comme AWS Lambda

Les fonctions de FF sont **celles d'AWS Lambda** : le même handler, `handler(event, context)`, les mêmes événements, les mêmes versions et alias, et l'API de Lambda elle-même, signée avec AWS Signature Version 4. La CLI d'AWS, ses SDK et le fournisseur AWS de Terraform créent, changent et appellent les fonctions de FF comme celles de Lambda, seule l'adresse du service changeant ; `ff deploy` déploie un modèle AWS SAM. Partir vers AWS change des réglages, pas le code ([ADR 0014](../adr/0014-lambda-api.md), [ADR 0015](../adr/0015-versions-and-aliases.md) et [ADR 0016](../adr/0016-sam-templates.md), en anglais).

## Ce que c'est

| | FF | AWS |
|---|---|---|
| Le code | Un fichier en ligne, jusqu'à 3 Mio, ou un zip comme Lambda le prend : 50 Mo, 250 Mo et 20 000 fichiers décompressé | Les mêmes, plus les images de conteneur et les couches |
| Les runtimes | Node.js 24 (`nodejs24.x`) et Python 3.13 (`python3.13`) | Ceux-ci et d'autres |
| Mémoire et délai | Ceux de l'offre : sur la bêta, 25 fonctions, chacune de 128 à 1 024 Mo et de 1 à 300 s | De 128 à 10 240 Mo, 900 s |
| La montée en charge | Une instance par appel en cours, jusqu'à `maxInstances` (3 par défaut, 10 au plus sur la bêta) ; `minInstances` gardées chaudes | La concurrence réservée et la concurrence provisionnée |
| Versions et alias | Ceux de Lambda : une version publiée ne change plus, un alias en nomme une et peut donner une part de ses appels à une seconde | Les mêmes |
| L'API | Celle de Lambda : ses 41 opérations qu'appellent les outils d'AWS ; les 47 autres refusées, en le disant | Toutes |
| Une adresse web | Comme les URL de fonction : à tout le monde, ou aux requêtes signées par une clé du compte (l'`AWS_IAM` de Lambda), son CORS, vos domaines | Les mêmes, les domaines derrière CloudFront |
| Planifications | Les expressions d'EventBridge, en UTC | EventBridge et EventBridge Scheduler |
| Facturation | Comme Lambda, en dinars : les requêtes et les GB-secondes, avec la même offre gratuite, un million de requêtes et 400 000 GB-s par compte et par mois ; les instances gardées chaudes comme la concurrence provisionnée | La même, en dollars |

## Une fonction

```bash
ff deploy bonjour.ts                               # la fonction bonjour, en Node.js ; 128 Mo et 5 s sauf avis contraire
ff invoke bonjour --data '{"nom": "Ada"}'
ff logs bonjour --follow
ff url enable bonjour --auth none                  # son adresse web, à tout le monde
ff schedule set bonjour 'rate(5 minutes)'          # appelée toutes les cinq minutes
```

Un dossier se déploie comme un paquet avec ses bibliothèques, son runtime lu dans `package.json`, `requirements.txt` ou `pyproject.toml`. `ff deploy` revient quand la nouvelle version tourne ; un code qui ne se charge pas laisse la précédente en service. Les variables d'environnement (`ff env set`) sont lisibles comme le code, comme sur Lambda ; les secrets (`ff secrets set`) ne se relisent jamais, ni dans la console ni par l'API. Dans la console, la page d'une fonction : ses réglages, ses appels, ses journaux, ses métriques, ses versions et ses alias.

## Avec les outils d'AWS

```bash
eval "$(ff keys create --name deployeur --function '*' --function-access write | grep '^export ')"
aws lambda create-function --function-name bonjour --runtime nodejs24.x --handler index.handler \
  --role arn:aws:iam::123456789012:role/bonjour --zip-file fileb://bonjour.zip   # State: Pending ; le rôle gardé, sans effet
aws lambda wait function-active-v2 --function-name bonjour
aws lambda invoke --function-name bonjour --cli-binary-format raw-in-base64-out --payload '{"nom": "Ada"}' \
  --log-type Tail --query LogResult --output text reponse.json | base64 -d          # le journal de l'appel ; sa réponse dans reponse.json
```

`ff keys create` affiche les sept variables que lisent la CLI d'AWS v2, le SDK pour JavaScript v3 et boto3 : la clé, `AWS_REGION` et les adresses de Lambda, S3, SQS et SES (`AWS_ENDPOINT_URL_LAMBDA` parmi elles). Une clé atteint les fonctions qu'elle nomme, à un niveau : `read` les liste et les lit, `invoke` les appelle aussi, `write` fait tout. Un profil de `~/.aws/config` garde les adresses de FF au même endroit, dans sa section `services` ; chez AWS, le même profil sans sa ligne `services` :

```ini
# ~/.aws/config ; la clé dans ~/.aws/credentials, sous [ff]
[profile ff]
region   = tn-tunis-1
services = ff-endpoints

[services ff-endpoints]
lambda =
  endpoint_url = http://localhost:3006
s3 =
  endpoint_url = http://s3.localhost:3002
sqs =
  endpoint_url = http://localhost:3003
sesv2 =
  endpoint_url = http://localhost:3005
```

Puis `AWS_PROFILE=ff aws lambda list-functions`. En production, les adresses sont `https://lambda.<domaine>` et les autres, comme les donne la page « Account » de la console. **Depuis une fonction, rien à régler :** FF donne à chacune les quatre adresses dans ses variables, avec une clé à elle ; `new LambdaClient({})` en Node.js et `boto3.client("lambda")` en Python marchent tels quels, comme sur AWS Lambda avec un rôle. Par l'API de Lambda, cette clé appelle les fonctions du compte, et rien d'autre.

## Versions et alias

```bash
ff publish bonjour --description 'Première version'   # la version 1, figée
ff alias set bonjour live 1                           # l'alias live nomme la version 1
ff deploy bonjour.ts --publish                        # le nouveau code, publié : la version 2
ff alias set bonjour live 1 --also 2 10%              # un dixième des appels de live vers la version 2
ff alias set bonjour live 2                           # puis tous ; revenir en arrière, c'est nommer la version d'avant
ff invoke bonjour:live
```

Avec la CLI d'AWS, la même chose : `aws lambda publish-version`, puis `aws lambda update-alias … --routing-config '{"AdditionalVersionWeights": {"2": 0.1}}'`. Une version tourne comme elle a été publiée, dans ses propres instances, et ne garde rien quand personne ne l'appelle. L'adresse web d'une fonction, ses planifications, les files qu'elle lit et les notifications d'un compartiment peuvent passer par un alias, et un alias peut avoir sa propre adresse. L'historique et les métriques disent ce qui a tourné à chaque appel.

## Un modèle SAM, ou Terraform

```bash
ff init boutique --template sam --runtime nodejs   # le « hello world » de sam init, tel que FF le prend
cd boutique
ff deploy template.yaml                            # la pile que nomme samconfig.toml : la fonction, son adresse, ses sorties
ff delete-stack boutique --yes                     # la pile et ce qu'elle a créé, comme sam delete
```

`ff deploy` lit un sous-ensemble de SAM, FF n'ayant pas CloudFormation : les fonctions et leurs événements (planifications, files, routes HTTP, fichiers d'un compartiment), les files de SQS, les compartiments de S3 et les sorties ; `ff doctor template.yaml` nomme ce qui en sort. La page [SAM templates on FF](../sam-templates.md) (en anglais) en donne la liste. **Terraform :** `ff init boutique --template terraform` écrit un projet qu'OpenTofu et Terraform appliquent sur FF avec le fournisseur AWS, et chez AWS une fois son bloc `provider` changé.

## Sa vie

- **Journaux et métriques :** `ff logs`, et `ff metrics`, sous les noms de CloudWatch : les appels, les erreurs, les refus, les démarrages à froid, la durée ; des alarmes comme celles de CloudWatch.
- **Le mois :** `ff usage`, ou la page « Usage » de la console : les requêtes et les GB-secondes de chaque fonction, et son coût. `ff usage --aws` donne les trois derniers mois aux prix d'AWS, une estimation.
- **Sans crédit :** les appels continuent jusqu'à une marge de 1 dinar sous zéro, puis pendant un délai de grâce de 24 heures ; ensuite ils sont refusés : l'API de FF répond `402 InsufficientCreditException`, celle de Lambda `429 TooManyRequestsException`, en disant que le crédit est épuisé, et ils reprennent dès que du crédit arrive. AWS, lui, facture.
- **Supprimer une fonction :** `ff delete bonjour`, après confirmation, avec son historique, ses journaux, ses versions et ses alias.

## Ce qui diffère

1. **La région, les adresses et les numéros de compte sont ceux de FF :** `tn-tunis-1`, dans chaque ARN. Ce sont des réglages : un code qui lit sa région dans `AWS_REGION`, que Lambda pose aussi, part tel quel ; un ARN écrit en dur dans le code doit changer.
2. **Pas d'IAM.** Le rôle d'une fonction et les permissions de Lambda sont gardés, sans effet : les clés de FF décident qui atteint quoi, chacune nommant ses fonctions, ses compartiments et ses files, comme une politique les nomme. `ff export` écrit le rôle de chaque fonction d'après ce que ses clés ont utilisé.
3. **Sans crédit, un refus**, là où AWS facture (ci-dessus).
4. **Ce que FF n'offre pas :** SnapStart, un VPC, X-Ray, la signature du code, les couches, les images de conteneur, les systèmes de fichiers, les clés KMS, Lambda@Edge. L'API de Lambda refuse chacun en disant pourquoi, sauf s'il vient avec sa valeur par défaut, comme les outils d'AWS l'envoient.
5. **47 opérations de Lambda pas encore offertes :** chacune répond `UnknownOperationException`, la nommant, et dit ce que FF offre à la place quand il le fait.
6. **Le nom d'un compartiment est unique dans tout FF,** comme sur S3, et sans point. L'export fait de chaque nom un paramètre, le nom pouvant être pris chez AWS.
7. **Les secrets sont à FF :** Lambda n'a que des variables. L'export fait de chaque secret un paramètre que CloudFormation ne réaffiche pas (`NoEcho`), à remplir dans `secrets.template.env`.
8. **Les ajouts d'AWS de 2025 et 2026** (Lambda Managed Instances, l'isolation par locataire, les fonctions durables) sont suivis et décidés un par un ; aucun n'est offert, et un champ que FF ne prend pas, comme `TenancyConfig`, est refusé plutôt qu'ignoré.

## Partir vers AWS

`ff export` écrit le compte en modèle SAM et en projet Terraform, avec le code de chaque fonction, son rôle, le déroulé du départ et l'estimation ; `ff doctor` nomme avant le départ ce qui marche sur FF et pas sur Lambda. [Partir vers AWS](partir-vers-aws.md) dit le reste. La documentation de référence, en anglais : [The way out](../getting-started.md#the-way-out) et [Functions through Lambda's API](../getting-started.md#functions-through-lambdas-api).
