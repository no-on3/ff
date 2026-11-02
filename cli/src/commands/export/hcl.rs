//! The export's Terraform, written as `tofu fmt` leaves HCL: two spaces a level, the `=` of the
//! attributes on consecutive lines aligned, a block's labels quoted, a string with HCL's escapes,
//! references and calls as they are written.

/// A value of an attribute.
#[derive(Clone, Debug, PartialEq)]
pub enum Hcl {
    Str(String),
    Int(i64),
    Bool(bool),
    List(Vec<Hcl>),
    /// An object, `{ key = value }`, its keys in the order given.
    Object(Vec<(String, Hcl)>),
    /// An expression as it is written: a reference, `aws_sqs_queue.orders.arn`, a template,
    /// `"${aws_s3_bucket.photos.arn}/*"`, or a call.
    Expr(String),
    /// A call of a function with one argument: `filebase64sha256("…")`, `jsonencode({ … })`.
    Call(&'static str, Box<Hcl>),
}

impl Hcl {
    pub fn object<K: Into<String>>(entries: impl IntoIterator<Item = (K, Hcl)>) -> Hcl {
        Hcl::Object(entries.into_iter().map(|(key, value)| (key.into(), value)).collect())
    }

    pub fn list(items: impl IntoIterator<Item = Hcl>) -> Hcl {
        Hcl::List(items.into_iter().collect())
    }

    /// A reference to what another resource, a variable or a data source gives.
    pub fn reference(path: impl Into<String>) -> Hcl {
        Hcl::Expr(path.into())
    }

    /// A string with references in it, `"${aws_s3_bucket.photos.arn}/*"`: its `${…}` kept, where a
    /// string's are escaped; a name in it from elsewhere goes through `literal` first.
    pub fn template(text: &str) -> Hcl {
        Hcl::Expr(format!("\"{}\"", escaped(text, false)))
    }

    pub fn call(name: &'static str, argument: Hcl) -> Hcl {
        Hcl::Call(name, Box::new(argument))
    }

    /// A JSON value as HCL, its objects' keys as they come; none for null, which a file leaves out.
    pub fn json(value: &serde_json::Value) -> Option<Hcl> {
        use serde_json::Value;
        Some(match value {
            Value::Null => return None,
            Value::Bool(value) => Hcl::Bool(*value),
            Value::Number(number) => number.as_i64().map_or_else(|| Hcl::Expr(number.to_string()), Hcl::Int),
            Value::String(text) => Hcl::Str(text.clone()),
            Value::Array(items) => Hcl::List(items.iter().filter_map(Hcl::json).collect()),
            Value::Object(entries) => {
                Hcl::Object(entries.iter().filter_map(|(key, value)| Some((key.clone(), Hcl::json(value)?))).collect())
            }
        })
    }

    /// Whether the value is written on its key's line.
    fn single_line(&self) -> bool {
        match self {
            Hcl::List(items) => {
                items.iter().all(|item| matches!(item, Hcl::Str(_) | Hcl::Int(_) | Hcl::Bool(_) | Hcl::Expr(_)))
            }
            Hcl::Object(entries) => entries.is_empty(),
            Hcl::Call(_, argument) => argument.single_line(),
            _ => true,
        }
    }
}

impl From<&str> for Hcl {
    fn from(text: &str) -> Hcl {
        Hcl::Str(text.to_owned())
    }
}

impl From<String> for Hcl {
    fn from(text: String) -> Hcl {
        Hcl::Str(text)
    }
}

impl From<u32> for Hcl {
    fn from(number: u32) -> Hcl {
        Hcl::Int(number.into())
    }
}

impl From<u64> for Hcl {
    fn from(number: u64) -> Hcl {
        Hcl::Int(i64::try_from(number).unwrap_or(i64::MAX))
    }
}

impl From<bool> for Hcl {
    fn from(value: bool) -> Hcl {
        Hcl::Bool(value)
    }
}

/// What a block holds, in the order it is written.
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Attribute(String, Hcl),
    Block(Block),
}

/// A block: its type, its labels, and its body: `resource "aws_sqs_queue" "orders" { … }`.
#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    kind: String,
    labels: Vec<String>,
    body: Vec<Item>,
}

impl Block {
    pub fn new(kind: &str, labels: &[&str]) -> Block {
        Block {
            kind: kind.to_owned(),
            labels: labels.iter().map(|label| (*label).to_owned()).collect(),
            body: Vec::new(),
        }
    }

    pub fn attribute(mut self, name: &str, value: impl Into<Hcl>) -> Block {
        self.body.push(Item::Attribute(name.to_owned(), value.into()));
        self
    }

    pub fn block(mut self, block: Block) -> Block {
        self.body.push(Item::Block(block));
        self
    }
}

/// A file of blocks, a line left empty between each.
pub fn file(blocks: &[Block]) -> String {
    let mut out = String::new();
    for (at, block) in blocks.iter().enumerate() {
        if at > 0 {
            out.push('\n');
        }
        write_block(block, 0, &mut out);
    }
    out
}

fn indent(out: &mut String, level: usize) {
    out.extend(std::iter::repeat_n(' ', level * 2));
}

fn write_block(block: &Block, level: usize, out: &mut String) {
    indent(out, level);
    out.push_str(&block.kind);
    for label in &block.labels {
        out.push(' ');
        out.push_str(&quoted(label));
    }
    if block.body.is_empty() {
        out.push_str(" {}\n");
        return;
    }
    out.push_str(" {\n");
    let entries: Vec<Entry> = block
        .body
        .iter()
        .map(|item| match item {
            Item::Attribute(name, value) => Entry::Pair(name.clone(), value),
            Item::Block(block) => Entry::Block(block),
        })
        .collect();
    write_entries(&entries, level + 1, out);
    indent(out, level);
    out.push_str("}\n");
}

/// A line of a body or of an object: a key and its value, or a block.
enum Entry<'a> {
    Pair(String, &'a Hcl),
    Block(&'a Block),
}

/// The entries one to a line, each run of keys whose values fit on their line with its `=` under
/// the run's longest key, as `tofu fmt` aligns them; a value over several lines ends a run.
fn write_entries(entries: &[Entry], level: usize, out: &mut String) {
    let mut at = 0;
    while at < entries.len() {
        match &entries[at] {
            Entry::Block(block) => {
                write_block(block, level, out);
                at += 1;
            }
            Entry::Pair(_, value) if value.single_line() => {
                let run: Vec<(&String, &Hcl)> = entries[at..]
                    .iter()
                    .map_while(|entry| match entry {
                        Entry::Pair(key, value) if value.single_line() => Some((key, *value)),
                        _ => None,
                    })
                    .collect();
                let width = run.iter().map(|(key, _)| key_text(key).chars().count()).max().unwrap_or(0);
                for (key, value) in &run {
                    indent(out, level);
                    out.push_str(&format!("{:width$} = ", key_text(key)));
                    write_value(value, level, out);
                    out.push('\n');
                }
                at += run.len();
            }
            Entry::Pair(key, value) => {
                indent(out, level);
                out.push_str(&format!("{} = ", key_text(key)));
                write_value(value, level, out);
                out.push('\n');
                at += 1;
            }
        }
    }
}

/// A key as HCL takes it: bare when it is a name of letters, digits and `_`, quoted otherwise, as
/// a variable's `cost-centre` or a condition's `aws:SourceArn` are.
fn key_text(key: &str) -> String {
    let mut chars = key.chars();
    let bare = chars.next().is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if bare { key.to_owned() } else { quoted(key) }
}

/// A value after its `=`, the lines it takes indented under its key's.
fn write_value(value: &Hcl, level: usize, out: &mut String) {
    match value {
        Hcl::Str(text) => out.push_str(&quoted(text)),
        Hcl::Int(number) => out.push_str(&number.to_string()),
        Hcl::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Hcl::Expr(expression) => out.push_str(expression),
        Hcl::List(items) if value.single_line() => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push_str(", ");
                }
                write_value(item, level, out);
            }
            out.push(']');
        }
        Hcl::List(items) => {
            out.push_str("[\n");
            for item in items {
                indent(out, level + 1);
                write_value(item, level + 1, out);
                out.push_str(",\n");
            }
            indent(out, level);
            out.push(']');
        }
        Hcl::Object(entries) if entries.is_empty() => out.push_str("{}"),
        Hcl::Object(entries) => {
            out.push_str("{\n");
            let entries: Vec<Entry> = entries.iter().map(|(key, value)| Entry::Pair(key.clone(), value)).collect();
            write_entries(&entries, level + 1, out);
            indent(out, level);
            out.push('}');
        }
        Hcl::Call(name, argument) => {
            out.push_str(name);
            out.push('(');
            write_value(argument, level, out);
            out.push(')');
        }
    }
}

/// A name for a template, its `${` and `%{` doubled, so that the template doesn't read them.
pub fn literal(text: &str) -> String {
    text.replace("${", "$${").replace("%{", "%%{")
}

/// A string in HCL's quotes, `${` and `%{` doubled, so that it is never a template.
fn quoted(text: &str) -> String {
    format!("\"{}\"", escaped(text, true))
}

/// The text with HCL's escapes, its templates' openings doubled or kept.
fn escaped(text: &str, literal: bool) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '$' | '%' if literal && chars.peek() == Some(&'{') => {
                out.push(c);
                out.push(c);
            }
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_body_aligns_each_run_of_attributes_on_one_line_as_tofu_fmt_does() {
        let queue = Block::new("resource", &["aws_sqs_queue", "orders"])
            .attribute("name", "orders")
            .attribute("visibility_timeout_seconds", 60_u32)
            .attribute(
                "redrive_policy",
                Hcl::call(
                    "jsonencode",
                    Hcl::object([
                        ("deadLetterTargetArn", Hcl::reference("aws_sqs_queue.orders_dlq.arn")),
                        ("maxReceiveCount", Hcl::from(5_u32)),
                    ]),
                ),
            )
            .attribute("delay_seconds", 0_u32)
            .block(Block::new("scaling_config", &[]).attribute("maximum_concurrency", 5_u32))
            .attribute("tags", Hcl::object([("team", Hcl::from("shop")), ("cost-centre", Hcl::from("42"))]));
        let account = Block::new("data", &["aws_caller_identity", "current"]);

        // A value over several lines, or a block, ends a run; a key HCL wouldn't take bare is quoted.
        assert_eq!(
            file(&[queue, account]),
            r#"resource "aws_sqs_queue" "orders" {
  name                       = "orders"
  visibility_timeout_seconds = 60
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.orders_dlq.arn
    maxReceiveCount     = 5
  })
  delay_seconds = 0
  scaling_config {
    maximum_concurrency = 5
  }
  tags = {
    team          = "shop"
    "cost-centre" = "42"
  }
}

data "aws_caller_identity" "current" {}
"#
        );
    }

    #[test]
    fn lists_of_names_go_on_one_line_and_lists_of_objects_on_theirs() {
        let notification = Block::new("resource", &["aws_s3_bucket_notification", "photos"])
            .attribute("events", Hcl::list([Hcl::from("s3:ObjectCreated:*"), Hcl::from("s3:ObjectRemoved:*")]))
            .attribute("depends_on", Hcl::list([Hcl::reference("aws_lambda_permission.photos")]))
            .attribute(
                "rules",
                Hcl::list([Hcl::object([("prefix", Hcl::from("in/"))]), Hcl::object([("suffix", Hcl::from(".jpg"))])]),
            )
            .attribute("empty", Hcl::list([]));

        assert_eq!(
            file(&[notification]),
            r#"resource "aws_s3_bucket_notification" "photos" {
  events     = ["s3:ObjectCreated:*", "s3:ObjectRemoved:*"]
  depends_on = [aws_lambda_permission.photos]
  rules = [
    {
      prefix = "in/"
    },
    {
      suffix = ".jpg"
    },
  ]
  empty = []
}
"#
        );
    }

    #[test]
    fn a_string_is_never_a_template_but_when_asked_and_its_escapes_are_hcls() {
        let variable = Block::new("variable", &["note"])
            .attribute("default", "say \"hi\" to ${name}, 100%{ x }\\n\tend\n")
            .attribute("arn", Hcl::template("${aws_s3_bucket.photos.arn}/*"))
            .attribute("hash", Hcl::call("filebase64sha256", Hcl::template("${path.module}/../code/a.zip")))
            .attribute("identity", Hcl::template(&format!("identity/{}", literal("a${b}@shop.tn"))));

        assert_eq!(
            file(&[variable]),
            r#"variable "note" {
  default  = "say \"hi\" to $${name}, 100%%{ x }\\n\tend\n"
  arn      = "${aws_s3_bucket.photos.arn}/*"
  hash     = filebase64sha256("${path.module}/../code/a.zip")
  identity = "identity/a$${b}@shop.tn"
}
"#
        );
    }

    #[test]
    fn json_becomes_hcl_its_nulls_left_out() {
        let input =
            json!({ "report": true, "days": 7, "ratio": 0.5, "skip": null, "names": ["a", 1], "by": { "day": "mon" } });

        assert_eq!(
            Hcl::json(&input),
            Some(Hcl::object([
                ("by", Hcl::object([("day", Hcl::from("mon"))])),
                ("days", Hcl::Int(7)),
                ("names", Hcl::list([Hcl::from("a"), Hcl::Int(1)])),
                ("ratio", Hcl::Expr("0.5".to_owned())),
                ("report", Hcl::Bool(true)),
            ]))
        );
        assert_eq!(Hcl::json(&json!(null)), None);
    }
}
