//! A SAM template's YAML read as CloudFormation reads it, for `ff deploy`: each short tag made the long form it
//! stands for (`!Ref A` is `{"Ref": "A"}`, `!GetAtt A.B` is `{"Fn::GetAtt": ["A", "B"]}`, `!Sub …` is
//! `{"Fn::Sub": …}`), a plain scalar typed as YAML 1.1 types it, which CloudFormation follows (`yes` a boolean,
//! `0755` an octal number), and where each value starts kept under its JSON pointer, for messages that name the
//! line. What CloudFormation doesn't take is refused, each at its line: a tag it doesn't have, an alias, a merge, the
//! binary, omap, pairs, set and timestamp tags; and a key given twice, a key that isn't a scalar, a second document.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::{Map, Number, Value};
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// Where a value starts in the file: its line and its column, both from 1. A tagged scalar's column is its text's,
/// after the tag: yaml-rust2's events carry no position of a tag's own, and the line is the tag's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct At {
    pub line: usize,
    pub column: usize,
}

impl From<Marker> for At {
    fn from(mark: Marker) -> Self {
        At { line: mark.line(), column: mark.col() + 1 }
    }
}

/// A template read: its value as JSON, and where each of its values starts, by JSON pointer ("" for the whole).
#[derive(Debug)]
pub struct Template {
    pub value: Value,
    pub at: BTreeMap<String, At>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Error {
    pub at: At,
    pub message: String,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "line {}, column {}: {}", self.at.line, self.at.column, self.message)
    }
}

impl std::error::Error for Error {}

/// CloudFormation's short tags but `!Ref` and `!Condition`, each `Fn::` and its name in the long form.
const FUNCTIONS: [&str; 16] = [
    "And",
    "Base64",
    "Cidr",
    "Equals",
    "FindInMap",
    "GetAtt",
    "GetAZs",
    "If",
    "ImportValue",
    "Join",
    "Not",
    "Or",
    "Select",
    "Split",
    "Sub",
    "Transform",
];

pub fn read(text: &str) -> Result<Template, Error> {
    let mut builder = Builder::default();
    Parser::new_from_str(text)
        .load(&mut builder, true)
        .map_err(|error| Error { at: (*error.marker()).into(), message: error.info().to_string() })?;
    if let Some(error) = builder.error {
        return Err(error);
    }
    Ok(Template { value: builder.root.unwrap_or(Value::Null), at: builder.at })
}

/// A tagged value in its long form; a tag CloudFormation doesn't have refused.
fn long_form(tag: &Tag, value: Value, at: At) -> Result<Value, Error> {
    let name = short_tag(tag, at)?;
    let key = match name {
        "Ref" | "Condition" => name.to_string(),
        _ => format!("Fn::{name}"),
    };
    let value = match (name, value) {
        // !GetAtt's short form is one string: the resource, and its attribute after the first dot.
        ("GetAtt", Value::String(text)) => match text.split_once('.') {
            Some((resource, attribute)) => Value::Array(vec![resource.into(), attribute.into()]),
            None => {
                return Err(Error {
                    at,
                    message: format!("!GetAtt {text}: a resource and its attribute, as Resource.Attribute"),
                });
            }
        },
        (_, value) => value,
    };
    Ok(Value::Object(Map::from_iter([(key, value)])))
}

fn short_tag(tag: &Tag, at: At) -> Result<&str, Error> {
    if tag.handle == "!"
        && (tag.suffix == "Ref" || tag.suffix == "Condition" || FUNCTIONS.contains(&tag.suffix.as_str()))
    {
        return Ok(&tag.suffix);
    }
    Err(Error {
        at,
        message: format!(
            "{}{}: not one of CloudFormation's tags, which are !Ref, !Condition, !{}",
            tag.handle,
            tag.suffix,
            FUNCTIONS.join(", !")
        ),
    })
}

/// YAML's own tags, `!!name`: the parser gives their handle as written, or resolved.
fn is_yaml_tag(tag: &Tag) -> bool {
    tag.handle == "!!" || tag.handle == "tag:yaml.org,2002:"
}

/// A plain scalar's type, as YAML 1.1's resolver gives it, which CloudFormation follows (PyYAML's, as cfn-flip and
/// the SAM CLI read templates): null, a boolean, an integer, a number with a point, else a string; a date stays a
/// string, CloudFormation having no timestamps. None for infinity and NaN, which JSON can't hold.
fn plain(text: &str) -> Option<Value> {
    Some(match text {
        "" | "~" | "null" | "Null" | "NULL" => Value::Null,
        "yes" | "Yes" | "YES" | "true" | "True" | "TRUE" | "on" | "On" | "ON" => Value::Bool(true),
        "no" | "No" | "NO" | "false" | "False" | "FALSE" | "off" | "Off" | "OFF" => Value::Bool(false),
        _ => {
            if let Some(n) = yaml_1_1_int(text) {
                Value::Number(n.into())
            } else if let Some(n) = yaml_1_1_float(text) {
                return Number::from_f64(n).map(Value::Number);
            } else {
                Value::String(text.to_string())
            }
        }
    })
}

/// The sign, and what follows it.
fn signed(text: &str) -> (i64, &str) {
    match text.as_bytes().first() {
        Some(b'-') => (-1, &text[1..]),
        Some(b'+') => (1, &text[1..]),
        _ => (1, text),
    }
}

fn all(text: &str, allowed: impl Fn(u8) -> bool) -> bool {
    !text.is_empty() && text.bytes().all(allowed)
}

/// YAML 1.1's integers: 0b binary, 0 octal, decimal, 0x hexadecimal, and base 60 (1:30 is 90), `_` anywhere after
/// the first digit.
fn yaml_1_1_int(text: &str) -> Option<i64> {
    let (sign, rest) = signed(text);
    let digits = |s: &str| s.replace('_', "");
    let value = if let Some(binary) = rest.strip_prefix("0b").filter(|b| all(b, |c| matches!(c, b'0' | b'1' | b'_'))) {
        i64::from_str_radix(&digits(binary), 2).ok()?
    } else if let Some(hex) = rest.strip_prefix("0x").filter(|h| all(h, |c| c.is_ascii_hexdigit() || c == b'_')) {
        i64::from_str_radix(&digits(hex), 16).ok()?
    } else if rest == "0" {
        0
    } else if let Some(octal) = rest.strip_prefix('0').filter(|o| all(o, |c| matches!(c, b'0'..=b'7' | b'_'))) {
        i64::from_str_radix(&digits(octal), 8).ok()?
    } else if rest.starts_with(|c: char| c.is_ascii_digit() && c != '0')
        && all(rest, |c| c.is_ascii_digit() || c == b'_')
    {
        digits(rest).parse().ok()?
    } else if rest.starts_with(|c: char| c.is_ascii_digit() && c != '0') && rest.contains(':') {
        let mut parts = rest.split(':');
        let first = parts.next()?;
        if !all(first, |c| c.is_ascii_digit() || c == b'_') {
            return None;
        }
        let mut value: i64 = digits(first).parse().ok()?;
        for part in parts {
            // [0-5]?[0-9]
            if part.is_empty()
                || part.len() > 2
                || !all(part, |c| c.is_ascii_digit())
                || (part.len() == 2 && part.as_bytes()[0] > b'5')
            {
                return None;
            }
            value = value.checked_mul(60)?.checked_add(part.parse::<i64>().ok()?)?;
        }
        value
    } else {
        return None;
    };
    value.checked_mul(sign)
}

/// YAML 1.1's numbers with a point: an exponent only after a point and with its sign (1.0e+5, but 1e5 and 1.0e5
/// are strings), base 60 (1:30.5 is 90.5), infinity and NaN; `_` anywhere after the first digit. The text, its `_`
/// taken out, is read as Python's float() reads it: Rust's parser rounds the same, correctly.
fn yaml_1_1_float(text: &str) -> Option<f64> {
    match text {
        ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => return Some(f64::INFINITY),
        "-.inf" | "-.Inf" | "-.INF" => return Some(f64::NEG_INFINITY),
        ".nan" | ".NaN" | ".NAN" => return Some(f64::NAN),
        _ => {}
    }
    let (sign, rest) = signed(text);
    let digits_or_underscores = |part: &str| part.bytes().all(|c| c.is_ascii_digit() || c == b'_');
    if rest.contains(':') {
        // [-+]?[0-9][0-9_]*(:[0-5]?[0-9])+\.[0-9_]*: each part a digit in base 60, the last with its fraction
        let parts: Vec<&str> = rest.split(':').collect();
        let (last, middle) = parts[1..].split_last()?;
        let (seconds, fraction) = last.split_once('.')?;
        let base60 = |part: &str| {
            !part.is_empty()
                && part.len() <= 2
                && all(part, |c| c.is_ascii_digit())
                && !(part.len() == 2 && part.as_bytes()[0] > b'5')
        };
        let well_formed = parts[0].starts_with(|c: char| c.is_ascii_digit())
            && digits_or_underscores(parts[0])
            && middle.iter().all(|part| base60(part))
            && base60(seconds)
            && digits_or_underscores(fraction);
        if !well_formed {
            return None;
        }
        let mut value = 0.0;
        for part in &parts[..parts.len() - 1] {
            value = value * 60.0 + part.replace('_', "").parse::<f64>().ok()?;
        }
        value = value * 60.0 + last.replace('_', "").parse::<f64>().ok()?;
        return Some(value * sign as f64);
    }
    let (mantissa, exponent) = match rest.find(['e', 'E']) {
        Some(at) => (&rest[..at], Some(&rest[at + 1..])),
        None => (rest, None),
    };
    // [eE][-+][0-9]+
    if exponent.is_some_and(|e| !(e.starts_with(['-', '+']) && all(&e[1..], |c| c.is_ascii_digit()))) {
        return None;
    }
    let (whole, fraction) = mantissa.split_once('.')?;
    let shape = if whole.is_empty() {
        // \.[0-9_]+, with no sign
        rest.len() == text.len() && !fraction.is_empty() && digits_or_underscores(fraction)
    } else {
        // [-+]?[0-9][0-9_]*\.[0-9_]*
        whole.starts_with(|c: char| c.is_ascii_digit())
            && digits_or_underscores(whole)
            && digits_or_underscores(fraction)
    };
    if !shape {
        return None;
    }
    text.replace('_', "").parse::<f64>().ok()
}

enum Frame {
    Sequence { items: Vec<Value>, tag: Option<Tag>, at: At },
    Mapping { map: Map<String, Value>, key: Option<String>, tag: Option<Tag>, at: At },
}

#[derive(Default)]
struct Builder {
    stack: Vec<(Frame, String)>,
    at: BTreeMap<String, At>,
    root: Option<Value>,
    documents: usize,
    error: Option<Error>,
}

/// A key in a JSON pointer, its ~ and / escaped.
fn pointer_key(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

impl Builder {
    fn fail(&mut self, at: At, message: impl Into<String>) {
        self.error.get_or_insert(Error { at, message: message.into() });
    }

    /// Whether the mapping on top waits for a key: the next scalar is one.
    fn wants_key(&self) -> bool {
        matches!(self.stack.last(), Some((Frame::Mapping { key: None, .. }, _)))
    }

    /// The pointer of the next value: under the key the mapping on top waits a value for, or at the sequence's end.
    fn next_pointer(&self) -> String {
        match self.stack.last() {
            None => String::new(),
            Some((Frame::Mapping { key, .. }, pointer)) => {
                format!("{pointer}/{}", pointer_key(key.as_deref().unwrap_or("")))
            }
            Some((Frame::Sequence { items, .. }, pointer)) => format!("{pointer}/{}", items.len()),
        }
    }

    fn add(&mut self, value: Value) {
        match self.stack.last_mut() {
            None => self.root = Some(value),
            Some((Frame::Mapping { map, key, .. }, _)) => {
                map.insert(key.take().unwrap_or_default(), value);
            }
            Some((Frame::Sequence { items, .. }, _)) => items.push(value),
        }
    }

    fn scalar(&mut self, text: String, style: TScalarStyle, tag: Option<Tag>, at: At) {
        if self.wants_key() {
            if tag.is_some() {
                return self.fail(at, format!("{text}: a key with a tag"));
            }
            if text == "<<" && style == TScalarStyle::Plain {
                return self
                    .fail(at, "a merge (<<): CloudFormation doesn't take YAML's merges, so each key is written out");
            }
            let Some((Frame::Mapping { map, key, .. }, _)) = self.stack.last_mut() else { unreachable!() };
            if map.contains_key(&text) {
                return self.fail(at, format!("{text}: a key given twice in the same mapping"));
            }
            *key = Some(text);
            return;
        }
        let pointer = self.next_pointer();
        self.at.insert(pointer, at);
        let value = match &tag {
            Some(tag) if is_yaml_tag(tag) => match tag.suffix.as_str() {
                // !!str: a string, whatever it looks like.
                "str" => Value::String(text),
                "binary" | "omap" | "pairs" | "set" | "timestamp" => {
                    return self
                        .fail(at, format!("!!{}: CloudFormation doesn't take YAML's {} tag", tag.suffix, tag.suffix));
                }
                _ => {
                    return self.fail(
                        at,
                        format!(
                            "!!{}: a YAML tag this reader doesn't take; the value without it reads the same",
                            tag.suffix
                        ),
                    );
                }
            },
            // A short tag's scalar is a string: !Ref's name, !Sub's text.
            Some(tag) => match long_form(tag, Value::String(text), at) {
                Ok(value) => value,
                Err(error) => return self.fail(error.at, error.message),
            },
            None if style == TScalarStyle::Plain => match plain(&text) {
                Some(value) => value,
                None => {
                    return self.fail(
                        at,
                        format!("{text}: a number JSON can't hold, which CloudFormation's JSON can't either"),
                    );
                }
            },
            None => Value::String(text),
        };
        self.add(value);
    }

    fn start(&mut self, frame: Frame, at: At) {
        if self.wants_key() {
            return self.fail(at, "a key that is a mapping or a sequence: a key is a name");
        }
        let pointer = self.next_pointer();
        self.at.insert(pointer.clone(), at);
        self.stack.push((frame, pointer));
    }

    fn end(&mut self) {
        let Some((frame, _)) = self.stack.pop() else { return };
        let (value, tag, at) = match frame {
            Frame::Sequence { items, tag, at } => (Value::Array(items), tag, at),
            Frame::Mapping { map, tag, at, .. } => (Value::Object(map), tag, at),
        };
        let value = match tag {
            Some(tag) => match long_form(&tag, value, at) {
                Ok(value) => value,
                Err(error) => return self.fail(error.at, error.message),
            },
            None => value,
        };
        self.add(value);
    }
}

impl MarkedEventReceiver for Builder {
    fn on_event(&mut self, event: Event, mark: Marker) {
        if self.error.is_some() {
            return;
        }
        let at = At::from(mark);
        match event {
            Event::DocumentStart => {
                self.documents += 1;
                if self.documents > 1 {
                    self.fail(at, "a second document: a template is one");
                }
            }
            // An anchor alone changes nothing, and is let be: an alias of it is what CloudFormation refuses.
            Event::Scalar(text, style, _, tag) => self.scalar(text, style, tag, at),
            Event::SequenceStart(_, tag) => self.start(Frame::Sequence { items: Vec::new(), tag, at }, at),
            Event::MappingStart(_, tag) => self.start(Frame::Mapping { map: Map::new(), key: None, tag, at }, at),
            Event::SequenceEnd | Event::MappingEnd => self.end(),
            Event::Alias(_) => self
                .fail(at, "an alias (*name): CloudFormation doesn't take YAML's aliases, so each value is written out"),
            Event::Nothing | Event::StreamStart | Event::StreamEnd | Event::DocumentEnd => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn value(text: &str) -> Value {
        read(text).unwrap().value
    }

    fn refused(text: &str) -> String {
        read(text).unwrap_err().to_string()
    }

    #[test]
    fn short_tags_become_their_long_forms() {
        assert_eq!(value("a: !Ref Queue"), json!({"a": {"Ref": "Queue"}}));
        assert_eq!(value("a: !Condition IsProd"), json!({"a": {"Condition": "IsProd"}}));
        assert_eq!(
            value("a: !Sub 'arn:${AWS::Partition}:s3:::${Bucket}'"),
            json!({"a": {"Fn::Sub": "arn:${AWS::Partition}:s3:::${Bucket}"}})
        );
        assert_eq!(
            value("a: !Sub ['${A}-x', {A: !Ref B}]"),
            json!({"a": {"Fn::Sub": ["${A}-x", {"A": {"Ref": "B"}}]}})
        );
        assert_eq!(value("a: !Join [',', [!Ref A, b]]"), json!({"a": {"Fn::Join": [",", [{"Ref": "A"}, "b"]]}}));
        assert_eq!(
            value("a: !If [IsProd, 1, !Ref AWS::NoValue]"),
            json!({"a": {"Fn::If": ["IsProd", 1, {"Ref": "AWS::NoValue"}]}})
        );
        assert_eq!(value("a: !Select [0, !GetAZs '']"), json!({"a": {"Fn::Select": [0, {"Fn::GetAZs": ""}]}}));
        assert_eq!(value("a: !Base64 {Fn::Sub: x}"), json!({"a": {"Fn::Base64": {"Fn::Sub": "x"}}}));
    }

    #[test]
    fn get_att_splits_at_the_first_dot_and_takes_the_long_form_as_it_is() {
        assert_eq!(value("a: !GetAtt Queue.Arn"), json!({"a": {"Fn::GetAtt": ["Queue", "Arn"]}}));
        assert_eq!(value("a: !GetAtt Db.Endpoint.Address"), json!({"a": {"Fn::GetAtt": ["Db", "Endpoint.Address"]}}));
        assert_eq!(value("a: !GetAtt [Queue, Arn]"), json!({"a": {"Fn::GetAtt": ["Queue", "Arn"]}}));
        assert!(refused("a: !GetAtt Queue").contains("!GetAtt Queue: a resource and its attribute"));
    }

    #[test]
    fn plain_scalars_are_typed_as_yaml_1_1_types_them_and_quoted_ones_stay_strings() {
        assert_eq!(
            value("a: 10\nb: -3\nc: 1.5\nd: true\ne: null\nf: ~\ng: '10'\nh: 2010-09-09\ni: |\n  two\n  lines\nj:\n"),
            json!({"a": 10, "b": -3, "c": 1.5, "d": true, "e": null, "f": null, "g": "10", "h": "2010-09-09", "i": "two\nlines\n", "j": null})
        );
        // Where YAML 1.1 and 1.2 differ, 1.1's reading.
        assert_eq!(
            value(
                "a: yes\nb: No\nc: on\nd: OFF\ne: 0755\nf: 0b101\ng: 0x1F\nh: 1:30\ni: 1_000\nj: 1:30.5\nk: 1.0e+5\nl: 1e5\nm: 1.0e5\nn: .5\no: 089\np: y\n"
            ),
            json!({"a": true, "b": false, "c": true, "d": false, "e": 493, "f": 5, "g": 31, "h": 90, "i": 1000, "j": 90.5, "k": 100000.0, "l": "1e5", "m": "1.0e5", "n": 0.5, "o": "089", "p": "y"})
        );
        assert_eq!(value("a: !!str 10\nb: !!str yes"), json!({"a": "10", "b": "yes"}));
    }

    #[test]
    fn each_value_keeps_where_it_starts() {
        let template =
            read("Resources:\n  Orders:\n    Properties:\n      Queue: !GetAtt Queue.Arn\n      Batch: [5, 10]\n")
                .unwrap();
        assert_eq!(template.at["/Resources/Orders/Properties/Queue"], At { line: 4, column: 22 });
        assert_eq!(template.at["/Resources/Orders/Properties/Batch/1"], At { line: 5, column: 18 });
        assert_eq!(read("a/b: {c~d: 1}").unwrap().at["/a~1b/c~0d"], At { line: 1, column: 12 });
    }

    #[test]
    fn what_cloudformation_wouldn_t_take_is_refused_at_its_line() {
        assert_eq!(
            refused("a:\n  b: !Foo x"),
            "line 2, column 11: !Foo: not one of CloudFormation's tags, which are !Ref, !Condition, !And, !Base64, !Cidr, !Equals, !FindInMap, !GetAtt, !GetAZs, !If, !ImportValue, !Join, !Not, !Or, !Select, !Split, !Sub, !Transform"
        );
        assert_eq!(refused("a: 1\nb: 2\na: 3\n"), "line 3, column 1: a: a key given twice in the same mapping");
        assert_eq!(refused("a: 1\n---\nb: 2\n"), "line 2, column 1: a second document: a template is one");
        assert!(refused("? [a]\n: 1\n").contains("a key that is a mapping or a sequence"));
        assert!(refused("a: [1\n").starts_with("line 2, column 1:"), "{}", refused("a: [1\n"));
    }

    #[test]
    fn aliases_merges_and_yaml_s_other_tags_are_refused_as_cloudformation_refuses_them() {
        assert_eq!(
            refused("a: &x {b: 1}\nc: *x\n"),
            "line 2, column 4: an alias (*name): CloudFormation doesn't take YAML's aliases, so each value is written out"
        );
        assert!(
            refused("a: &x {b: 1}\nc:\n  <<: {d: 2}\n")
                .contains("a merge (<<): CloudFormation doesn't take YAML's merges")
        );
        assert!(refused("a: !!binary aGk=").contains("!!binary: CloudFormation doesn't take YAML's binary tag"));
        assert!(
            refused("a: !!timestamp 2010-09-09")
                .contains("!!timestamp: CloudFormation doesn't take YAML's timestamp tag")
        );
        assert!(refused("a: .inf").contains(".inf: a number JSON can't hold"));
        // An anchor alone changes nothing.
        assert_eq!(value("a: &x 1"), json!({"a": 1}));
    }
}
