//! Times as S3 and SQS write them, from the system's clock, without a date crate.

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as i64).unwrap_or_default()
}

/// The day of days since 1970-01-01, as (year, month, day) (Howard Hinnant's civil_from_days).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

fn parts(millis: i64) -> (i64, i64, i64, i64, i64, i64, i64) {
    let (days, rest) = (millis.div_euclid(86_400_000), millis.rem_euclid(86_400_000));
    let (year, month, day) = civil_from_days(days);
    (year, month, day, rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000)
}

/// As ListObjectsV2's LastModified: 2026-11-08T21:05:09.123Z.
pub fn iso8601(millis: i64) -> String {
    let (year, month, day, hour, minute, second, milli) = parts(millis);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// As a Last-Modified header, RFC 9110's date: Sun, 08 Nov 2026 21:05:09 GMT.
pub fn http_date(millis: i64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (year, month, day, hour, minute, second, _) = parts(millis);
    let weekday = DAYS[millis.div_euclid(86_400_000).rem_euclid(7) as usize];
    format!("{weekday}, {day:02} {} {year:04} {hour:02}:{minute:02}:{second:02} GMT", MONTHS[month as usize - 1])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sigv4::signed_time;

    #[test]
    fn writes_a_time_as_s3_does_and_reads_back_its_signed_form() {
        let millis = signed_time("20261108T210509Z").unwrap() * 1000 + 123;
        assert_eq!(iso8601(millis), "2026-11-08T21:05:09.123Z");
        assert_eq!(http_date(millis), "Sun, 08 Nov 2026 21:05:09 GMT");
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(http_date(951_782_400_000), "Tue, 29 Feb 2000 00:00:00 GMT");
    }
}
