//! ISO 8601 instants as OKF v0.2 writes them (§5): the ONE datetime grammar
//! for every surface — the trust line, provenance lint, lifecycle staleness
//! (over wasm, `src/lib/wasm/exports.ts`) and the native render (ADR 0006).
//!
//! The grammar: `YYYY-MM-DD`, `T` or `t`, `HH:MM`, an optional `:SS` with an
//! optional `.` or `,` fraction (dropped: second resolution), then `Z`/`z` or
//! `±HH`, `±HHMM`, `±HH:MM`. Calendar-checked; hour ≤ 23, second ≤ 60 (a leap
//! second reads as the next second's instant). Surrounding whitespace is
//! trimmed. A space separator is not ISO 8601 here and reads as nothing.
//!
//! Two entry points over it:
//!
//! - [`epoch_seconds`] / [`is_iso_datetime`]: the strict form the spec
//!   requires, offset mandatory. Lint and the trust check use it.
//! - [`instant_seconds`]: the forms ov-11 tolerates for staleness ("displays
//!   rather than errors", `docs/okf/concept.md`): the same grammar with the
//!   offset optional, read as UTC, plus a bare date, read as midnight UTC.

/// Whether `s` is an ISO 8601 datetime with an explicit UTC offset:
/// `YYYY-MM-DDTHH:MM[:SS[.fff]]` then `Z` or `±HH:MM` (also `±HHMM`, `±HH`).
pub fn is_iso_datetime(s: &str) -> bool {
    epoch_seconds(s).is_some()
}

/// `s` as seconds since the Unix epoch, when it is [`is_iso_datetime`].
pub fn epoch_seconds(s: &str) -> Option<i64> {
    parse(s, false)
}

/// `s` as seconds since the Unix epoch, read leniently for staleness: what
/// [`epoch_seconds`] reads, plus the same datetime with no offset (UTC) and a
/// bare `YYYY-MM-DD` (midnight UTC).
pub fn instant_seconds(s: &str) -> Option<i64> {
    parse(s, true)
}

fn parse(s: &str, lenient: bool) -> Option<i64> {
    let b = s.trim().as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        part.iter().all(u8::is_ascii_digit).then(|| part.iter().fold(0i64, |n, d| n * 10 + i64::from(d - b'0')))
    };
    let at = |i: usize, c: u8| b.get(i) == Some(&c);
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if !(at(4, b'-') && at(7, b'-')) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut offset) = (0, 0, 0, 0);
    if !(lenient && b.len() == 10) {
        if !(at(10, b'T') || at(10, b't')) {
            return None;
        }
        hour = num(11, 2)?;
        minute = num(14, 2)?;
        if !at(13, b':') {
            return None;
        }
        let mut i = 16;
        if at(i, b':') {
            second = num(i + 1, 2)?;
            i += 3;
            if at(i, b'.') || at(i, b',') {
                i += 1;
                let start = i;
                while b.get(i).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                }
                if i == start {
                    return None;
                }
            }
        }
        offset = match b.get(i) {
            None if lenient => 0,
            None => return None,
            Some(b'Z' | b'z') if i + 1 == b.len() => 0,
            Some(sign @ (b'+' | b'-')) => {
                let oh = num(i + 1, 2)?;
                let om = match b.len() - (i + 3) {
                    0 => 0,
                    2 => num(i + 3, 2)?,
                    3 if at(i + 3, b':') => num(i + 4, 2)?,
                    _ => return None,
                };
                if oh > 23 || om > 59 {
                    return None;
                }
                let o = oh * 3600 + om * 60;
                if *sign == b'-' { -o } else { o }
            }
            _ => return None,
        };
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&month) || day < 1 || day > days_in[(month - 1) as usize] {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-09-23T00:00:00Z.
    const AT: i64 = 1_790_121_600;

    #[test]
    fn iso_datetimes() {
        for ok in [
            "2026-06-20T22:53:05Z",
            "2026-06-20T22:53Z",
            "2026-06-20T22:53:05.123Z",
            "2026-06-20T22:53:05,5Z",
            "2026-06-20T22:53:05+00:00",
            "2026-06-20T22:53:05-0530",
            "2026-06-20T22:53:05+02",
            "2026-06-20t22:53:05z",
            "2026-12-31T23:59:60Z",
            "2024-02-29T00:00:00Z",
            "  2026-06-20T22:53:05Z  ",
        ] {
            assert!(is_iso_datetime(ok), "{ok}");
        }
        for bad in [
            "",
            "2026-06-20",
            "2026-06-20T22:53:05",
            "2026-06-20 22:53:05Z",
            "2026-06-20 10:30Z",
            "2026-13-01T00:00:00Z",
            "2026-02-29T00:00:00Z",
            "2026-02-30T00:00:00Z",
            "2026-06-20T24:00:00Z",
            "2026-06-20T25:00Z",
            "2026-06-20T22:53:61Z",
            "2026-06-20T22:53:05.Z",
            "2026-06-20T22:53:05+2",
            "2026-06-20T22:53:05+24:00",
            "2026-06-20T22:53:05Zjunk",
            "23.09.2026",
            "2026",
            "yesterday",
        ] {
            assert!(!is_iso_datetime(bad), "{bad}");
        }
    }

    #[test]
    fn epoch_seconds_honours_the_offset() {
        assert_eq!(epoch_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(epoch_seconds("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(epoch_seconds("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert_eq!(epoch_seconds("2026-09-23T00:00:00Z"), Some(AT));
        assert_eq!(epoch_seconds("2026-09-23T02:00:00+02:00"), Some(AT));
        assert_eq!(epoch_seconds("2026-09-23T02:00:00+0200"), Some(AT));
        assert_eq!(epoch_seconds("2026-09-23T02:00:00+02"), Some(AT));
        assert_eq!(epoch_seconds("2026-09-22T19:00:00-0500"), Some(AT));
        assert_eq!(epoch_seconds("2026-09-23t00:00:00z"), Some(AT));
        assert_eq!(epoch_seconds("2026-09-23T10:30Z"), Some(AT + 10 * 3600 + 30 * 60));
    }

    #[test]
    fn fractions_are_dropped_and_a_leap_second_is_the_next_second() {
        assert_eq!(epoch_seconds("2026-09-23T00:00:00.250Z"), Some(AT));
        assert_eq!(epoch_seconds("2026-09-23T00:00:00,5Z"), Some(AT));
        assert_eq!(epoch_seconds("2026-09-22T23:59:60Z"), Some(AT));
    }

    #[test]
    fn instant_seconds_reads_everything_epoch_seconds_does() {
        for s in [
            "2026-09-23T00:00:00Z",
            "2026-09-23T02:00:00+02",
            "2026-09-23T02:00:00+0200",
            "2026-09-23T00:00:00,5Z",
            "2026-09-22T23:59:60Z",
            "2026-09-23t00:00:00z",
        ] {
            assert_eq!(instant_seconds(s), epoch_seconds(s), "{s}");
            assert_eq!(instant_seconds(s), Some(AT), "{s}");
        }
    }

    #[test]
    fn instant_seconds_reads_no_offset_and_a_bare_date_as_utc() {
        assert_eq!(instant_seconds("2026-09-23T00:00:00"), Some(AT));
        assert_eq!(instant_seconds("2026-09-23T00:00"), Some(AT));
        assert_eq!(instant_seconds("2026-09-23T00:00:00.5"), Some(AT));
        assert_eq!(instant_seconds("2026-09-23"), Some(AT));
        assert_eq!(instant_seconds("  2026-09-23  "), Some(AT));
        assert_eq!(epoch_seconds("2026-09-23T00:00:00"), None);
        assert_eq!(epoch_seconds("2026-09-23"), None);
    }

    #[test]
    fn instant_seconds_rejects_what_is_not_a_date() {
        for bad in [
            "",
            "soon",
            "2026",
            "2026-13-01",
            "2026-02-30",
            "2026-02-30T00:00:00Z",
            "2026-09-23T24:00:00Z",
            "2026-09-23T25:00Z",
            "2026-09-23T00:00:00+2",
            "2026-09-23 10:30Z",
            "2026-09-23 10:30",
            "2026-09-23T",
            "23.09.2026",
        ] {
            assert_eq!(instant_seconds(bad), None, "{bad}");
        }
    }
}
