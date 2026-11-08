# Schedule expressions spike

How `ff local` will read EventBridge's schedule expressions, `rate()` and `cron()`, to run a function's schedules on time. It ports the backend's reader (`BE/src/schedules/schedule-expression.ts`) to Rust and checks that the port says what the backend says. The [developer tools plan](../../../docs/dev-tools-plan.md)'s D3; its task list's M-01, part 4, for M-05 to build on.

```bash
hack/spikes/schedule-expressions/run.sh                        # under a minute
LINES=200000 SEED=2 hack/spikes/schedule-expressions/run.sh    # more expressions, other ones
```

It needs Rust (the toolchain `cli/` pins) and Node.js 24, which runs the backend's TypeScript as it is, its types stripped. Its build and results go to `hack/.spike-schedule-expressions/` (`results.md`).

## What it does

- **One table for both readers.** The backend's tests used to hold their cases in code. They now read [`schedule-expressions.json`](../../../BE/src/schedules/schedule-expressions.json), beside the reader, with the same 47 tests: 6 rates, 23 refusals, and 18 tests of next runs holding 32 cases. The Rust tests read the same file, as `ff`'s tests already read some of the backend's files (`cli/src/commands/env.rs`). A case added for one reader tests the other too.
- **The reader** (`src/lib.rs`) is the backend's, function for function, with its messages word for word. It has no dependencies: its calendar is Howard Hinnant's `days_from_civil` and `civil_from_days`, and times are Unix milliseconds. Its tests use `serde_json` and `humantime`, which `ff` has already.
- **The comparison.** `generate.mjs` makes expressions at random from a seed. Each part is drawn from what EventBridge takes, and one in 25 from near misses: a value one past its field's end, a step of 0, a name misspelt, a field too many, a unit singular where it should be plural. Each expression comes with a time between 2026 and 2199's end. The spike's command and the backend's own reader (`backend.mts`) each print every expression's next runs, to the millisecond, or its refusal. The two outputs must be the same, line for line.
- **The worst case:** `cron(0 0 31 2 ? *)`. February has no 31st, so each reader walks every day to 2199's end before saying there is no run.

## What it found

On 2026-11-08, with Rust 1.91.0 and Node.js 24.22.0, in a release build:

| | |
|---|---|
| The Rust reader's tests | 5, which hold the table's 47 tests, its calendar checked against `humantime`'s for every day from 1970 to 2200, and JavaScript's way of printing numbers |
| Expressions made at random | 20,000 (seed 1): 9,663 with runs, 5,561 with no run left, 4,776 refused, in 47 kinds of refusal. Then 200,000 (seed 2) |
| Where the two readers differ | None, in either run |
| Time for the 20,000 | Rust 53 ms; the backend's 322 ms, Node.js's start included |
| `cron(0 0 31 2 ? *)`, 100 times | Rust 23 ms, the backend's 134 ms: 0.2 ms and 1.3 ms each |
| The reader's lines, without comments or tests | Rust 403, the backend's 222; rustfmt spreads Rust over more lines |

1. **The port says what the backend says.** On the table and on 220,000 expressions, it gives the same runs and the same refusals. M-05 can move `src/lib.rs` into `ff` as it is. Its tests then read the table at `BE/src/schedules/`. A change to the backend's reader without one to `ff`'s fails `ff`'s tests, as long as the table records the change.
2. **Matching JavaScript took four things, each tested:**
   - JavaScript's `\s`, which the backend splits and trims by. It is wider than ASCII's whitespace and narrower than Unicode's.
   - Numbers in messages printed as JavaScript prints them: `007` as 7, and 22 digits as `1e+21`.
   - An empty `cron()` counted as one field, as JavaScript's `split` counts it.
   - A rate's interval kept as wide as the backend's: up to 2^53 − 1 days, held in an `i128`.
3. **Two bugs in the backend, fixed before this spike** (`2bd1420`):
   - `rate(5 constructors)` was taken with no interval, because JavaScript's `in` finds `constructor` on every object.
   - A rate that runs beyond what a JavaScript `Date` holds, such as `rate(100000000 days)`, made an invalid date.

   Saving either failed with a 500, and its preview listed `null` runs. Now the first is refused, and a rate's runs end after 2199, where cron's years end.
4. **Speed doesn't matter here.** `ff local` reads a schedule once at its start and finds one next run after each run. Even the worst case, a cron that never runs, takes 0.2 ms.
5. **For M-05:**
   - `ff local` must keep a rate's runs on its first run's time, as the backend's scheduler does (`anchorAt`). A late run then doesn't move the ones after it.
   - The change map (`hack/suggest.map`) must send a change to the table to `ff`'s tests as well as the backend's.

Not done: EventBridge itself wasn't asked. The backend's reader is the reference, and its tests hold EventBridge's documented examples.
