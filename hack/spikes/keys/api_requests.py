"""The cluster API's requests so far, from its metrics on stdin (apiserver_request_total), summed by verb and resource:
one JSON object, {"<verb> <resource>[/<subresource>]": count}, every client's together.
  kubectl get --raw /metrics | python3 api_requests.py
"""
import collections
import json
import re
import sys

counts = collections.Counter()
for line in sys.stdin:
    if not line.startswith("apiserver_request_total{"):
        continue
    labels_part, value = line.rsplit(" ", 1)
    labels = dict(re.findall(r'(\w+)="([^"]*)"', labels_part))
    subresource = labels.get("subresource", "")
    counts[f"{labels.get('verb', '')} {labels.get('resource', '')}{'/' + subresource if subresource else ''}"] += float(value)
print(json.dumps({key: int(count) for key, count in sorted(counts.items())}))
