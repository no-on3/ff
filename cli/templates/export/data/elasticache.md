# Your FF cache, to ElastiCache for Valkey

An FF cache is a Valkey server of its own, at an address `rediss://default:<password>@<host>:<port>`, over TLS. On AWS it becomes ElastiCache for Valkey, with encryption in transit and an AUTH token: your code changes nothing but the address it reads, `REDIS_URL` or the secret you named. Its keys don't move. It's a cache: your app fills it again as it misses.

## What you need

- **The cache on FF:** `ff caches get <name> --output json`, its memory and its engine.
- **An AWS account and the AWS CLI,** and your functions on AWS Lambda in a VPC: ElastiCache is reached inside one, so a cache moves with the functions that use it. A subnet group of ElastiCache's in the VPC's subnets, and a security group that lets the functions' own in on port 6379.

## What each becomes

| On FF | On ElastiCache |
|---|---|
| A cache of the plan's memory, 64 MB on beta | A cluster of one node, `cache.t4g.micro` (0.5 GiB) the smallest, or a serverless cache |
| TLS alone, a password | Encryption in transit, an AUTH token, or a user of its access control |
| The least recently used keys going past its memory (`allkeys-lru`) | The same, set in a parameter group: ElastiCache's default is `volatile-lru`, which lets only keys with a TTL go |
| Nothing kept on disk | No snapshots |
| Reached by the account's functions whatever their internet access, and from your machine | Reached from inside its VPC: your functions there; your machine through a host in the VPC or a VPN |
| `BytesUsedForCache`, `CurrConnections`, `CacheHits`, `CacheMisses`, `Evictions`, and alarms on them | The same names in CloudWatch's `AWS/ElastiCache`, and its alarms |
| Billed by the GB-hour of its memory | Billed by the node-hour |

FF runs Valkey 9.1; ElastiCache may offer an older version. Check that the commands your code uses are in the one you pick.

## Moving

1. **A parameter group that lets the least recently used keys go,** as FF's caches do, in the family of the version you pick (`valkey8` here):

   ```bash
   aws elasticache create-cache-parameter-group --cache-parameter-group-name ff-cache \
     --cache-parameter-group-family valkey8 --description "As FF's caches: the least recently used keys go"
   aws elasticache modify-cache-parameter-group --cache-parameter-group-name ff-cache \
     --parameter-name-values ParameterName=maxmemory-policy,ParameterValue=allkeys-lru
   ```

2. **The cache,** over TLS with an AUTH token, without snapshots:

   ```bash
   token="$(openssl rand -hex 32)"
   aws elasticache create-replication-group --replication-group-id sessions \
     --replication-group-description "sessions, from FF" --engine valkey \
     --cache-node-type cache.t4g.micro --num-cache-clusters 1 --cache-parameter-group-name ff-cache \
     --transit-encryption-enabled --auth-token "$token" --snapshot-retention-limit 0 \
     --cache-subnet-group-name <your subnet group> --security-group-ids <its security group>
   ```

3. **Its address,** once it is `available`: the token as its password, as FF's address carries its own.

   ```bash
   host="$(aws elasticache describe-replication-groups --replication-group-id sessions \
     --query 'ReplicationGroups[0].NodeGroups[0].PrimaryEndpoint.Address' --output text)"
   echo "rediss://:$token@$host:6379"
   ```

4. **Give it to the functions on AWS Lambda,** in the environment variable your code reads, or in Secrets Manager. ElastiCache's certificate is from Amazon's CA, which Node.js and Python trust by themselves, as they trust the certificate of FF's server in production, a public CA's.
5. **Then delete the cache on FF** (`ff caches delete <name>`), once the functions on FF no longer use it: until then, its memory is billed.

**Its keys:** none are copied, a cache's being rebuilt as your app misses them. Keep what must outlive a restart in a database, on FF as on AWS.
