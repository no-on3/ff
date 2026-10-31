"""What each client of the spike asked the Lambda endpoint, from run.sh's recordings: in Markdown, for each client, its
steps that failed, the operations it called and how often, how it signed their paths, its waiters' polls, what it made
of a refusal, and its largest bodies; then every operation against every client, which is D2's list made from what
the tools call.
  python3 analyze.py <work directory> <client...>"""
import json
import statistics
import sys
from collections import Counter
from datetime import datetime

work, clients = sys.argv[1], sys.argv[2:]
WRITES = ('Create', 'Update', 'Put', 'Publish', 'Add', 'Remove', 'Tag', 'Untag', 'Delete')


def lines(path):
    try:
        with open(path) as file:
            return [json.loads(line) for line in file if line.strip()]
    except FileNotFoundError:
        return []


def at(record):
    return datetime.fromisoformat(record['at'].replace('Z', '+00:00')).timestamp()


def polls(requests):
    """Runs of three or more reads of one operation in a row: a waiter's, with the seconds between its polls."""
    runs, current = [], []
    for record in requests:
        if current and record['operation'] == current[-1]['operation'] and not record['operation'].startswith(WRITES):
            current.append(record)
            continue
        if len(current) >= 3:
            runs.append(current)
        current = [record]
    if len(current) >= 3:
        runs.append(current)
    return runs


everyone = {}
print('# What AWS\'s tools call: the spike\'s recordings\n')
for client in clients:
    requests = lines(f'{work}/{client}.requests.jsonl')
    steps = lines(f'{work}/{client}.steps.jsonl')
    agents = Counter(record['tool'] for record in requests)
    print(f'## {client}: {", ".join(agents) or "no request"}\n')
    failed = [step for step in steps if not step['ok']]
    print(f'- **Steps:** {len(steps) - len(failed)} of {len(steps)} as expected.')
    for step in failed:
        shown = (step.get('shown') or '').replace('\n', ' ')[:300]
        print(f'  - {step["step"]}: {shown}')
    counts = Counter(record['operation'] for record in requests)
    everyone[client] = counts
    print(f'- **Operations,** {len(requests)} requests: ' + ', '.join(f'{op} {n}' for op, n in counts.most_common()) + '.')
    signed = Counter(record.get('signedPath', 'not checked') for record in requests)
    print(f'- **Paths signed:** ' + ', '.join(f'{how} {n}' for how, n in signed.items()) + '.')
    arn_paths = [record for record in requests if '%3A' in record['path'] or ':' in record['path'].split('/', 3)[-1]]
    if arn_paths:
        raw = Counter('escaped (%3A)' if '%3A' in record['path'] else 'raw colons' for record in arn_paths)
        print(f'- **ARNs in paths,** {len(arn_paths)}: sent ' + ', '.join(f'{how} {n}' for how, n in raw.items()) + '.')
    headers = Counter(';'.join(record.get('signedHeaders', [])) for record in requests if record.get('signedHeaders'))
    print('- **Signed headers:** ' + '; '.join(f'`{names}` ({n})' for names, n in headers.most_common(3)) + '.')
    for run in polls(requests):
        gaps = [round(at(b) - at(a), 2) for a, b in zip(run, run[1:])]
        print(f'- **A waiter\'s polls:** {run[0]["operation"]} {len(run)} times over {round(at(run[-1]) - at(run[0]), 1)} s, '
              f'{min(gaps)} to {max(gaps)} s apart (median {statistics.median(gaps)}).')
    refused = [record for record in requests if record.get('error')]
    for error, n in Counter((record['operation'], record['status'], record['error']) for record in refused).items():
        print(f'- **Refused:** {error[0]}, {error[1]} {error[2]}, {n} request(s)' + (' (retried)' if n > 1 else '') + '.')
    biggest = max(requests, key=lambda record: record['requestBytes'], default=None)
    if biggest:
        chunked = sorted({record.get('transferEncoding') or 'Content-Length' for record in requests if record['requestBytes'] > 1_000_000})
        print(f'- **Largest request:** {biggest["operation"]}, {biggest["requestBytes"]:,} bytes ({", ".join(chunked) or "Content-Length"}); '
              f'largest answer {max(record["responseBytes"] for record in requests):,} bytes.')
    print()

operations = sorted(set().union(*everyone.values())) if everyone else []
print('## Every operation, by client\n')
print('| Operation | ' + ' | '.join(clients) + ' |')
print('|---|' + '---|' * len(clients))
for operation in operations:
    print(f'| {operation} | ' + ' | '.join(str(everyone[client].get(operation, '')) for client in clients) + ' |')
