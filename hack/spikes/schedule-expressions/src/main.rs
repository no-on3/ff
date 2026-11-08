//! The spike's command, for run.sh's comparison with the backend's reader: each line of its input is a time in Unix
//! milliseconds, a count and an expression, separated by tabs, the expression last; each line of its output, that
//! expression's next runs after the time in Unix milliseconds, or its refusal.
use schedule_expressions_spike::{Expression, InvalidExpression};
use std::io::{BufRead, BufWriter, Write};

fn main() {
    let mut out = BufWriter::new(std::io::stdout().lock());
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("a line of input");
        let mut parts = line.splitn(3, '\t');
        let (Some(after), Some(count), Some(text)) = (parts.next(), parts.next(), parts.next()) else {
            panic!("not <after>\\t<count>\\t<expression>: {line}");
        };
        let (after, count) = (after.parse().expect("a time"), count.parse().expect("a count"));
        match Expression::parse(text) {
            Ok(expression) => {
                let runs: Vec<String> = expression.next_runs(after, count).iter().map(i64::to_string).collect();
                writeln!(out, "runs: {}", runs.join(" "))
            }
            Err(InvalidExpression(message)) => writeln!(out, "refused: {message}"),
        }
        .expect("written");
    }
}
