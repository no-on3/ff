//! A template's schedules on this machine, run as FF's scheduler runs them (`BE/src/schedules/scheduler.service.ts`)
//! while `ff local start` runs: each enabled one from the start, its runs by EventBridge's expression as the backend
//! reads it ([`super::schedule_expression`]), a rate's kept on the start's time; a late run made once, then the
//! expression followed from now; each run an asynchronous call of its function, with EventBridge's Scheduled Event as
//! the backend builds it (`BE/src/schedules/scheduled-event.ts`), or the schedule's own input.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use super::schedule_expression::{Expression, Millis};
use crate::dates::iso;

/// A function's schedule, as its Schedule or ScheduleV2 event declares it.
#[derive(Clone, Debug, PartialEq)]
pub struct LocalSchedule {
    pub name: String,
    /// Its expression, as the template writes it.
    pub expression: String,
    pub reader: Expression,
    /// Its Input; none, EventBridge's Scheduled Event.
    pub input: Option<Value>,
    pub enabled: bool,
}

/// The rule's name in its ARN: the function's and the schedule's, as a function's schedules are its own.
pub fn rule_name(function: &str, schedule: &str) -> String {
    format!("{function}-{schedule}")
}

/// EventBridge's Scheduled Event, which a rule's schedule sends its target: `id` the run's, `time` when it was due,
/// to the second.
pub fn scheduled_event(id: &str, account: &str, time: Millis, region: &str, rule: &str) -> Value {
    json!({
        "version": "0",
        "id": id,
        "detail-type": "Scheduled Event",
        "source": "aws.events",
        "account": account,
        "time": iso(time),
        "region": region,
        "resources": [format!("arn:aws:events:{region}:{account}:rule/{rule}")],
        "detail": {},
    })
}

/// Now, in Unix milliseconds, `offset` later.
pub fn now_ms(offset: Millis) -> Millis {
    let since = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    Millis::try_from(since.as_millis()).unwrap_or(Millis::MAX).saturating_add(offset)
}

/// A run due: its function, its schedule, and when it was due.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Due {
    pub function: String,
    pub schedule: String,
    pub at: Millis,
}

struct Entry {
    function: String,
    schedule: String,
    reader: Expression,
    /// A rate's first run's time, which its runs keep to.
    anchor: Millis,
    /// None when no run is left.
    next: Option<Millis>,
}

/// The enabled schedules' next runs.
pub struct Timetable {
    entries: Vec<Entry>,
}

impl Timetable {
    /// Each enabled schedule of the functions', by function, its first run after `now`, as FF finds a schedule's when
    /// it is made: a rate's runs from now.
    pub fn new<'a>(schedules: impl IntoIterator<Item = (&'a String, &'a [LocalSchedule])>, now: Millis) -> Timetable {
        let entries = schedules
            .into_iter()
            .flat_map(|(function, schedules)| schedules.iter().map(move |schedule| (function, schedule)))
            .filter(|(_, schedule)| schedule.enabled)
            .map(|(function, schedule)| Entry {
                function: function.clone(),
                schedule: schedule.name.clone(),
                reader: schedule.reader.clone(),
                anchor: now,
                next: schedule.reader.next_run(now, Some(now)),
            })
            .collect();
        Timetable { entries }
    }

    /// The runs due at `now`, the earliest first, each schedule moved to its next run after now, not after when it was
    /// due: a late schedule runs once, then follows its expression.
    pub fn due(&mut self, now: Millis) -> Vec<Due> {
        let mut due = Vec::new();
        for entry in &mut self.entries {
            let Some(at) = entry.next.filter(|&at| at <= now) else { continue };
            entry.next = entry.reader.next_run(now, Some(entry.anchor));
            due.push(Due { function: entry.function.clone(), schedule: entry.schedule.clone(), at });
        }
        due.sort_by_key(|run| run.at);
        due
    }

    /// A schedule's next run; none when it is disabled or has no run left.
    pub fn next_run(&self, function: &str, schedule: &str) -> Option<Millis> {
        let entry = self.entries.iter().find(|entry| entry.function == function && entry.schedule == schedule)?;
        entry.next
    }

    /// The earliest of the next runs.
    fn next_at(&self) -> Option<Millis> {
        self.entries.iter().filter_map(|entry| entry.next).min()
    }
}

/// Runs the timetable's runs with `run` as they come due by the clock `now`, until the process ends; it looks at least
/// once a second, so that a clock moved, or a machine woken, finds its runs late rather than never.
pub fn keep(mut table: Timetable, now: impl Fn() -> Millis, run: impl Fn(&Due)) {
    loop {
        for due in table.due(now()) {
            run(&due);
        }
        let wait = table.next_at().map_or(1000, |at| (at - now()).clamp(1, 1000));
        std::thread::sleep(Duration::from_millis(u64::try_from(wait).unwrap_or(1000)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A time, as the table of expressions writes them.
    fn at(text: &str) -> Millis {
        let time = humantime::parse_rfc3339(text).unwrap();
        Millis::try_from(time.duration_since(UNIX_EPOCH).unwrap().as_millis()).unwrap()
    }

    fn schedule(name: &str, expression: &str, enabled: bool) -> LocalSchedule {
        LocalSchedule {
            name: name.into(),
            expression: expression.into(),
            reader: Expression::parse(expression).unwrap(),
            input: None,
            enabled,
        }
    }

    #[test]
    fn the_scheduled_event_is_eventbridges_as_the_backend_builds_it() {
        let event = scheduled_event(
            "8f1c5a52-1c1e-4c1b-9d55-2f2e7f1f0b11",
            "000000000000",
            at("2026-11-10T02:00:00.250Z"),
            "tn-tunis-1",
            &rule_name("Reporter", "Nightly"),
        );

        assert_eq!(
            event,
            json!({
                "version": "0",
                "id": "8f1c5a52-1c1e-4c1b-9d55-2f2e7f1f0b11",
                "detail-type": "Scheduled Event",
                "source": "aws.events",
                "account": "000000000000",
                "time": "2026-11-10T02:00:00Z",
                "region": "tn-tunis-1",
                "resources": ["arn:aws:events:tn-tunis-1:000000000000:rule/Reporter-Nightly"],
                "detail": {},
            })
        );
    }

    #[test]
    fn each_enabled_schedule_runs_when_due_a_rate_kept_on_the_start_and_a_late_one_once() {
        let start = at("2026-11-09T09:59:30Z");
        let functions = [
            ("Reporter".to_owned(), vec![schedule("Nightly", "cron(0 2 * * ? *)", true)]),
            (
                "Ticker".to_owned(),
                vec![schedule("Often", "rate(5 minutes)", true), schedule("Off", "rate(1 minute)", false)],
            ),
        ];
        let mut table = Timetable::new(functions.iter().map(|(name, schedules)| (name, schedules.as_slice())), start);
        let due = |function: &str, schedule: &str, time: &str| Due {
            function: function.into(),
            schedule: schedule.into(),
            at: at(time),
        };

        assert_eq!(table.next_run("Reporter", "Nightly"), Some(at("2026-11-10T02:00:00Z")));
        assert_eq!(table.next_run("Ticker", "Often"), Some(at("2026-11-09T10:04:30Z")), "five minutes from the start");
        assert_eq!(table.next_run("Ticker", "Off"), None, "a disabled schedule doesn't run");
        assert_eq!(table.due(at("2026-11-09T10:04:29Z")), []);
        assert_eq!(table.due(at("2026-11-09T10:04:30Z")), [due("Ticker", "Often", "2026-11-09T10:04:30Z")]);
        assert_eq!(table.next_run("Ticker", "Often"), Some(at("2026-11-09T10:09:30Z")));
        // Woken 12 minutes late: the run due at 10:09:30 is made once, and the next keeps to the start's time.
        assert_eq!(table.due(at("2026-11-09T10:21:00Z")), [due("Ticker", "Often", "2026-11-09T10:09:30Z")]);
        assert_eq!(table.next_run("Ticker", "Often"), Some(at("2026-11-09T10:24:30Z")));
        // Both due at once, the earliest first.
        assert_eq!(
            table.due(at("2026-11-10T02:00:10Z")),
            [due("Ticker", "Often", "2026-11-09T10:24:30Z"), due("Reporter", "Nightly", "2026-11-10T02:00:00Z")]
        );
        assert_eq!(table.next_run("Reporter", "Nightly"), Some(at("2026-11-11T02:00:00Z")));
        assert_eq!(table.next_at(), Some(at("2026-11-10T02:04:30Z")));
    }

    #[test]
    fn a_schedule_with_no_run_left_never_comes_due() {
        let functions = [("Once".to_owned(), vec![schedule("Gone", "cron(0 0 1 1 ? 2020)", true)])];
        let mut table = Timetable::new(
            functions.iter().map(|(name, schedules)| (name, schedules.as_slice())),
            at("2026-11-09T10:00:00Z"),
        );

        assert_eq!((table.next_run("Once", "Gone"), table.next_at()), (None, None));
        assert_eq!(table.due(at("2199-12-31T23:59:00Z")), []);
    }
}
