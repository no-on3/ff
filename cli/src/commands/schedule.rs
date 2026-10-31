//! `ff schedule`: a function run at the times an EventBridge expression names, in UTC, with
//! EventBridge's Scheduled Event or an input of its own, as SAM's Schedule event declares it.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::Context;
use super::invoke::input_of;
use crate::api::types::function_named;
use crate::api::{Call, Client};
use crate::error::{Error, Kind};
use crate::table::{table, time};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Schedule {
    id: String,
    pub(super) name: String,
    pub(super) description: Option<String>,
    pub(super) expression: String,
    pub(super) input: Value,
    pub(super) enabled: bool,
    next_run_at: Option<String>,
    last_run_at: Option<String>,
    last_request_id: Option<String>,
    last_outcome: Option<String>,
}

/// What a schedule set sends: the expression always, the rest when asked.
pub struct ScheduleChanges {
    pub expression: String,
    pub input: Option<Value>,
    pub no_input: bool,
    pub description: Option<String>,
    pub disabled: bool,
}

fn schedules(client: &Client, function_id: &str) -> Result<Vec<Schedule>, Error> {
    client.json(&Call::get(format!("/functions/{function_id}/schedules")))
}

fn named(schedules: Vec<Schedule>, name: &str, function: &str) -> Result<Schedule, Error> {
    schedules.into_iter().find(|schedule| schedule.name == name).ok_or_else(|| {
        Error::new(
            Kind::Failed,
            format!("{function} has no schedule named \"{name}\": `ff schedule list {function}` lists them"),
        )
    })
}

fn last_run(schedule: &Schedule) -> String {
    match (&schedule.last_run_at, &schedule.last_outcome) {
        (Some(due), Some(outcome)) => format!("{outcome}, due {}", time(due)),
        _ => "never".to_owned(),
    }
}

pub fn list(function: &str, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let found = function_named(&client, function)?;
    let schedules = schedules(&client, &found.id)?;
    context.out.result(&schedules, || {
        if schedules.is_empty() {
            return format!("{function} has no schedule: `ff schedule set {function} \"rate(1 hour)\"` makes one");
        }
        let rows: Vec<Vec<String>> = schedules
            .iter()
            .map(|schedule| {
                vec![
                    schedule.name.clone(),
                    schedule.expression.clone(),
                    if schedule.enabled { "yes" } else { "no" }.to_owned(),
                    schedule.next_run_at.as_deref().map(time).unwrap_or_else(|| "-".to_owned()),
                    last_run(schedule),
                ]
            })
            .collect();
        table(&["NAME", "EXPRESSION", "ENABLED", "NEXT RUN (UTC)", "LAST RUN (UTC)"], &rows)
    })
}

/// Its next runs, as the API's own parser reads the expression: what it is wrong in it, otherwise.
fn next_runs(client: &Client, expression: &str) -> Result<Vec<String>, Error> {
    #[derive(Deserialize)]
    struct Runs {
        runs: Vec<String>,
    }
    Ok(client.json::<Runs>(&Call::get("/schedules/next-runs").query("expression", expression))?.runs)
}

pub fn set(function: &str, name: &str, changes: ScheduleChanges, context: &Context) -> Result<(), Error> {
    if changes.input.is_some() && changes.no_input {
        return Err(Error::usage("--input and --no-input say opposite things: one or the other"));
    }
    let client = Client::new(&context.settings()?)?;
    let found = function_named(&client, function)?;
    let runs = next_runs(&client, changes.expression.trim())?;
    let existing = schedules(&client, &found.id)?.into_iter().find(|schedule| schedule.name == name);
    let mut body = Map::new();
    body.insert("expression".into(), changes.expression.trim().into());
    if let Some(input) = changes.input {
        body.insert("input".into(), input);
    } else if changes.no_input {
        body.insert("input".into(), Value::Null);
    }
    if let Some(description) = changes.description {
        body.insert("description".into(), description.into());
    }
    let path = format!("/functions/{}/schedules", found.id);
    let (schedule, action) = match existing {
        None => {
            body.insert("name".into(), name.into());
            body.insert("enabled".into(), (!changes.disabled).into());
            (client.json::<Schedule>(&Call::post(path, Value::Object(body)))?, "made")
        }
        Some(existing) => {
            if changes.disabled {
                body.insert("enabled".into(), false.into());
            }
            (client.json::<Schedule>(&Call::put(format!("{path}/{}", existing.id), Value::Object(body)))?, "changed")
        }
    };
    let document = json!({ "schedule": schedule, "nextRuns": runs });
    context.out.result(&document, || {
        let event = if schedule.input.is_null() { "EventBridge's Scheduled Event" } else { "its own input" };
        let next = if schedule.enabled {
            format!("next runs (UTC): {}", runs.iter().map(|run| time(run)).collect::<Vec<_>>().join(", "))
        } else {
            "disabled: it doesn't run".to_owned()
        };
        format!("{function}'s schedule {} {action}: {}, with {event}\n{next}", schedule.name, schedule.expression)
    })
}

/// Enabled again, its runs start anew from now; disabled, it has none.
pub fn enable(function: &str, name: &str, enabled: bool, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let found = function_named(&client, function)?;
    let schedule = named(schedules(&client, &found.id)?, name, function)?;
    let changed: Schedule = client.json(&Call::put(
        format!("/functions/{}/schedules/{}", found.id, schedule.id),
        json!({ "enabled": enabled }),
    ))?;
    context.out.result(&changed, || match &changed.next_run_at {
        Some(next) if changed.enabled => format!("{function}'s schedule {name} enabled: next run {} UTC", time(next)),
        _ => format!(
            "{function}'s schedule {name} {}",
            if changed.enabled { "enabled" } else { "disabled: it doesn't run" }
        ),
    })
}

pub fn remove(function: &str, name: &str, context: &Context) -> Result<(), Error> {
    let client = Client::new(&context.settings()?)?;
    let found = function_named(&client, function)?;
    let schedule = named(schedules(&client, &found.id)?, name, function)?;
    client.done(&Call::delete(format!("/functions/{}/schedules/{}", found.id, schedule.id)))?;
    context.out.result(&json!({ "removed": true, "name": name }), || {
        format!("{function}'s schedule {name} removed: it runs no more")
    })
}

/// `--input`: inline JSON, `@file` or `-`, as `ff invoke --data` takes it.
pub fn input(data: Option<&str>) -> Result<Option<Value>, Error> {
    input_of(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule(outcome: Option<&str>) -> Schedule {
        Schedule {
            id: "s1".into(),
            name: "nightly".into(),
            description: None,
            expression: "cron(0 2 * * ? *)".into(),
            input: Value::Null,
            enabled: true,
            next_run_at: Some("2026-10-22T02:00:00.000Z".into()),
            last_run_at: outcome.map(|_| "2026-10-21T02:00:00.000Z".to_owned()),
            last_request_id: None,
            last_outcome: outcome.map(str::to_owned),
        }
    }

    #[test]
    fn the_last_run_says_how_it_went_and_when_it_was_due() {
        assert_eq!(last_run(&schedule(Some("success"))), "success, due 2026-10-21 02:00:00");
        assert_eq!(last_run(&schedule(None)), "never");
    }

    #[test]
    fn a_missing_schedule_is_named_with_the_command_that_lists_them() {
        let error = named(vec![schedule(None)], "hourly", "hello").map(|_| ()).unwrap_err();

        assert_eq!(error.message, "hello has no schedule named \"hourly\": `ff schedule list hello` lists them");
    }
}
