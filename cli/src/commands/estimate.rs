//! The last months at AWS's prices, an estimate, as `GET /usage/aws-estimate` gives them: `ff usage
//! --aws` shows them, and `ff export` writes them in `cost-estimate.md`.

use serde::{Deserialize, Serialize};

use crate::api::Call;
use crate::error::Error;

/// What AWS bills that FF doesn't, a line each, as the API names them: the lines `--without` leaves
/// out of the totals.
pub const EXTRA_LINES: [&str; 7] =
    ["coldStarts", "databaseInstances", "cacheNodes", "dataOut", "logs", "cloudFront", "natGateway"];

/// The last months at AWS's prices, oldest first, this one so far last.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsEstimate {
    /// The currency of every amount but the US$ ones: the price book's.
    pub currency: String,
    /// The book's US$ rate: the currency's units per US$.
    pub usd_rate: String,
    pub usd_rate_date: Option<String>,
    /// AWS's region whose prices these are.
    pub region: String,
    /// The first and the last day FF read AWS's prices on.
    pub prices_read_on: Vec<String>,
    pub price_book: String,
    pub months: Vec<Month>,
}

/// A month at AWS's prices, from what FF counted.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Month {
    pub month: String,
    /// This month's: up to when; none for a month that is over.
    pub until: Option<String>,
    pub requests: u64,
    pub lines: Vec<Line>,
    /// Every line not left out, in US$.
    pub total_usd: String,
    /// The same in the book's currency.
    pub total: String,
    /// The same month at FF's prices; none without a price book for it.
    pub ff_total: Option<String>,
}

/// A line of a month: one of FF's counts, or one of what AWS bills that FF doesn't.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub line: String,
    /// What it is, as AWS bills it.
    pub label: String,
    /// In US$, to the cent.
    pub usd: String,
    /// In the book's currency.
    pub amount: String,
    /// Of what AWS bills that FF doesn't.
    pub extra: bool,
    pub left_out: bool,
    /// What a line of what AWS bills that FF doesn't assumes.
    pub assumption: Option<String>,
}

/// The call for the last `months` months, the API's three without, the lines `without` names left
/// out of the totals: refused before calling for a line the API has none of.
pub fn call(months: Option<u32>, without: &[String]) -> Result<Call, Error> {
    if let Some(unknown) = without.iter().find(|line| !EXTRA_LINES.contains(&line.as_str())) {
        return Err(Error::usage(format!(
            "\"{unknown}\" is no line of what AWS bills that FF doesn't: {}",
            EXTRA_LINES.join(", ")
        )));
    }
    let mut call = Call::get("/usage/aws-estimate");
    if let Some(months) = months {
        call = call.query("months", months);
    }
    if !without.is_empty() {
        call = call.query("without", without.join(","));
    }
    Ok(call)
}

impl AwsEstimate {
    /// What it is priced with, in a sentence's words.
    pub fn priced_with(&self) -> String {
        let read = match self.prices_read_on.as_slice() {
            [first, last] if first != last => format!(" from {first} to {last}"),
            [day, ..] => format!(" on {day}"),
            [] => String::new(),
        };
        let rate_of = self.usd_rate_date.as_ref().map(|day| format!(", the rate of {day}")).unwrap_or_default();
        format!(
            "what FF counted, at AWS's US$ list prices in {}, as FF read them{read}, with the free tier AWS gives every \
             account every month; in {currency} at {} {currency} a US${rate_of}",
            self.region,
            self.usd_rate,
            currency = self.currency
        )
    }

    /// Its table, a column a month: each line in US$, those of what AWS bills that FF doesn't named
    /// as `--without` takes them; then the totals, in US$ and in the book's currency, and the same
    /// months at FF's prices.
    pub fn table(&self) -> (Vec<String>, Vec<Vec<String>>) {
        let mut headers = vec!["US$".to_owned()];
        headers.extend(self.months.iter().map(|month| match month.until {
            Some(_) => format!("{} so far", month.month),
            None => month.month.clone(),
        }));
        let row = |name: String, cell: &dyn Fn(&Month) -> String| {
            let mut row = vec![name];
            row.extend(self.months.iter().map(cell));
            row
        };
        let lines = self.months.first().map(|month| month.lines.as_slice()).unwrap_or_default();
        let mut rows: Vec<Vec<String>> = lines
            .iter()
            .map(|line| {
                let name = match (line.extra, line.left_out) {
                    (false, _) => line.label.clone(),
                    (true, false) => format!("{} ({})", line.label, line.line),
                    (true, true) => format!("{} ({}, left out)", line.label, line.line),
                };
                row(name, &|month| {
                    month
                        .lines
                        .iter()
                        .find(|other| other.line == line.line)
                        .map(|other| other.usd.clone())
                        .unwrap_or_default()
                })
            })
            .collect();
        rows.push(row("total".to_owned(), &|month| month.total_usd.clone()));
        rows.push(row(format!("total in {}", self.currency), &|month| month.total.clone()));
        rows.push(row(format!("at FF's prices, in {}", self.currency), &|month| {
            month.ff_total.clone().unwrap_or_else(|| "-".to_owned())
        }));
        (headers, rows)
    }

    /// Each line of what AWS bills that FF doesn't, as `(name, label, what it assumes)`, the name
    /// as `--without` takes it.
    pub fn assumptions(&self) -> Vec<(&str, &str, &str)> {
        let lines = self.months.first().map(|month| month.lines.as_slice()).unwrap_or_default();
        lines
            .iter()
            .filter_map(|line| Some((line.line.as_str(), line.label.as_str(), line.assumption.as_deref()?)))
            .collect()
    }
}

#[cfg(test)]
pub mod tests {
    use clap::Parser;
    use serde_json::{Value, json};

    use super::*;
    use crate::backend_source::{class_fields, listed, sorted, sorted_keys};

    const DTO: &str = include_str!("../../../BE/src/usage/usage.dto.ts");

    /// Two months as the API gives them, the second this one so far, the NAT gateway left out.
    pub fn estimate() -> AwsEstimate {
        let lines = [
            ("functions", "AWS Lambda: requests and duration", ["0.83", "0.00"], None),
            ("mail", "SES: recipients and attachments", ["0.00", "0.30"], None),
            (
                "cacheNodes",
                "ElastiCache for Valkey: a cache.t4g.micro for each cache",
                ["0.00", "1.28"],
                Some("The smallest node, for each cache's hours"),
            ),
            (
                "natGateway",
                "A NAT gateway",
                ["37.20", "5.00"],
                Some("One, for each hour the account had a database or a cache"),
            ),
        ];
        let month = |index: usize, month: &str, until: Option<&str>, totals: [&str; 3]| {
            let lines: Vec<Value> = lines
                .iter()
                .map(|(line, label, usd, assumption)| {
                    json!({ "line": line, "label": label, "usd": usd[index], "amount": "0.000", "extra": assumption.is_some(),
                            "leftOut": *line == "natGateway", "assumption": assumption })
                })
                .collect();
            json!({ "month": month, "until": until, "requests": 50 - 50 * index, "lines": lines,
                    "totalUsd": totals[0], "total": totals[1], "ffTotal": (!totals[2].is_empty()).then_some(totals[2]) })
        };
        serde_json::from_value(json!({
            "currency": "TND", "usdRate": "3.0080", "usdRateDate": "2026-10-14", "region": "us-east-1",
            "pricesReadOn": ["2026-10-17", "2026-10-31"], "priceBook": "pb1",
            "months": [month(0, "2026-10", None, ["0.83", "2.497", "4.901"]),
                       month(1, "2026-11", Some("2026-11-01T10:00:00.000Z"), ["1.58", "4.753", ""])] }))
        .unwrap()
    }

    #[test]
    fn what_ff_reads_has_the_apis_fields() {
        let estimate = estimate();
        assert_eq!(sorted_keys(&estimate), sorted(class_fields(DTO, "AwsEstimateView")));
        assert_eq!(sorted_keys(&estimate.months[0]), sorted(class_fields(DTO, "AwsEstimateMonthView")));
        assert_eq!(sorted_keys(&estimate.months[0].lines[0]), sorted(class_fields(DTO, "AwsEstimateLineView")));
    }

    #[test]
    fn the_lines_to_leave_out_and_the_most_months_are_the_apis() {
        assert_eq!(listed(include_str!("../../../BE/src/billing/aws-estimate.ts"), "EXTRA_LINES"), EXTRA_LINES);
        let most =
            DTO.split("export const MAX_ESTIMATE_MONTHS = ").nth(1).and_then(|rest| rest.split(';').next()).unwrap();
        let parse =
            |months: &str| crate::cli::Cli::try_parse_from(["ff", "usage", "--aws", "--months", months]).is_ok();
        assert!(parse(most) && parse("1"), "1 to {most}");
        assert!(!parse(&(most.parse::<u32>().unwrap() + 1).to_string()) && !parse("0"));
    }

    #[test]
    fn a_line_the_api_has_none_of_is_refused_before_calling() {
        let error = call(Some(2), &["natGateway".into(), "lambda".into()]).err().unwrap();
        assert_eq!(error.exit_code(), 2);
        assert!(
            error.message.starts_with("\"lambda\" is no line of what AWS bills that FF doesn't: coldStarts, "),
            "{}",
            error.message
        );
        assert!(call(None, &["natGateway".into(), "logs".into()]).is_ok());
    }

    #[test]
    fn the_table_has_a_column_a_month_each_line_then_the_totals() {
        let (headers, rows) = estimate().table();
        assert_eq!(headers, ["US$", "2026-10", "2026-11 so far"]);
        assert_eq!(
            rows,
            [
                ["AWS Lambda: requests and duration", "0.83", "0.00"],
                ["SES: recipients and attachments", "0.00", "0.30"],
                ["ElastiCache for Valkey: a cache.t4g.micro for each cache (cacheNodes)", "0.00", "1.28"],
                ["A NAT gateway (natGateway, left out)", "37.20", "5.00"],
                ["total", "0.83", "1.58"],
                ["total in TND", "2.497", "4.753"],
                ["at FF's prices, in TND", "4.901", "-"],
            ]
        );
        assert_eq!(
            estimate().assumptions(),
            [
                (
                    "cacheNodes",
                    "ElastiCache for Valkey: a cache.t4g.micro for each cache",
                    "The smallest node, for each cache's hours"
                ),
                ("natGateway", "A NAT gateway", "One, for each hour the account had a database or a cache"),
            ]
        );
    }

    #[test]
    fn the_prices_say_where_from_and_when_they_were_read() {
        let mut estimate = estimate();
        assert_eq!(
            estimate.priced_with(),
            "what FF counted, at AWS's US$ list prices in us-east-1, as FF read them from 2026-10-17 to 2026-10-31, \
             with the free tier AWS gives every account every month; in TND at 3.0080 TND a US$, the rate of 2026-10-14"
        );
        estimate.prices_read_on = vec!["2026-10-31".into(), "2026-10-31".into()];
        estimate.usd_rate_date = None;
        assert!(estimate.priced_with().contains("as FF read them on 2026-10-31, with"), "{}", estimate.priced_with());
        assert!(estimate.priced_with().ends_with("in TND at 3.0080 TND a US$"), "{}", estimate.priced_with());
    }
}
