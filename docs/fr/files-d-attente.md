# Files d'attente et tâches en arrière-plan

FF fait le travail qui peut attendre **comme AWS** : une fonction appelée sans attendre sa réponse, comme l'invocation asynchrone d'AWS Lambda ; des files d'attente **comme AWS SQS**, que les SDK et la CLI d'AWS utilisent tels quels, seule l'adresse du service changeant, et que vos fonctions lisent par lots ; une fonction lancée quand un fichier arrive dans un compartiment, comme avec les notifications de S3. Tout attend dans la base de données de FF jusqu'à être traité, même si un serveur de FF s'arrête entre-temps ([ADR 0010](../adr/0010-queue.md), en anglais).

## Ce que c'est

| | FF | AWS |
|---|---|---|
| Appeler sans attendre | `X-Amz-Invocation-Type: Event`, ou `ff invoke <nom> --async` : la réponse 202 donne tout de suite l'identifiant de la requête ; après un échec, deux nouvelles tentatives, une minute puis deux plus tard, pendant six heures au plus | L'invocation asynchrone de Lambda, aux mêmes règles |
| Ses réglages | Comme `EventInvokeConfig` : le nombre de nouvelles tentatives (0 à 2), la durée de conservation (60 s à 6 h), une destination pour les appels réussis et une pour ceux qui ont échoué : une fonction ou une file du compte | Les mêmes, plus SNS et EventBridge |
| Files d'attente | Les files standard de SQS et leur API, signée avec AWS Signature Version 4 ; les SDK et la CLI d'AWS, l'adresse de FF dans `AWS_ENDPOINT_URL_SQS` | Les files standard et FIFO |
| Livraison | Au moins une fois : un message reçu est caché pendant son délai de visibilité, et revient s'il n'a pas été supprimé | La même |
| File de lettres mortes | Un message reçu plus de `maxReceiveCount` fois y passe, comme avec la politique de redirection de SQS | La même, et le renvoi de ses messages vers leur file |
| Une fonction qui lit une file | Comme les mappages de source d'événements de Lambda : des lots de 1 à 10 000 messages, une fenêtre d'attente, les échecs message par message (`ReportBatchItemFailures`), une concurrence maximale | Les mêmes |
| Un fichier qui lance une fonction | Comme les notifications de S3 : un fichier créé ou supprimé, filtré par préfixe et suffixe, vers une fonction ou une file | Les mêmes, plus SNS et EventBridge |
| Limites | Celles de l'offre : sur la bêta, 100 Mo de messages en attente au total, files et appels sans attente ensemble, et 100 requêtes par seconde ; 1 Mo par message | Pas de limite de stockage ; 1 Mo par message |
| Facturation | Comme SQS : par million de requêtes, chaque tranche de 64 Ko d'un message comptant pour une requête, le premier million offert chaque mois. Chaque tentative d'un appel est facturée comme un appel ; l'attente ne l'est pas | La même |

## Appeler une fonction sans attendre

```bash
ff invoke envoyer-recu --async --data '{"commande": 42}'
ff async-config envoyer-recu --retries 1 --on-failure arn:aws:sqs:tn-tunis-1:<compte>:recus-echoues
```

L'appel est gardé dans la base de FF et lancé dans la seconde ; chaque tentative est dans l'historique de la fonction, sous le même identifiant de requête. Une fonction peut voir un appel deux fois : comme sur Lambda, faites le travail une seule fois par identifiant de requête (`context.awsRequestId`). Un appel qui échoue pour de bon envoie l'enregistrement de Lambda à sa destination : l'appel, l'erreur et le nombre de tentatives. Dans la console, l'onglet « Invocations » d'une fonction appelle sans attendre (« Don't wait for the answer »), et son panneau « Calls that don't wait » montre ses réglages et le résumé de la dernière journée.

## Une file d'attente

```bash
ff queues create commandes-dlq
ff queues create commandes --visibility-timeout 1m --dead-letter-queue commandes-dlq --max-receive-count 3
eval "$(ff buckets keys create --queue commandes | grep '^export ')"
aws sqs send-message --queue-url "$(aws sqs get-queue-url --queue-name commandes --query QueueUrl --output text)" \
  --message-body '{"commande": 42}'
```

`ff buckets keys create --queue commandes` crée une clé qui n'atteint que cette file, et n'en affiche le secret qu'à ce moment-là, sous la forme des six variables que lisent les outils d'AWS, `AWS_ENDPOINT_URL_SQS` parmi elles. Depuis une fonction, rien à régler : `new SQSClient({})` en Node.js et `boto3.client("sqs")` en Python marchent tels quels, la fonction ayant sa propre clé, comme sur AWS Lambda avec un rôle. Dans la console, la page « Queues » : les files du compte et leurs messages ; pour chacune, ses attributs, l'envoi et la réception de messages pour la déboguer, ses dernières heures et ses alarmes.

## Une fonction qui lit une file

```bash
ff event-sources add commandes traiter-commande --batching-window 2s --report-batch-item-failures
```

FF appelle la fonction avec l'événement de SQS, `Records[]`, et supprime les messages que l'appel a traités. Avec `--report-batch-item-failures`, la réponse de la fonction, `batchItemFailures`, nomme ceux qui ont échoué : eux seuls reviennent après le délai de visibilité de la file, puis passent dans sa file de lettres mortes. Le délai de visibilité de la file doit être au moins le délai d'exécution de la fonction, comme Lambda l'exige. Désactivé (`ff event-sources update <uuid> --disable`), le mappage ne lit plus rien, et les messages attendent.

## Un fichier qui lance une fonction

```bash
ff buckets notify photos creer-vignette --prefix entree/
```

Chaque fichier créé sous `entree/` lance la fonction sans attendre, avec l'événement de S3 ; avec `--queue`, cet événement va dans une file. Avec la CLI d'AWS, c'est `aws s3api put-bucket-notification-configuration`, dans le XML de S3. Une fonction qui écrit sous le préfixe qui la lance se relancerait pour chaque fichier qu'elle écrit : écrivez ailleurs (`sortie/`). FF envoie chaque événement au plus une fois : un serveur de FF qui s'arrête juste après l'envoi d'un fichier perd son événement, là où S3 promet au moins une fois.

## Sa vie

- **Métriques et alarmes :** comme CloudWatch pour SQS et Lambda : les messages en attente, en cours et différés, l'âge du plus ancien, les messages envoyés, reçus et supprimés (`ff queues metrics commandes`) ; pour les appels sans attente, ceux gardés, ceux abandonnés, et les enregistrements qu'une destination n'a pas pris. Une alarme sur `ApproximateNumberOfMessagesVisible` d'une file de lettres mortes vous dit qu'un message a échoué pour de bon.
- **Le mois :** `ff usage`, ou la page « Usage » de la console : les requêtes de chaque file, ses messages envoyés et reçus, son coût estimé.
- **Sans crédit :** l'envoi attend du crédit ; la réception et la suppression continuent.
- **Compte suspendu :** ses clés sont refusées, et ses fonctions ne lisent plus ses files ; ses messages restent jusqu'à la fin de leur conservation. **Compte fermé :** ses files partent avec ses autres données, à la date de suppression annoncée.
- **Supprimer une file :** `ff queues delete commandes`, après confirmation, avec ses messages ; ses mappages et ses alarmes partent avec elle.

## Partir vers AWS

La page [`cli/templates/export/data/sqs.md`](../../cli/templates/export/data/sqs.md) (en anglais), que `ff export` met dans son kit de sortie ([Partir vers AWS](partir-vers-aws.md)), dit comment chaque file, mappage, réglage d'appel sans attente et notification de compartiment devient sa ressource AWS (`AWS::SQS::Queue`, `AWS::Lambda::EventSourceMapping`, `AWS::Lambda::EventInvokeConfig`, la `NotificationConfiguration` du compartiment), avec un modèle SAM. Les messages en attente ne sont pas copiés : on envoie d'abord vers AWS, on laisse FF traiter ce qui attend, puis on supprime les files sur FF. Le code ne change pas : seule l'adresse du service disparaît de son environnement.
