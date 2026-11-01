//! Text for people: columns that line up, and times as they read.

/// Rows under their headers, each column as wide as its widest cell, two spaces apart; the last
/// column isn't padded.
pub fn table(headers: &[&str], rows: &[Vec<String>]) -> String {
    let columns = headers.len();
    let mut widths: Vec<usize> = headers.iter().map(|header| header.chars().count()).collect();
    for row in rows {
        for (index, cell) in row.iter().enumerate().take(columns) {
            widths[index] = widths[index].max(cell.chars().count());
        }
    }
    let line = |cells: Vec<&str>| {
        let mut text = String::new();
        for (index, cell) in cells.iter().enumerate() {
            if index + 1 == cells.len() {
                text.push_str(cell);
            } else {
                text.push_str(&format!("{cell:<width$}  ", width = widths[index]));
            }
        }
        text.trim_end().to_owned()
    };
    let mut lines = vec![line(headers.to_vec())];
    lines.extend(rows.iter().map(|row| line(row.iter().map(String::as_str).collect())));
    lines.join("\n")
}

/// Rows under their headers as a Markdown table, the columns after the first aligned right, as
/// amounts are.
pub fn markdown_table(headers: &[String], rows: &[Vec<String>]) -> String {
    let line = |cells: &[String]| {
        format!("| {} |\n", cells.iter().map(|cell| cell.replace('|', "\\|")).collect::<Vec<_>>().join(" | "))
    };
    let mut text = line(headers);
    text.push_str(&format!("|---|{}\n", "---:|".repeat(headers.len().saturating_sub(1))));
    for row in rows {
        text.push_str(&line(row));
    }
    text
}

/// An API's time, `2026-10-21T09:15:03.123Z`, as `2026-10-21 09:15:03`, in UTC as it was.
pub fn time(iso: &str) -> String {
    iso.get(..19).map(|text| text.replacen('T', " ", 1)).unwrap_or_else(|| iso.to_owned())
}

/// The first line of a text, cut to `max` characters with an ellipsis.
pub fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().next().unwrap_or("");
    if line.chars().count() > max {
        format!("{}…", line.chars().take(max - 1).collect::<String>())
    } else {
        line.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_line_up_under_their_headers() {
        let rows = vec![
            vec!["hello".to_owned(), "nodejs".to_owned(), "ACTIVE".to_owned()],
            vec!["a".to_owned(), "python".to_owned(), "ERROR".to_owned()],
        ];

        assert_eq!(
            table(&["NAME", "RUNTIME", "STATUS"], &rows),
            "NAME   RUNTIME  STATUS\nhello  nodejs   ACTIVE\na      python   ERROR"
        );
        assert_eq!(table(&["NAME", "STATUS"], &[]), "NAME  STATUS");
    }

    #[test]
    fn times_and_errors_read_short() {
        assert_eq!(time("2026-10-21T09:15:03.123Z"), "2026-10-21 09:15:03");
        assert_eq!(time("soon"), "soon");
        assert_eq!(first_line("Error: boom\n    at handler", 40), "Error: boom");
        assert_eq!(first_line("x".repeat(50).as_str(), 10), "xxxxxxxxx…");
    }
}
