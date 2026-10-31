//! A template's YAML, written as CloudFormation reads it: each map in its own order, a string plain
//! only where YAML 1.1 reads it back as that string, and CloudFormation's short tags.

/// A value of a template, written in the order it is built.
#[derive(Clone, Debug, PartialEq)]
pub enum Yaml {
    Str(String),
    Int(i64),
    Bool(bool),
    List(Vec<Yaml>),
    Map(Vec<(String, Yaml)>),
    /// An intrinsic function in its short form, with its one argument: `!Ref Orders`.
    Tagged(&'static str, String),
}

impl Yaml {
    pub fn map<K: Into<String>>(entries: impl IntoIterator<Item = (K, Yaml)>) -> Yaml {
        Yaml::Map(entries.into_iter().map(|(key, value)| (key.into(), value)).collect())
    }

    pub fn list(items: impl IntoIterator<Item = Yaml>) -> Yaml {
        Yaml::List(items.into_iter().collect())
    }

    /// `!Ref`: a parameter's value, or what a resource's `Ref` gives, such as a bucket's name.
    pub fn reference(name: &str) -> Yaml {
        Yaml::Tagged("!Ref", name.to_owned())
    }

    /// `!GetAtt`: an attribute of a resource, such as a queue's `Arn`.
    pub fn attribute(resource: &str, attribute: &str) -> Yaml {
        Yaml::Tagged("!GetAtt", format!("{resource}.{attribute}"))
    }

    /// `!Sub`: a text with `${…}` filled in, such as an ARN in the stack's region and account.
    pub fn sub(text: impl Into<String>) -> Yaml {
        Yaml::Tagged("!Sub", text.into())
    }

    /// A JSON value as YAML, its objects' keys as they come; none for null, which a template leaves out.
    pub fn json(value: &serde_json::Value) -> Option<Yaml> {
        use serde_json::Value;
        Some(match value {
            Value::Null => return None,
            Value::Bool(value) => Yaml::Bool(*value),
            Value::Number(number) => number.as_i64().map_or_else(|| Yaml::Str(number.to_string()), Yaml::Int),
            Value::String(text) => Yaml::Str(text.clone()),
            Value::Array(items) => Yaml::List(items.iter().filter_map(Yaml::json).collect()),
            Value::Object(entries) => {
                Yaml::Map(entries.iter().filter_map(|(key, value)| Some((key.clone(), Yaml::json(value)?))).collect())
            }
        })
    }

    /// The value as a document: a map's entries one to a line, what they hold indented under them.
    pub fn document(&self) -> String {
        let mut out = String::new();
        match self {
            Yaml::Map(entries) if !entries.is_empty() => write_map(entries, 0, &mut out),
            Yaml::List(items) if !items.is_empty() => write_list(items, 0, &mut out),
            value => {
                out.push_str(&inline(value));
                out.push('\n');
            }
        }
        out
    }
}

impl From<&str> for Yaml {
    fn from(text: &str) -> Yaml {
        Yaml::Str(text.to_owned())
    }
}

impl From<String> for Yaml {
    fn from(text: String) -> Yaml {
        Yaml::Str(text)
    }
}

impl From<u32> for Yaml {
    fn from(number: u32) -> Yaml {
        Yaml::Int(number.into())
    }
}

impl From<u64> for Yaml {
    fn from(number: u64) -> Yaml {
        Yaml::Int(i64::try_from(number).unwrap_or(i64::MAX))
    }
}

impl From<bool> for Yaml {
    fn from(value: bool) -> Yaml {
        Yaml::Bool(value)
    }
}

fn indent(out: &mut String, columns: usize) {
    out.extend(std::iter::repeat_n(' ', columns));
}

fn write_map(entries: &[(String, Yaml)], column: usize, out: &mut String) {
    for (key, value) in entries {
        indent(out, column);
        out.push_str(&scalar(key));
        out.push(':');
        write_after(value, column + 2, out);
    }
}

/// A list's items each after its dash; a map's first entry on the dash's line, the others under it.
fn write_list(items: &[Yaml], column: usize, out: &mut String) {
    for item in items {
        indent(out, column);
        out.push('-');
        match item {
            Yaml::Map(entries) if !entries.is_empty() => {
                let (key, value) = &entries[0];
                out.push(' ');
                out.push_str(&scalar(key));
                out.push(':');
                write_after(value, column + 4, out);
                write_map(&entries[1..], column + 2, out);
            }
            value => write_after(value, column + 2, out),
        }
    }
}

/// What follows a key's colon or a dash: a scalar on the same line, a map or a list on the lines
/// after it, at `column`.
fn write_after(value: &Yaml, column: usize, out: &mut String) {
    match value {
        Yaml::Map(entries) if !entries.is_empty() => {
            out.push('\n');
            write_map(entries, column, out);
        }
        Yaml::List(items) if !items.is_empty() => {
            out.push('\n');
            write_list(items, column, out);
        }
        value => {
            out.push(' ');
            out.push_str(&inline(value));
            out.push('\n');
        }
    }
}

/// A value on one line: a scalar, a tag with its argument, or an empty map or list.
fn inline(value: &Yaml) -> String {
    match value {
        Yaml::Str(text) => scalar(text),
        Yaml::Int(number) => number.to_string(),
        Yaml::Bool(value) => value.to_string(),
        Yaml::Tagged(tag, argument) => format!("{tag} {}", scalar(argument)),
        Yaml::Map(_) => "{}".to_owned(),
        Yaml::List(_) => "[]".to_owned(),
    }
}

/// A string as YAML 1.1 reads it back: plain when it can be, else in single quotes, else, with a
/// line break or another control character, in double quotes with JSON's escapes, which are YAML's.
pub fn scalar(text: &str) -> String {
    if is_plain(text) {
        text.to_owned()
    } else if !text.chars().any(char::is_control) {
        format!("'{}'", text.replace('\'', "''"))
    } else {
        serde_json::to_string(text).expect("a string serializes")
    }
}

/// Whether YAML 1.1 reads the text unquoted as the string it is: a letter first, then letters,
/// digits, spaces and punctuation that means nothing there, no colon before a space or at the end,
/// and none of YAML 1.1's words for true, false and null, which it reads in any case.
fn is_plain(text: &str) -> bool {
    const WORDS: [&str; 9] = ["y", "n", "yes", "no", "true", "false", "on", "off", "null"];
    text.starts_with(|first: char| first.is_ascii_alphabetic())
        && text.chars().all(|c| c.is_ascii_alphanumeric() || " -_./:*@(),?+=".contains(c))
        && !text.ends_with([' ', ':'])
        && !text.contains(": ")
        && !WORDS.contains(&text.to_ascii_lowercase().as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_string_is_plain_only_where_yaml_1_1_reads_it_back_as_that_string() {
        for plain in
            ["photos", "send-receipts", "AWS::Serverless-2016-10-31", "s3:ObjectCreated:*", "cron(0 2 * * ? *)"]
        {
            assert_eq!(scalar(plain), plain);
        }
        assert_eq!(scalar("orders@shop.tn"), "orders@shop.tn");
        assert_eq!(scalar("Sends each order's receipt"), "'Sends each order''s receipt'");
        // YAML 1.1's booleans and null, a date, a number, octal, base 60: each would be read as another type.
        for quoted in ["yes", "No", "ON", "off", "y", "null", "2010-09-09", "128", "0755", "1:30", ".inf"] {
            assert_eq!(scalar(quoted), format!("'{quoted}'"));
        }
        // What a colon, a tag, a comment or braces would change, and the empty string.
        for quoted in ["Name: value", "trailing:", "!Ref", "#comment", "${AWS::Region}", "", " padded"] {
            assert_eq!(scalar(quoted), format!("'{quoted}'"));
        }
        assert_eq!(scalar("{\"name\": \"Tunis\"}"), "'{\"name\": \"Tunis\"}'");
        assert_eq!(scalar("two\nlines\t"), "\"two\\nlines\\t\"");
    }

    #[test]
    fn a_document_keeps_its_order_and_nests_maps_and_lists_by_two_spaces() {
        let document = Yaml::map([
            ("AWSTemplateFormatVersion", Yaml::from("2010-09-09")),
            (
                "Resources",
                Yaml::map([(
                    "Orders",
                    Yaml::map([
                        ("Type", Yaml::from("AWS::SQS::Queue")),
                        ("Properties", Yaml::map([("VisibilityTimeout", Yaml::from(60u32)), ("Tags", Yaml::list([]))])),
                    ]),
                )]),
            ),
            (
                "Policies",
                Yaml::list([
                    Yaml::map([
                        ("SQSPollerPolicy", Yaml::map([("QueueName", Yaml::attribute("Orders", "QueueName"))])),
                        ("Note", Yaml::from(true)),
                    ]),
                    Yaml::from("AWSLambdaBasicExecutionRole"),
                    Yaml::list([Yaml::from(1u32), Yaml::from(2u32)]),
                ]),
            ),
            ("Empty", Yaml::map(Vec::<(String, Yaml)>::new())),
            ("Arn", Yaml::sub("arn:aws:sqs:${AWS::Region}:${AWS::AccountId}:orders")),
            ("Bucket", Yaml::reference("PhotosBucket")),
        ]);

        assert_eq!(
            document.document(),
            "AWSTemplateFormatVersion: '2010-09-09'\n\
             Resources:\n  Orders:\n    Type: AWS::SQS::Queue\n    Properties:\n      VisibilityTimeout: 60\n      Tags: []\n\
             Policies:\n  - SQSPollerPolicy:\n      QueueName: !GetAtt Orders.QueueName\n    Note: true\n  \
             - AWSLambdaBasicExecutionRole\n  -\n    - 1\n    - 2\n\
             Empty: {}\n\
             Arn: !Sub 'arn:aws:sqs:${AWS::Region}:${AWS::AccountId}:orders'\n\
             Bucket: !Ref PhotosBucket\n"
        );
    }
}
