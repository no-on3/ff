# Sites statiques

FF publie le site que construit votre frontend (`index.html`, ses fichiers, ses images) depuis un compartiment, **comme S3 et CloudFront** : la configuration de site web d'S3, en HTTPS, à une adresse de FF ou à vos propres domaines. Un site passe vers S3 et CloudFront avec la CLI d'AWS, sans rien de FF entre les deux ([ADR 0011](../adr/0011-static-sites.md), en anglais).

## Ce que c'est

| | FF | AWS |
|---|---|---|
| Un site | Un compartiment avec la configuration de site web d'S3 : son document d'index (`index.html`), son document d'erreur (`404.html`) | La même, sur S3, avec CloudFront devant pour le HTTPS et les domaines |
| Son adresse | `https://<compartiment>.site.ffunc.cloud/` | Celle de CloudFront, `d….cloudfront.net` |
| Vos domaines | Prouvés par un CNAME vers l'adresse du site, leur certificat fait à la demande ; ils comptent avec ceux des URL de fonctions | Les noms de domaine de la distribution, et un certificat d'ACM |
| Applications d'une seule page | Un réglage du site : un chemin sans fichier répond `index.html` avec 200 | Les réponses d'erreur personnalisées de CloudFront |
| Publier | `ff sites deploy`, ou `aws s3 sync` comme vers tout compartiment | `aws s3 sync` |
| Public | Le site seul, en lecture ; l'API S3 du compartiment reste signée | Une politique de compartiment, ou CloudFront seul |
| Limites | Celles de l'offre : sur la bêta, 10 Go envoyés par mois par les sites du compte ensemble, puis ils répondent 403 jusqu'à la fin du mois | Pas de limite |
| Facturation | Comme le compartiment : son stockage, chaque visite comme une requête GET ; les octets envoyés sont comptés, pas facturés | Le stockage d'S3, les requêtes et les données envoyées par CloudFront |

## Publier un site

Le dossier que construit votre frontend, par exemple `./dist` :

```bash
ff buckets create boutique
ff sites deploy boutique ./dist --spa
# ./dist deployed to boutique, made a site: 14 files uploaded, 0 files unchanged, 0 files deleted
# https://boutique.site.ffunc.cloud
```

`ff sites deploy` envoie les fichiers dont le contenu a changé, ceux des pages en dernier, supprime ceux que le dossier n'a plus (sauf avec `--keep`), et fait du compartiment un site s'il n'en est pas un. Chaque fichier est typé d'après son nom ; les fichiers dont le nom porte une empreinte, comme Vite les nomme, sont gardés un an par les navigateurs, les autres revérifiés à chaque visite. `--spa` est pour une application d'une seule page : ses routes répondent `index.html`. Il lui faut une clé d'API avec `storage:write`, ou la session d'un propriétaire ou d'un développeur.

Dans la console, la page d'un compartiment a le panneau de son site : son adresse, ses réglages, la commande pour publier, ses visites du dernier jour, ses domaines.

## Vos domaines

```bash
ff sites domains add boutique www.boutique.tn
# CNAME www.boutique.tn boutique.site.ffunc.cloud
# then: ff sites domains verify boutique www.boutique.tn
```

Une fois le CNAME publié, `ff sites domains verify` le vérifie ; le site répond alors à ce domaine comme à son adresse, avec son propre certificat.

## Sa vie

- **Métriques et alarmes :** comme CloudWatch pour une distribution CloudFront : `Requests`, `BytesDownloaded`, et les parts des visites en erreur, `4xxErrorRate`, `5xxErrorRate` et `TotalErrorRate` ; `ff sites metrics boutique`.
- **Le mois :** ses visites comptent parmi les requêtes du compartiment, dans `ff usage` et la page « Usage » de la console.
- **Sans crédit :** le site répond toujours. **Compte suspendu :** il répond 403. **Compte fermé :** ses fichiers sont supprimés avec ses autres données, à la date de suppression annoncée.
- **Ne plus en faire un site :** `ff sites remove boutique` ; l'adresse ne répond plus, les fichiers restent, privés.

## Partir vers S3 et CloudFront

Le kit de sortie a sa page, [`cli/templates/export/data/s3-website.md`](../../cli/templates/export/data/s3-website.md) : un modèle CloudFormation avec le compartiment, la distribution, l'index d'un dossier et les réponses d'erreur ; l'envoi du dossier avec les mêmes en-têtes de cache ; puis vos domaines, déplacés un par un.
