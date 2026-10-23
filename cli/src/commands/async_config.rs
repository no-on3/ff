//! `ff async-config <name>`: a function's settings for its calls that don't wait, as AWS
//! Lambda's EventInvokeConfig: shown; changed, what isn't given staying, as Lambda's
//! UpdateFunctionEventInvokeConfig does; or back to Lambda's defaults.

use serde_json::{Map, Value, json};

use super::Context;
use crate::api::types::function_named;
use crate::api::{Call, Client};
use crate::cli::AsyncConfigArgs;
use crate::error::{Error, Kind};

fn usage(message: impl Into<String>) -> Error {
    Error::new(Kind::Usage, message)
}

/// `--max-age 30m`: whole seconds, from a minute to 6 hours, as Lambda keeps a call.
pub fn max_age_seconds(text: &str) -> Result<u64, Error> {
    let duration = humantime::parse_duration(text)
        .map_err(|error| usage(format!("--max-age takes a duration such as 90s, 30m or 6h: {error}")))?;
    let seconds = duration.as_secs();
    if duration.subsec_nanos() != 0 || !(60..=21_600).contains(&seconds) {
        return Err(usage("--max-age must be whole seconds from 1m to 6h, as AWS Lambda keeps a call"));
    }
    Ok(seconds)
}

/// The function name a Lambda ARN ends with, `$LATEST` or not.
fn name_of(arn: &str) -> &str {
    arn.split_once(":function:").map(|(_, rest)| rest.split(':').next().unwrap_or(rest)).unwrap_or(arn)
}

/// How long a call is kept, in words: hours when it is whole hours, else minutes, else seconds.
fn kept(seconds: u64) -> String {
    match seconds {
        3600 => "1 hour".into(),
        s if s % 3600 == 0 => format!("{} hours", s / 3600),
        60 => "1 minute".into(),
        s if s % 60 == 0 => format!("{} minutes", s / 60),
        s => format!("{s} s"),
    }
}

/// The settings in a sentence, or Lambda's defaults when there are none.
pub fn text(name: &str, config: Option<&Value>) -> String {
    let number = |field: &str| config.and_then(|c| c.get(field)).and_then(Value::as_u64);
    let destination = |which: &str| {
        config.and_then(|c| c.pointer(&format!("/destinationConfig/{which}/destination"))).and_then(Value::as_str)
    };
    let retries = match number("maximumRetryAttempts").unwrap_or(2) {
        0 => "not retried",
        1 => "retried once",
        _ => "retried twice",
    };
    let mut sentence = format!(
        "{name}: a call that fails is {retries}, and kept {} at most",
        kept(number("maximumEventAgeInSeconds").unwrap_or(21_600))
    );
    let destinations: Vec<String> = [
        destination("onSuccess").map(|arn| format!("a call that succeeds goes on to {}", name_of(arn))),
        destination("onFailure").map(|arn| format!("one that fails for good to {}", name_of(arn))),
    ]
    .into_iter()
    .flatten()
    .collect();
    if destinations.is_empty() {
        sentence.push_str(", going nowhere once it ends");
    } else {
        sentence.push_str(&format!("; {}", destinations.join(", ")));
    }
    if config.is_none() {
        sentence.push_str(" (AWS Lambda's defaults)");
    }
    sentence
}

/// The settings there are, or none: a 404 is a function following Lambda's defaults.
fn current(client: &Client, id: &str) -> Result<Option<Value>, Error> {
    match client.json::<Value>(&Call::get(format!("/functions/{id}/event-invoke-config"))) {
        Ok(config) => Ok(Some(config)),
        Err(error) if error.status == Some(404) => Ok(None),
        Err(error) => Err(error),
    }
}

/// What the flags change, over the settings there are: the body of the API's PUT, which replaces them whole.
/// `max_age` is `--max-age`'s, in seconds, read first.
pub fn changed(config: Option<&Value>, args: &AsyncConfigArgs, max_age: Option<u64>) -> Value {
    let mut body = Map::new();
    let kept_value = |field: &str| config.and_then(|c| c.get(field)).filter(|v| !v.is_null()).cloned();
    if let Some(retries) = args.retries.map(Value::from).or_else(|| kept_value("maximumRetryAttempts")) {
        body.insert("maximumRetryAttempts".into(), retries);
    }
    let age = max_age.map(Value::from).or_else(|| kept_value("maximumEventAgeInSeconds"));
    if let Some(age) = age {
        body.insert("maximumEventAgeInSeconds".into(), age);
    }
    let mut destinations = Map::new();
    for (which, given, cleared) in
        [("onSuccess", &args.on_success, args.no_on_success), ("onFailure", &args.on_failure, args.no_on_failure)]
    {
        let now = config.and_then(|c| c.pointer(&format!("/destinationConfig/{which}/destination"))).cloned();
        let destination = if cleared { None } else { given.as_deref().map(Value::from).or(now) };
        if let Some(destination) = destination {
            destinations.insert(which.into(), json!({ "destination": destination }));
        }
    }
    if !destinations.is_empty() {
        body.insert("destinationConfig".into(), Value::Object(destinations));
    }
    Value::Object(body)
}

pub fn run(args: AsyncConfigArgs, context: &Context) -> Result<(), Error> {
    // Before any call: a wrong age changes nothing.
    let max_age = args.max_age.as_deref().map(max_age_seconds).transpose()?;
    let client = Client::new(&context.settings()?)?;
    let function = function_named(&client, &args.name)?;
    let path = format!("/functions/{}/event-invoke-config", function.id);
    let config = current(&client, &function.id)?;
    if args.reset {
        if config.is_some() {
            client.done(&Call::delete(path))?;
        }
        return context.out.result(&Value::Null, || text(&args.name, None));
    }
    let changes = args.retries.is_some()
        || args.max_age.is_some()
        || args.on_success.is_some()
        || args.on_failure.is_some()
        || args.no_on_success
        || args.no_on_failure;
    if !changes {
        return context.out.result(&config, || text(&args.name, config.as_ref()));
    }
    let body = changed(config.as_ref(), &args, max_age);
    let saved: Value = client.json(&Call::put(path, body))?;
    context.out.result(&saved, || text(&args.name, Some(&saved)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(
        retries: Option<u8>,
        max_age: Option<&str>,
        on_success: Option<&str>,
        no_on_failure: bool,
    ) -> AsyncConfigArgs {
        AsyncConfigArgs {
            name: "orders".into(),
            retries,
            max_age: max_age.map(Into::into),
            on_success: on_success.map(Into::into),
            no_on_success: false,
            on_failure: None,
            no_on_failure,
            reset: false,
        }
    }

    const ARN: &str = "arn:aws:lambda:tn-tunis-1:000000000001:function:failed-orders";

    #[test]
    fn a_maximum_age_is_whole_seconds_from_a_minute_to_six_hours() {
        assert_eq!(max_age_seconds("30m").unwrap(), 1800);
        assert_eq!(max_age_seconds("6h").unwrap(), 21_600);
        for refused in ["59s", "7h", "1.5s", "soon"] {
            assert_eq!(max_age_seconds(refused).unwrap_err().exit_code(), 2, "{refused}");
        }
    }

    #[test]
    fn a_change_keeps_what_it_does_not_give_as_lambdas_update_does() {
        let config = json!({ "maximumRetryAttempts": 0, "maximumEventAgeInSeconds": null,
                             "destinationConfig": { "onSuccess": {}, "onFailure": { "destination": ARN } } });

        assert_eq!(
            changed(Some(&config), &args(None, Some("1h"), Some("receipts"), false), Some(3600)),
            json!({ "maximumRetryAttempts": 0, "maximumEventAgeInSeconds": 3600,
                    "destinationConfig": { "onSuccess": { "destination": "receipts" }, "onFailure": { "destination": ARN } } })
        );
        assert_eq!(
            changed(Some(&config), &args(Some(2), None, None, true), None),
            json!({ "maximumRetryAttempts": 2 })
        );
        assert_eq!(changed(None, &args(Some(1), None, None, false), None), json!({ "maximumRetryAttempts": 1 }));
    }

    #[test]
    fn the_settings_read_as_a_sentence() {
        assert_eq!(
            text("orders", None),
            "orders: a call that fails is retried twice, and kept 6 hours at most, going nowhere once it ends (AWS Lambda's defaults)"
        );
        let config = json!({ "maximumRetryAttempts": 1, "maximumEventAgeInSeconds": 1800,
                             "destinationConfig": { "onSuccess": {}, "onFailure": { "destination": ARN } } });
        assert_eq!(
            text("orders", Some(&config)),
            "orders: a call that fails is retried once, and kept 30 minutes at most; one that fails for good to failed-orders"
        );
    }
}
