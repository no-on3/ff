//! Dates without a date crate: the proleptic Gregorian calendar (Howard Hinnant's `days_from_civil` and
//! `civil_from_days`), and times in Unix milliseconds written as AWS writes them: ISO 8601, to the second as
//! EventBridge's events and SQS's held messages have them, or to the millisecond as S3's documents do, and HTTP's date,
//! as S3's Last-Modified header.

const DAY_MS: i64 = 86_400_000;
const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// Days since 1970-01-01 of a date.
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The date of a day since 1970-01-01: its year, month and day.
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 } as u32;
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

/// A time's date, and its hours, minutes, seconds and milliseconds.
fn parts(millis: i64) -> ((i64, u32, u32), i64, i64, i64, i64) {
    let rest = millis.rem_euclid(DAY_MS);
    (civil_from_days(millis.div_euclid(DAY_MS)), rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000)
}

/// 2026-10-23T06:00:00Z, as the backend's API prints a time.
pub fn iso(millis: i64) -> String {
    let ((year, month, day), hour, minute, second, _) = parts(millis);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// 2026-10-23T06:00:00.123Z, as S3's documents write a time.
pub fn iso_millis(millis: i64) -> String {
    let ((year, month, day), hour, minute, second, milli) = parts(millis);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// Fri, 23 Oct 2026 06:00:00 GMT, HTTP's date (RFC 9110), as S3's Last-Modified header writes a time.
pub fn http_date(millis: i64) -> String {
    let ((year, month, day), hour, minute, second, _) = parts(millis);
    let weekday = WEEKDAYS[millis.div_euclid(DAY_MS).rem_euclid(7) as usize];
    format!("{weekday}, {day:02} {} {year:04} {hour:02}:{minute:02}:{second:02} GMT", MONTHS[month as usize - 1])
}

/// A time HTTP's date writes, back in milliseconds; None for any other text. Only RFC 9110's preferred form is read.
pub fn read_http_date(text: &str) -> Option<i64> {
    let (_, rest) = text.trim().split_once(", ")?;
    let fields: Vec<&str> = rest.split(' ').collect();
    let [day, month, year, time, "GMT"] = fields.as_slice() else { return None };
    let month = MONTHS.iter().position(|name| name == month)? as u32 + 1;
    let number = |text: &str| text.bytes().all(|byte| byte.is_ascii_digit()).then(|| text.parse::<i64>().ok())?;
    let clock: Vec<i64> = time.split(':').map(number).collect::<Option<_>>()?;
    let [hour, minute, second] = clock.as_slice() else { return None };
    let (year, day) = (number(year)?, u32::try_from(number(day)?).ok()?);
    let days = days_from_civil(year, month, day);
    (civil_from_days(days) == (year, month, day) && *hour < 24 && *minute < 60 && *second < 60)
        .then(|| days * DAY_MS + (hour * 3600 + minute * 60 + second) * 1000)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    #[test]
    fn the_calendar_agrees_with_humantimes_every_day_from_1970_to_2200() {
        let end = days_from_civil(2200, 1, 1);
        for days in 0..end {
            let (year, month, day) = civil_from_days(days);
            assert_eq!(days_from_civil(year, month, day), days);
            let millis = days * DAY_MS + 45_296_789; // 12:34:56.789
            let at = UNIX_EPOCH + Duration::from_millis(millis as u64);
            assert_eq!(iso(millis), humantime::format_rfc3339_seconds(at).to_string());
            assert_eq!(iso_millis(millis), humantime::format_rfc3339_millis(at).to_string());
            assert_eq!(read_http_date(&http_date(millis)), Some(millis - 789));
        }
    }

    #[test]
    fn writes_http_s_date_and_reads_only_it_back() {
        assert_eq!(http_date(1_792_735_200_123), "Fri, 23 Oct 2026 06:00:00 GMT");
        assert_eq!(http_date(951_782_400_000), "Tue, 29 Feb 2000 00:00:00 GMT");
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        for other in
            ["Friday, 23-Oct-26 06:00:00 GMT", "Fri, 30 Feb 2026 06:00:00 GMT", "Fri, 23 Oct 2026 24:00:00 GMT", ""]
        {
            assert_eq!(read_http_date(other), None, "{other}");
        }
    }
}
