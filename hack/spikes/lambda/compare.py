"""What changed between two runs of run.sh: the pinned tools' (the recordings kept in the repository) and other
versions' (the nightly's latest, hack/ci.sh tools). For each tool: its steps' outcomes, the operations it called, and
for each operation how it signed the path and which headers. A step that passed and now fails, a refusal that now goes
through (the tool retrying or skipping it), an operation called or no longer called, a path or headers signed otherwise:
each a line "  FAIL <tool>: ...", and the exit status 1. What moves from run to run is a line "  note ..." at most: the
polls' counts, and a step the flow marks paced, whose refusal depends on the tool's own pace (the AWS CLI starts a
container for each command, which takes about as long as the endpoint's windows).
    python3 compare.py <pinned recordings> <other recordings> <tool>..."""
import json
import sys


def load(path):
    try:
        with open(path, encoding='utf-8') as lines:
            return [json.loads(line) for line in lines if line.strip()]
    except FileNotFoundError:
        return None


def profile(requests):
    """Each operation's count, the ways its path was signed, and the headers signed."""
    ops = {}
    for request in requests:
        op = ops.setdefault(request.get('operation', '?'), {'count': 0, 'paths': set(), 'headers': set()})
        op['count'] += 1
        op['paths'].add(request.get('signedPath', ''))
        op['headers'].update(name.lower() for name in request.get('signedHeaders', []))
    return ops


def compare(pinned_dir, other_dir, tool):
    failures, notes = [], []
    pinned_steps, other_steps = load(f'{pinned_dir}/{tool}.steps.jsonl'), load(f'{other_dir}/{tool}.steps.jsonl')
    if other_steps is None:
        return [f'{tool}: no steps recorded: the run ended before its flow'], notes
    if pinned_steps is None:
        return [f'{tool}: no recordings of the pinned version to compare with'], notes
    others = {step['step']: step for step in other_steps}
    for step in pinned_steps:
        name, other = step['step'], others.get(step['step'])
        if other is None:
            failures.append(f'{tool}: the step "{name}" no longer ran')
        elif step['ok'] == other['ok']:
            continue
        elif step.get('paced') or other.get('paced'):
            notes.append(f'{tool}: the step "{name}" {"went through" if other["ok"] else "was refused"} this time, as the tool\'s pace decides')
        elif step['ok']:
            shown = other.get('shown', '').replace('\n', ' ').strip()
            failures.append(f'{tool}: the step "{name}" fails now: {shown[:300]}')
        else:
            failures.append(f'{tool}: the step "{name}", refused with the pinned version, goes through now: the tool retries or skips the refusal')
    pinned_ops = profile(load(f'{pinned_dir}/{tool}.requests.jsonl') or [])
    other_ops = profile(load(f'{other_dir}/{tool}.requests.jsonl') or [])
    for name in sorted(set(pinned_ops) | set(other_ops)):
        if name not in other_ops:
            failures.append(f'{tool}: no longer calls {name}')
            continue
        if name not in pinned_ops:
            failures.append(f'{tool}: now calls {name}')
            continue
        before, after = pinned_ops[name], other_ops[name]
        if before['paths'] != after['paths']:
            failures.append(f'{tool}: signs {name}\'s path {"/".join(sorted(after["paths"]))}, not {"/".join(sorted(before["paths"]))}')
        if before['headers'] != after['headers']:
            added, gone = sorted(after['headers'] - before['headers']), sorted(before['headers'] - after['headers'])
            failures.append(f'{tool}: signs {name} with other headers: {", ".join(["+" + h for h in added] + ["-" + h for h in gone])}')
        if before['count'] != after['count']:
            notes.append(f'{tool}: {name} {after["count"]} times, {before["count"]} with the pinned version')
    return failures, notes


def main(pinned_dir, other_dir, tools):
    failed = False
    for tool in tools:
        failures, notes = compare(pinned_dir, other_dir, tool)
        for line in failures:
            print(f'  FAIL {line}')
        for line in notes:
            print(f'  note {line}')
        if not failures:
            print(f'  ok   {tool}: the same operations, signed the same way, every step as before')
        failed = failed or bool(failures)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2], sys.argv[3:]))
