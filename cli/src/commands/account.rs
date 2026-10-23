//! The account's commands: `ff accounts` and `ff account`, from `GET /me`; `ff usage`,
//! `ff balance` and `ff metrics`, what the account used, owes, and how its functions ran.

use std::time::{Duration, SystemTime};

use serde::Deserialize;
use serde_json::Value;

use super::Context;
use crate::api::types::{Me, MeAccount, function_named};
use crate::api::{Call, Client};
use crate::cli::Format;
use crate::config::Settings;
use crate::error::{Error, Kind};
use crate::table::{table, time};

fn me(client: &Client) -> Result<Me, Error> {
    client.json(&Call::get("/me"))
}

/// The account the commands act for: the one named (`--account`, `FF_ACCOUNT`, the profile), or
/// the only one the token reaches, as an API key's.
pub fn current<'a>(me: &'a Me, settings: &Settings) -> Result<&'a MeAccount, Error> {
    if let Some(named) = &settings.account {
        return me.accounts.iter().find(|account| account.id == named.value).ok_or_else(|| {
            Error::new(
                Kind::Failed,
                format!(
                    "You don't belong to account {} (from {}): `ff accounts` lists yours",
                    named.value, named.source
                ),
            )
        });
    }
    match me.accounts.as_slice() {
        [only] => Ok(only),
        [] => Err(Error::new(Kind::Failed, "This login has no account yet: make one in the console")),
        _ => Err(Error::new(
            Kind::Failed,
            "This login has several accounts: name one with --account, FF_ACCOUNT or `ff config set account <ID>`; `ff accounts` lists them",
        )),
    }
}

pub fn accounts(context: &Context) -> Result<(), Error> {
    let settings = context.settings()?;
    let me = me(&Client::new(&settings)?)?;
    let chosen = current(&me, &settings).ok().map(|account| account.id.clone());
    context.out.result(&me.accounts, || {
        let rows: Vec<Vec<String>> = me
            .accounts
            .iter()
            .map(|account| {
                vec![
                    if chosen.as_deref() == Some(account.id.as_str()) { "*".to_owned() } else { String::new() },
                    account.id.clone(),
                    account.name.clone(),
                    account.status.clone(),
                    account.role.clone(),
                    account.plan.name.clone(),
                ]
            })
            .collect();
        table(&["", "ID", "NAME", "STATUS", "ROLE", "PLAN"], &rows)
    })
}

/// A plan's limits as people read them, in the order they matter to a developer.
fn limits(limits: &serde_json::Map<String, Value>) -> Vec<String> {
    let number = |key: &str| limits.get(key).and_then(Value::as_u64);
    let mut lines = Vec::new();
    let mut add = |key: &str, text: &dyn Fn(u64) -> String| {
        if let Some(value) = number(key) {
            lines.push(text(value));
        }
    };
    add("functions", &|n| format!("{n} functions"));
    add("memoryMb", &|n| format!("{n} MB of memory a function at most"));
    add("timeoutSeconds", &|n| format!("a timeout of {n} s at most"));
    add("instancesPerFunction", &|n| format!("{n} instances a function at most"));
    add("invokesPerSecond", &|n| format!("{n} invocations a second"));
    add("writesPerMinute", &|n| format!("{n} changes a minute"));
    add("logRetentionDays", &|n| format!("logs kept {n} days"));
    add("historyRetentionDays", &|n| format!("invocation history kept {n} days"));
    add("idleSeconds", &|n| format!("scaled to zero after {} min idle", n / 60));
    add("customDomains", &|n| format!("{n} custom domains"));
    add("schedules", &|n| format!("{n} schedules"));
    add("databases", &|n| if n == 1 { "1 database".to_string() } else { format!("{n} databases") });
    add("databaseStorageMb", &|n| format!("{n} MB a database"));
    add("databaseConnections", &|n| format!("{n} sessions a database"));
    add("buckets", &|n| if n == 1 { "1 bucket".to_string() } else { format!("{n} buckets") });
    add("bucketStorageMb", &|n| format!("{n} MB in the buckets"));
    add("storageRequestsPerSecond", &|n| format!("{n} requests to the buckets a second"));
    add("maxObjectMb", &|n| format!("{n} MB a file in one upload"));
    lines
}

pub fn account(context: &Context) -> Result<(), Error> {
    let settings = context.settings()?;
    let me = me(&Client::new(&settings)?)?;
    let account = current(&me, &settings)?;
    context.out.result(account, || {
        let mut lines = vec![
            format!("account      {} \"{}\"", account.id, account.name),
            format!("status       {}", account.status),
            format!("role         {}", account.role),
            format!("plan         {}: {}", account.plan.name, limits(&account.plan.limits).join(", ")),
        ];
        match account.internet_egress {
            Some(true) => lines.push("internet     its functions may reach the internet".to_owned()),
            Some(false) => lines.push(
                "internet     off: its functions reach FF's services only, and a call out fails; FF's operator turns it on".to_owned(),
            ),
            None => {}
        }
        if let Some(due) = &account.data_deletion_due_at {
            lines.push(match &account.data_deleted_at {
                Some(done) => format!("data         deleted on {} UTC", time(done)),
                None => format!("data         deleted on {} UTC, as the account is closed", time(due)),
            });
        }
        lines.join("\n")
    })
}

/// `YYYY-MM`, a month as the API takes it.
pub fn month(text: &str) -> Result<String, Error> {
    let valid = text.len() == 7
        && text.as_bytes()[4] == b'-'
        && text[..4].bytes().all(|byte| byte.is_ascii_digit())
        && matches!(text[5..].parse::<u8>(), Ok(1..=12));
    if valid {
        Ok(text.to_owned())
    } else {
        Err(Error::new(Kind::Usage, format!("--month is a month as YYYY-MM, such as 2026-10: {text}")))
    }
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    month: String,
    functions: Vec<FunctionUsage>,
    /// Absent from an API before customers' databases.
    #[serde(default)]
    databases: Vec<DatabaseUsage>,
    totals: Amounts,
    estimate: Option<Estimate>,
}

/// A database's month, as its hourly measures counted it.
#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseUsage {
    name: String,
    deleted: bool,
    hours: u32,
    gb_months: String,
    cost: Option<String>,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Amounts {
    requests: u64,
    billed_ms: u64,
    gb_seconds: String,
    throttled: u64,
    platform_errors: u64,
    lost: u64,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FunctionUsage {
    function_name: String,
    deleted: bool,
    cost: Option<String>,
    #[serde(flatten)]
    amounts: Amounts,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Estimate {
    currency: String,
    usage: String,
    free_tier: String,
    total: String,
}

pub fn usage(month_asked: Option<&str>, csv: bool, context: &Context) -> Result<(), Error> {
    let month = month_asked.map(month).transpose()?;
    let client = Client::new(&context.settings()?)?;
    let mut call = Call::get("/usage");
    if let Some(month) = &month {
        call = call.query("month", month);
    }
    if csv {
        let text = client.text(&call.accept("text/csv"))?;
        print!("{text}");
        return Ok(());
    }
    let usage: Usage = client.json(&call)?;
    context.out.result(&usage, || {
        let not_billed = |amounts: &Amounts| amounts.throttled + amounts.platform_errors + amounts.lost;
        let mut rows: Vec<Vec<String>> = usage
            .functions
            .iter()
            .map(|function| {
                vec![
                    if function.deleted {
                        format!("{} (deleted)", function.function_name)
                    } else {
                        function.function_name.clone()
                    },
                    function.amounts.requests.to_string(),
                    function.amounts.gb_seconds.clone(),
                    not_billed(&function.amounts).to_string(),
                    function.cost.clone().unwrap_or_default(),
                ]
            })
            .collect();
        rows.push(vec![
            "total".to_owned(),
            usage.totals.requests.to_string(),
            usage.totals.gb_seconds.clone(),
            not_billed(&usage.totals).to_string(),
            usage.estimate.as_ref().map(|estimate| estimate.usage.clone()).unwrap_or_default(),
        ]);
        let estimate = match &usage.estimate {
            Some(estimate) => format!(
                "estimated cost: {} {} ({} {} of usage, {} of free tier)",
                estimate.total, estimate.currency, estimate.usage, estimate.currency, estimate.free_tier
            ),
            None => "no estimate: no price book prices the month".to_owned(),
        };
        let databases = if usage.databases.is_empty() {
            String::new()
        } else {
            let rows: Vec<Vec<String>> = usage
                .databases
                .iter()
                .map(|database| {
                    vec![
                        if database.deleted { format!("{} (deleted)", database.name) } else { database.name.clone() },
                        database.hours.to_string(),
                        database.gb_months.clone(),
                        database.cost.clone().unwrap_or_default(),
                    ]
                })
                .collect();
            format!("\n{}", table(&["DATABASE", "HOURS", "GB-MONTHS", "COST"], &rows))
        };
        format!(
            "{}\n{}{databases}\n{estimate}",
            usage.month,
            table(&["FUNCTION", "REQUESTS", "GB-SECONDS", "NOT BILLED", "COST"], &rows)
        )
    })
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Balance {
    currency: String,
    balance: String,
    shadow_mode: bool,
    month: String,
    charged: String,
    rated_until: Option<String>,
    credit: Credit,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Credit {
    state: String,
    invokes_stop_at: Option<String>,
}

pub fn balance(context: &Context) -> Result<(), Error> {
    let balance: Balance = Client::new(&context.settings()?)?.json(&Call::get("/billing/balance"))?;
    context.out.result(&balance, || {
        let rated = balance
            .rated_until
            .as_deref()
            .map(|until| format!(", rated until {} UTC", time(until)))
            .unwrap_or_default();
        let shadow = if balance.shadow_mode { " (shadow mode: rated, not debited)" } else { "" };
        let invokes = match (balance.credit.state.as_str(), &balance.credit.invokes_stop_at) {
            ("grace", Some(stop)) => {
                format!("go on until {} UTC: the balance is below its buffer; add credit", time(stop))
            }
            ("stopped", _) => "stopped: they answer 402 until credit is added".to_owned(),
            _ => "go on".to_owned(),
        };
        format!(
            "balance   {} {}\ncharged   {} {} in {}{rated}{shadow}\ninvokes   {invokes}",
            balance.balance, balance.currency, balance.charged, balance.currency, balance.month
        )
    })
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "PascalCase")]
struct Series {
    invocations: Vec<u64>,
    errors: Vec<u64>,
    throttles: Vec<u64>,
    cold_starts: Vec<u64>,
    duration: Durations,
    instances: Instances,
}

#[derive(Deserialize, serde::Serialize)]
struct Durations {
    p50: Vec<Option<f64>>,
    p95: Vec<Option<f64>>,
    #[serde(rename = "Maximum")]
    maximum: Vec<Option<f64>>,
}

#[derive(Deserialize, serde::Serialize)]
struct Instances {
    #[serde(rename = "Maximum")]
    maximum: Vec<u64>,
}

#[derive(Deserialize, serde::Serialize)]
struct Metrics {
    period: u64,
    timestamps: Vec<String>,
    metrics: Series,
}

/// A window's start, `since` ago, as the API takes it.
pub fn start_of(since: &str, now: SystemTime) -> Result<String, Error> {
    let duration = humantime::parse_duration(since)
        .map_err(|error| Error::new(Kind::Usage, format!("--since takes a duration such as 30m, 6h or 2d: {error}")))?;
    let start = now.checked_sub(duration).unwrap_or(now);
    Ok(humantime::format_rfc3339_seconds(start).to_string())
}

pub fn metrics(name: Option<&str>, period: u32, since: &str, context: &Context) -> Result<(), Error> {
    let start = start_of(since, SystemTime::now())?;
    let client = Client::new(&context.settings()?)?;
    let path = match name {
        Some(name) => format!("/functions/{}/metrics", function_named(&client, name)?.id),
        None => "/metrics".to_owned(),
    };
    let metrics: Metrics = client.json(&Call::get(path).query("period", period).query("start", &start))?;
    if context.out.format == Format::Json {
        return context.out.result(&metrics, String::new);
    }
    let milliseconds = |value: Option<f64>| value.map(|value| format!("{value:.1}")).unwrap_or_else(|| "-".to_owned());
    let series = &metrics.metrics;
    let rows: Vec<Vec<String>> = metrics
        .timestamps
        .iter()
        .enumerate()
        .map(|(index, timestamp)| {
            vec![
                time(timestamp),
                series.invocations[index].to_string(),
                series.errors[index].to_string(),
                series.throttles[index].to_string(),
                series.cold_starts[index].to_string(),
                milliseconds(series.duration.p50[index]),
                milliseconds(series.duration.p95[index]),
                milliseconds(series.duration.maximum[index]),
                series.instances.maximum[index].to_string(),
            ]
        })
        .collect();
    let total = |values: &[u64]| values.iter().sum::<u64>();
    let summary = format!(
        "{} for {}, a point each {}: invocations {}, errors {}, throttles {}, cold starts {}",
        name.map(|name| format!("\"{name}\"")).unwrap_or_else(|| "the account".to_owned()),
        humantime::format_duration(Duration::from_secs(u64::from(period) * metrics.timestamps.len() as u64)),
        humantime::format_duration(Duration::from_secs(metrics.period)),
        total(&series.invocations),
        total(&series.errors),
        total(&series.throttles),
        total(&series.cold_starts)
    );
    context.out.result(&metrics, || {
        format!(
            "{}\n{summary}",
            table(
                &[
                    "TIME (UTC)",
                    "INVOCATIONS",
                    "ERRORS",
                    "THROTTLES",
                    "COLD",
                    "P50 MS",
                    "P95 MS",
                    "MAX MS",
                    "INSTANCES"
                ],
                &rows
            )
        )
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::config::{Endpoint, Files, Setting, Source};

    fn me(ids: &[&str]) -> Me {
        let accounts: Vec<Value> = ids
            .iter()
            .map(|id| serde_json::json!({ "id": id, "name": "A", "status": "active", "role": "owner", "plan": { "id": "beta", "name": "Beta" } }))
            .collect();
        serde_json::from_value(serde_json::json!({ "user": null, "accounts": accounts })).unwrap()
    }

    fn settings(account: Option<&str>) -> Settings {
        Settings {
            profile: Setting { value: "default".into(), source: Source::Default },
            endpoint: Setting { value: Endpoint::parse("https://api.ff.example").unwrap(), source: Source::Default },
            account: account.map(|value| Setting { value: value.into(), source: Source::Flag("--account") }),
            dev_account: None,
            token: None,
            allow_http: Setting { value: false, source: Source::Default },
            files: Files { dir: PathBuf::from("/tmp/ff") },
            warnings: Vec::new(),
        }
    }

    #[test]
    fn the_current_account_is_the_one_named_or_the_only_one() {
        assert_eq!(current(&me(&["111111111111"]), &settings(None)).unwrap().id, "111111111111");
        assert_eq!(
            current(&me(&["111111111111", "222222222222"]), &settings(Some("222222222222"))).unwrap().id,
            "222222222222"
        );
        assert!(
            current(&me(&["111111111111", "222222222222"]), &settings(None))
                .unwrap_err()
                .message
                .starts_with("This login has several accounts")
        );
        assert_eq!(
            current(&me(&["111111111111"]), &settings(Some("333333333333"))).unwrap_err().message,
            "You don't belong to account 333333333333 (from --account): `ff accounts` lists yours"
        );
    }

    #[test]
    fn a_plans_limits_read_as_sentences() {
        let limits = serde_json::json!({ "functions": 25, "memoryMb": 1024, "timeoutSeconds": 300, "idleSeconds": 900, "quota": { "pods": 20 } });

        assert_eq!(
            super::limits(limits.as_object().unwrap()),
            [
                "25 functions",
                "1024 MB of memory a function at most",
                "a timeout of 300 s at most",
                "scaled to zero after 15 min idle"
            ]
        );
    }

    #[test]
    fn a_month_is_yyyy_mm() {
        assert_eq!(month("2026-10").unwrap(), "2026-10");
        for wrong in ["2026-13", "2026-1", "26-10", "2026/10", "october"] {
            assert_eq!(month(wrong).unwrap_err().exit_code(), 2, "{wrong}");
        }
    }

    #[test]
    fn a_window_starts_its_duration_ago() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_569_600); // 2026-10-21T08:00:00Z

        assert_eq!(start_of("1h", now).unwrap(), "2026-10-21T07:00:00Z");
        assert_eq!(start_of("2d", now).unwrap(), "2026-10-19T08:00:00Z");
        assert_eq!(start_of("soon", now).unwrap_err().exit_code(), 2);
    }
}
