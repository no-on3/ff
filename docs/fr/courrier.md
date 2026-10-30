# Le courrier de vos applications

FF envoie les e-mails de vos applications (reçus, confirmations, réinitialisations de mot de passe), **comme Amazon SES** : l'API de SES v2, que les SDK et la CLI d'AWS appellent tels quels, seule l'adresse du service change. Vos domaines sont prouvés par leurs enregistrements DNS, et chaque message est signé avec la clé DKIM du domaine ([ADR 0012](../adr/0012-customer-mail.md), en anglais).

## Ce que c'est

| | FF | Amazon SES |
|---|---|---|
| API | Celle de SES v2, signée avec AWS Signature Version 4 : les identités, `SendEmail` (simple ou brut), `GetAccount`, la liste de suppression ; le reste répond `NotImplemented` | L'API de SES v2 entière, et SMTP |
| Outils | Les SDK et la CLI d'AWS, l'adresse de FF dans `AWS_ENDPOINT_URL_SESV2` | Les mêmes, sans adresse |
| Expéditeurs | Vos domaines, prouvés par la clé DKIM que FF leur fait ; ou des adresses, prouvées par un lien | Les mêmes, avec les clés de SES |
| Le bac à sable | Un nouveau compte n'envoie qu'aux adresses et domaines qu'il a prouvés, jusqu'à ce que l'opérateur de FF l'en sorte | Le même, levé par AWS sur demande |
| Quotas | Ceux de l'offre : sur la bêta, 2 domaines, 200 destinataires par jour et 1 par seconde ; 50 destinataires et 10 Mo par message | Ceux du compte, relevés par AWS sur demande |
| Retours | Un rejet définitif ou une plainte met l'adresse sur la liste de suppression du compte | Le même |
| Réputation | Sur 14 jours : au-delà de 5 % de rejets définitifs ou de 0,1 % de plaintes, le compte est examiné ; au-delà de 10 % ou de 0,5 %, ses envois s'arrêtent | Les mêmes taux |
| Facturation | Comme SES : 0,10 US$ pour 1 000 destinataires et 0,12 US$ par Go de pièces jointes, en dinars au taux du barème ; pas de palier gratuit | Les mêmes prix, en dollars |

**Le port 25 est fermé à toutes les fonctions,** quel que soit leur accès à Internet, comme sur AWS : le courrier passe par FF, avec ses quotas. Les ports 465 et 587 restent ouverts, vers un service d'envoi à vous.

## Prouver un domaine

```bash
ff email add boutique.tn
```

`ff email add` affiche les enregistrements à publier dans le DNS du domaine : le TXT de sa clé DKIM, qui le prouve ; le MX et le SPF de son adresse de retour, `bounces.mail.boutique.tn`, qui ramènent les rejets ; et un DMARC, conseillé. FF les cherche chaque minute pendant 72 heures ; `ff email verify boutique.tn` les cherche aussitôt. Dans la console, la page « E-mail » les montre, chacun avec son rôle.

## Envoyer

Depuis une fonction, rien à régler : son environnement a déjà sa clé, la région et `AWS_ENDPOINT_URL_SESV2`. `new SESv2Client({})` en Node.js (`@aws-sdk/client-sesv2` dans le paquet de la fonction) et `boto3.client("sesv2")` en Python marchent tels quels :

```js
await new SESv2Client({}).send(new SendEmailCommand({
  FromEmailAddress: 'commandes@boutique.tn',
  Destination: { ToAddresses: ['client@example.tn'] },
  Content: { Simple: { Subject: { Data: 'Votre reçu' }, Body: { Text: { Data: 'Merci pour votre commande.' } } } },
}));
```

Ou de votre machine, pour un essai : `ff email send --from commandes@boutique.tn --to vous@example.tn --subject Essai --text Bonjour`. Le message est mis en file et envoyé dans la seconde ; un serveur qui refuse pour l'instant est réessayé pendant un jour.

## Sa vie

- **Ce qu'il est devenu :** `ff email messages`, ou la page « E-mail » : chaque destinataire, envoyé, rejeté ou en échec avec les mots du serveur qui l'a reçu, ou signalé comme indésirable. FF garde les messages 30 jours.
- **La liste de suppression :** `ff email suppressions` ; `ff email suppress` et `ff email unsuppress` y mettent ou en retirent une adresse.
- **Métriques et alarmes :** comme CloudWatch pour SES : `Send`, `Delivery`, `Bounce`, `Complaint`, et les deux taux de réputation, `Reputation.BounceRate` et `Reputation.ComplaintRate`, un point par heure.
- **Le mois :** `ff usage`, ou la page « Usage » : les destinataires et les pièces jointes de chaque domaine ou adresse, leur coût estimé.
- **Sans crédit :** les envois attendent du crédit. **Compte suspendu :** ils sont refusés. **Compte fermé :** son courrier et les clés de ses domaines sont supprimés avec ses autres données, à la date de suppression annoncée.

## Partir vers Amazon SES

Le kit de sortie a sa page, [`cli/templates/export/data/ses.md`](../../cli/templates/export/data/ses.md) : vos domaines prouvés pour SES par ses propres clés, publiées à côté de celles de FF, pour que les deux signent pendant le passage ; la liste de suppression recopiée ; puis le code, inchangé, sans `AWS_ENDPOINT_URL_SESV2`.
