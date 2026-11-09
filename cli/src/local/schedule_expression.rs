//! EventBridge's schedule expressions, as its rules take them and SAM's Schedule events declare them: `rate(value
//! unit)` and `cron(minutes hours day-of-month month day-of-week year)`, in UTC, a minute the finest; and the next runs
//! of one. The backend's reader (`BE/src/schedules/schedule-expression.ts`) ported line for line, its messages word
//! for word, so that `ff local` takes and refuses what FF does, and runs a schedule when FF would. Its tests read the
//! backend's table, `BE/src/schedules/schedule-expressions.json`, which the backend's tests read too; the port was
//! compared with the backend's reader on 220,000 expressions made at random (`hack/spikes/schedule-expressions/`).
//! Times are Unix milliseconds.

use std::collections::BTreeSet;
use std::fmt;

use crate::dates::{civil_from_days, days_from_civil};

/// Unix milliseconds, UTC.
pub type Millis = i64;

const MINUTE_MS: Millis = 60_000;

/// The years EventBridge's cron takes.
pub const FIRST_YEAR: i64 = 1970;
pub const LAST_YEAR: i64 = 2199;

const MONTHS: [&str; 12] = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/// EventBridge's day-of-week: 1 is Sunday, 7 Saturday.
const DAYS: [&str; 7] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/// The largest whole number a JavaScript number holds exactly, which the backend's rate() takes at most.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// An expression EventBridge wouldn't take: the message says what is wrong in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidExpression(pub String);

impl fmt::Display for InvalidExpression {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InvalidExpression {}

fn fail<T>(message: impl Into<String>) -> Result<T, InvalidExpression> {
    Err(InvalidExpression(message.into()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateUnit {
    Minute,
    Hour,
    Day,
}

impl RateUnit {
    fn named(name: &str) -> Option<Self> {
        match name {
            "minute" => Some(RateUnit::Minute),
            "hour" => Some(RateUnit::Hour),
            "day" => Some(RateUnit::Day),
            _ => None,
        }
    }

    fn millis(self) -> Millis {
        match self {
            RateUnit::Minute => MINUTE_MS,
            RateUnit::Hour => 60 * MINUTE_MS,
            RateUnit::Day => 24 * 60 * MINUTE_MS,
        }
    }
}

/// The day of the month's rules: the days themselves, the last, the last weekday, the weekday nearest a day.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DayOfMonthRule {
    days: BTreeSet<u32>,
    last: bool,
    last_weekday: bool,
    nearest_weekday: Vec<u32>,
}

/// The day of the week's rules: the days themselves (1 Sunday to 7 Saturday), a day's last in the month, a day's nth.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DayOfWeekRule {
    days: BTreeSet<u32>,
    last_of: Vec<u32>,
    nth: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cron {
    minutes: BTreeSet<u32>,
    hours: BTreeSet<u32>,
    /// None when the day of the week decides ("?" here).
    day_of_month: Option<DayOfMonthRule>,
    months: BTreeSet<u32>,
    /// None when the day of the month decides ("?" here).
    day_of_week: Option<DayOfWeekRule>,
    years: BTreeSet<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expression {
    /// The interval in milliseconds, as wide as the backend's: up to its safe integers' days.
    Rate {
        value: u64,
        unit: RateUnit,
        interval_ms: i128,
    },
    Cron(Cron),
}

/// JavaScript's `\s`, which the backend's patterns split and trim by: wider than ASCII's, narrower than Unicode's.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// A string of digits as JavaScript's `Number()` reads it, and prints it back: `007` is 7, and past 21 digits an
/// exponent, `1e+21`, as the backend's messages show a value out of range.
fn js_number_text(digits: &str) -> String {
    let value: f64 = digits.parse().expect("digits");
    if value < 1e21 { format!("{value}") } else { format!("{value:e}").replacen('e', "e+", 1) }
}

/// A string of digits as a whole number, saturated: what is beyond u64 is beyond every range here.
fn saturating_number(digits: &str) -> u64 {
    digits.bytes().fold(0u64, |n, b| n.saturating_mul(10).saturating_add(u64::from(b - b'0')))
}

fn parse_rate(body: &str) -> Result<Expression, InvalidExpression> {
    const SHAPE: &str = "rate() takes a whole number and a unit, such as rate(5 minutes)";
    // `^\s*(\d+)\s+([a-z]+)\s*$`
    let body = body.trim_matches(js_space);
    let Some(split) = body.find(js_space) else { return fail(SHAPE) };
    let (digits, word) = (&body[..split], body[split..].trim_start_matches(js_space));
    if !all_digits(digits) || word.is_empty() || !word.bytes().all(|b| b.is_ascii_lowercase()) {
        return fail(SHAPE);
    }
    let value = saturating_number(digits);
    if !(1..=MAX_SAFE_INTEGER).contains(&value) {
        return fail("rate() takes a value of 1 or more");
    }
    let unit_name = word.strip_suffix('s').unwrap_or(word);
    let Some(unit) = RateUnit::named(unit_name) else {
        return fail(format!("rate() takes minute(s), hour(s) or day(s), not \"{word}\""));
    };
    // EventBridge's own rule: the unit is singular for 1, plural above.
    if value == 1 && word != unit_name {
        return fail(format!("rate(1 {word}) must be rate(1 {unit_name}): the unit is singular for 1"));
    }
    if value > 1 && word == unit_name {
        return fail(format!("rate({value} {word}) must be rate({value} {unit_name}s): the unit is plural above 1"));
    }
    Ok(Expression::Rate { value, unit, interval_ms: i128::from(value) * i128::from(unit.millis()) })
}

/// A field's value: a number in its range, or a name where the field takes names.
fn value_of(text: &str, field: &str, min: u32, max: u32, names: &[&str]) -> Result<u32, InvalidExpression> {
    let upper = text.to_uppercase();
    if let Some(named) = names.iter().position(|name| *name == upper) {
        return Ok(named as u32 + 1);
    }
    if !all_digits(text) {
        return fail(format!("cron(): \"{text}\" is not a value of the {field} field"));
    }
    let value = saturating_number(text);
    if value < u64::from(min) || value > u64::from(max) {
        return fail(format!("cron(): the {field} field takes {min} to {max}; got {}", js_number_text(text)));
    }
    Ok(value as u32)
}

/// A field's set of values: a list of items, each `*`, a value, a range `a-b` (wrapping around its end, as `FRI-MON` or
/// `20-2`), and each with a step `/n`.
fn values(text: &str, field: &str, min: u32, max: u32, names: &[&str]) -> Result<BTreeSet<u32>, InvalidExpression> {
    let mut result = BTreeSet::new();
    for item in text.split(',') {
        let mut parts = item.split('/');
        let range = parts.next().unwrap_or_default();
        let step_text = parts.next();
        if parts.next().is_some() || range.is_empty() || step_text == Some("") {
            return fail(format!("cron(): \"{item}\" is not an item of the {field} field"));
        }
        let step = match step_text {
            None => 1,
            Some(text) if all_digits(text) && saturating_number(text) >= 1 => saturating_number(text),
            Some(_) => return fail(format!("cron(): the step in \"{item}\" must be a whole number of 1 or more")),
        };
        let (from, to) = if range == "*" {
            (min, max)
        } else if range.contains('-') {
            let mut ends = range.split('-');
            let (a, b) = (ends.next().unwrap_or_default(), ends.next().unwrap_or_default());
            if ends.next().is_some() {
                return fail(format!("cron(): \"{item}\" is not a range of the {field} field"));
            }
            (value_of(a, field, min, max, names)?, value_of(b, field, min, max, names)?)
        } else {
            let from = value_of(range, field, min, max, names)?;
            // "5/15": from 5, every 15, to the field's end.
            (from, if step_text.is_none() { from } else { max })
        };
        let span = u64::from(if to >= from { to - from } else { max - from + 1 + to - min });
        let width = u64::from(max - min + 1);
        let mut offset = 0u64;
        while offset <= span {
            result.insert(((u64::from(from - min) + offset) % width) as u32 + min);
            offset = offset.saturating_add(step);
        }
    }
    Ok(result)
}

fn day_of_month_rule(text: &str) -> Result<DayOfMonthRule, InvalidExpression> {
    let mut rule = DayOfMonthRule::default();
    let mut plain = Vec::new();
    for item in text.split(',') {
        let upper = item.to_uppercase();
        if upper == "L" {
            rule.last = true;
        } else if upper == "LW" {
            rule.last_weekday = true;
        } else if let Some(day) = upper.strip_suffix('W').filter(|day| all_digits(day)) {
            rule.nearest_weekday.push(value_of(day, "day-of-month", 1, 31, &[])?);
        } else if upper.contains(['L', 'W']) {
            return fail(format!("cron(): \"{item}\" is not an item of the day-of-month field: L, LW and nW are"));
        } else {
            plain.push(item);
        }
    }
    if !plain.is_empty() {
        rule.days = values(&plain.join(","), "day-of-month", 1, 31, &[])?;
    }
    Ok(rule)
}

fn day_of_week_rule(text: &str) -> Result<DayOfWeekRule, InvalidExpression> {
    let mut rule = DayOfWeekRule::default();
    let mut plain = Vec::new();
    for item in text.split(',') {
        let upper = item.to_uppercase();
        let last_of = upper
            .strip_suffix('L')
            .filter(|day| !day.is_empty() && day.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()));
        if upper == "L" {
            rule.days.insert(7); // "L" alone: the week's last day, Saturday
        } else if let Some(day) = last_of {
            rule.last_of.push(value_of(day, "day-of-week", 1, 7, &DAYS)?);
        } else if upper.contains('#') {
            let mut parts = upper.split('#');
            let (day, n) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
            if parts.next().is_some() || !matches!(n, "1" | "2" | "3" | "4" | "5") {
                return fail(format!(
                    "cron(): \"{item}\" must be a day and its week in the month, 1 to 5, such as 2#1, the first Monday"
                ));
            }
            rule.nth.push((value_of(day, "day-of-week", 1, 7, &DAYS)?, n.parse().expect("1 to 5")));
        } else {
            plain.push(item);
        }
    }
    if !plain.is_empty() {
        rule.days.extend(values(&plain.join(","), "day-of-week", 1, 7, &DAYS)?);
    }
    Ok(rule)
}

fn parse_cron(body: &str) -> Result<Expression, InvalidExpression> {
    // JavaScript's `body.trim().split(/\s+/)`: an empty body is one empty field.
    let trimmed = body.trim_matches(js_space);
    let fields: Vec<&str> =
        if trimmed.is_empty() { vec![""] } else { trimmed.split(js_space).filter(|f| !f.is_empty()).collect() };
    let [minutes, hours, day_of_month, month, day_of_week, year] = fields[..] else {
        return fail(format!(
            "cron() takes six fields, minutes hours day-of-month month day-of-week year; got {}",
            fields.len()
        ));
    };
    for (name, text) in [("minutes", minutes), ("hours", hours), ("month", month), ("year", year)] {
        if text.contains('?') {
            return fail(format!(
                "cron(): the {name} field can't be \"?\": only the day-of-month or the day-of-week can"
            ));
        }
    }
    // EventBridge's rule: one of the two days is "?", the other decides.
    if (day_of_month == "?") == (day_of_week == "?") {
        return fail(
            "cron(): one of the day-of-month and day-of-week fields must be \"?\", and only one: the other says which days",
        );
    }
    Ok(Expression::Cron(Cron {
        minutes: values(minutes, "minutes", 0, 59, &[])?,
        hours: values(hours, "hours", 0, 23, &[])?,
        day_of_month: if day_of_month == "?" { None } else { Some(day_of_month_rule(day_of_month)?) },
        months: values(month, "month", 1, 12, &MONTHS)?,
        day_of_week: if day_of_week == "?" { None } else { Some(day_of_week_rule(day_of_week)?) },
        years: values(year, "year", FIRST_YEAR as u32, LAST_YEAR as u32, &[])?,
    }))
}

impl Expression {
    /// Reads an expression as EventBridge takes it, or says what is wrong in it.
    pub fn parse(text: &str) -> Result<Expression, InvalidExpression> {
        let text = text.trim_matches(js_space);
        let inside = |kind: &str| text.strip_prefix(kind).and_then(|rest| rest.strip_suffix(')'));
        if let Some(body) = inside("rate(") {
            parse_rate(body)
        } else if let Some(body) = inside("cron(") {
            parse_cron(body)
        } else {
            fail(
                "A schedule is rate(value unit), such as rate(5 minutes), or cron(minutes hours day-of-month month \
                 day-of-week year), such as cron(0 8 * * ? *)",
            )
        }
    }

    /// The next run strictly after `after`. A rate's runs are every interval from `anchor`, its first run's time, so a
    /// late run doesn't move them: the next is the first of them after `after`. A cron's, the first minute it names
    /// after. None when no run is left: a cron's past its years, and either's past 2199.
    pub fn next_run(&self, after: Millis, anchor: Option<Millis>) -> Option<Millis> {
        match self {
            Expression::Cron(cron) => cron.next_run(after),
            Expression::Rate { interval_ms, .. } => {
                let base = i128::from(anchor.unwrap_or(after));
                let steps = ((i128::from(after) - base).div_euclid(*interval_ms) + 1).max(1);
                let next = base + steps * interval_ms;
                (next < i128::from(end_ms())).then_some(next as Millis)
            }
        }
    }

    /// The next runs, as the backend's preview gives them: `count` of them at most.
    #[cfg(test)]
    pub fn next_runs(&self, after: Millis, count: usize) -> Vec<Millis> {
        let anchor = matches!(self, Expression::Rate { .. }).then_some(after);
        let mut runs = Vec::new();
        let mut from = after;
        while runs.len() < count {
            let Some(run) = self.next_run(from, anchor) else { break };
            runs.push(run);
            from = run;
        }
        runs
    }
}

impl Cron {
    fn day_matches(&self, year: i64, month: u32, day: u32) -> bool {
        if let Some(rule) = &self.day_of_month {
            return rule.days.contains(&day)
                || (rule.last && day == days_in_month(year, month))
                || (rule.last_weekday && day == last_weekday(year, month))
                || rule.nearest_weekday.iter().any(|&n| nearest_weekday(year, month, n) == Some(day));
        }
        let rule = self.day_of_week.as_ref().expect("one of the two days decides");
        let weekday = weekday_of(year, month, day);
        rule.days.contains(&weekday)
            || (rule.last_of.contains(&weekday) && day + 7 > days_in_month(year, month))
            || rule.nth.iter().any(|&(d, n)| d == weekday && day.div_ceil(7) == n)
    }

    /// The first run strictly after the time; None when there is none left, past its years.
    fn next_run(&self, after: Millis) -> Option<Millis> {
        let start = after.div_euclid(MINUTE_MS) * MINUTE_MS + MINUTE_MS;
        let (mut year, mut month, mut day) = civil_from_days(start.div_euclid(DAY_MS));
        let mut from_minute = (start.rem_euclid(DAY_MS) / MINUTE_MS) as u32;
        while year <= LAST_YEAR {
            if !u32::try_from(year).is_ok_and(|y| self.years.contains(&y)) {
                (year, month, day, from_minute) = (year + 1, 1, 1, 0);
                continue;
            }
            if !self.months.contains(&month) {
                (month, day, from_minute) = (month + 1, 1, 0);
                if month > 12 {
                    (year, month) = (year + 1, 1);
                }
                continue;
            }
            if self.day_matches(year, month, day) {
                for &hour in &self.hours {
                    for &minute in &self.minutes {
                        if hour * 60 + minute >= from_minute {
                            return Some(
                                days_from_civil(year, month, day) * DAY_MS + i64::from(hour * 60 + minute) * MINUTE_MS,
                            );
                        }
                    }
                }
            }
            (day, from_minute) = (day + 1, 0);
            if day > days_in_month(year, month) {
                (month, day) = (month + 1, 1);
                if month > 12 {
                    (year, month) = (year + 1, 1);
                }
            }
        }
        None
    }
}

const DAY_MS: Millis = 24 * 60 * MINUTE_MS;

/// The end of the last year cron takes: no schedule runs after it, a rate's no more than a cron's.
fn end_ms() -> Millis {
    days_from_civil(LAST_YEAR + 1, 1, 1) * DAY_MS
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// 1 Sunday to 7 Saturday, as EventBridge counts them; 1970-01-01 was a Thursday.
fn weekday_of(year: i64, month: u32, day: u32) -> u32 {
    (days_from_civil(year, month, day) + 4).rem_euclid(7) as u32 + 1
}

/// The weekday nearest a day of the month, within the month: "15W".
fn nearest_weekday(year: i64, month: u32, day: u32) -> Option<u32> {
    let last = days_in_month(year, month);
    if day > last {
        return None;
    }
    Some(match weekday_of(year, month, day) {
        7 if day == 1 => 3, // Saturday the 1st: Monday the 3rd, never the month before
        7 => day - 1,
        1 if day == last => day - 2, // Sunday the last: the Friday before, never the month after
        1 => day + 1,
        _ => day,
    })
}

fn last_weekday(year: i64, month: u32) -> u32 {
    let last = days_in_month(year, month);
    match weekday_of(year, month, last) {
        7 => last - 1,
        1 => last - 2,
        _ => last,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dates::iso;
    use serde_json::Value;
    use std::time::UNIX_EPOCH;

    /// The backend's table of expressions and next runs, which its L1 tests read too.
    const TABLE: &str = include_str!("../../../BE/src/schedules/schedule-expressions.json");

    fn table() -> Value {
        serde_json::from_str(TABLE).expect("the table is JSON")
    }

    /// humantime's reader, beside this one's calendar: two ways to the same time.
    fn at(text: &str) -> Millis {
        let time = humantime::parse_rfc3339(text).expect("an RFC 3339 time");
        time.duration_since(UNIX_EPOCH).expect("after 1970").as_millis() as Millis
    }

    fn text<'a>(value: &'a Value, key: &str) -> &'a str {
        value[key].as_str().unwrap_or_else(|| panic!("{key} in {value}"))
    }

    /// A case's expression, which the table says EventBridge takes.
    fn parse(case: &Value) -> Expression {
        Expression::parse(text(case, "expression")).unwrap_or_else(|error| panic!("{case}: {error}"))
    }

    #[test]
    fn the_rates_the_table_takes_and_their_intervals() {
        let table = table();
        let rates = table["rates"].as_array().expect("rates");
        for case in rates {
            let expression = parse(case);
            let Expression::Rate { interval_ms, .. } = expression else { panic!("{case}: not a rate") };
            assert_eq!(interval_ms, i128::from(case["intervalMs"].as_i64().expect("intervalMs")), "{case}");
        }
    }

    #[test]
    fn the_expressions_the_table_refuses_with_the_backends_words() {
        let table = table();
        let refused = table["refused"].as_array().expect("refused");
        let wrong: Vec<String> = refused
            .iter()
            .filter_map(|case| match Expression::parse(text(case, "expression")) {
                Err(InvalidExpression(message)) if message == text(case, "message") => None,
                other => Some(format!("{}: {other:?}", text(case, "expression"))),
            })
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    #[test]
    fn the_next_runs_the_table_gives() {
        let table = table();
        let mut wrong = Vec::new();
        let mut cases = 0;
        for test in table["runs"].as_array().expect("runs") {
            for case in test["cases"].as_array().expect("cases") {
                cases += 1;
                let expected: Vec<&str> =
                    case["runs"].as_array().expect("runs").iter().map(|run| run.as_str().expect("a time")).collect();
                let wanted = case["count"].as_u64().map_or(expected.len(), |count| count as usize);
                let expression = parse(case);
                let after = at(text(case, "after"));
                let runs: Vec<Millis> = match case["anchor"].as_str() {
                    None => expression.next_runs(after, wanted),
                    Some(anchor) => {
                        let mut runs = Vec::new();
                        let mut from = after;
                        while runs.len() < wanted {
                            let Some(run) = expression.next_run(from, Some(at(anchor))) else { break };
                            runs.push(run);
                            from = run;
                        }
                        runs
                    }
                };
                let found: Vec<String> = runs.iter().map(|&run| iso(run)).collect();
                if found != expected {
                    wrong.push(format!("{} after {}: {found:?}", text(case, "expression"), text(case, "after")));
                }
            }
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
        assert!(cases > 0, "the table has runs");
    }

    #[test]
    fn counts_weekdays_as_eventbridge_does() {
        assert_eq!(weekday_of(2026, 10, 23), 6, "2026-10-23 is a Friday");
        assert_eq!(weekday_of(2026, 10, 25), 1, "2026-10-25 is a Sunday");
    }

    #[test]
    fn javascripts_numbers_in_the_messages() {
        assert_eq!(js_number_text("007"), "7");
        assert_eq!(js_number_text("12345678901234567890"), "12345678901234567000");
        assert_eq!(js_number_text("1000000000000000000000"), "1e+21");
        assert_eq!(js_number_text("123456789012345678901234"), "1.2345678901234569e+23");
    }
}
