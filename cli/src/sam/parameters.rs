//! A template's parameters and their values, as `sam deploy` and CloudFormation give them: `--parameter-overrides`
//! as the SAM CLI reads it, else samconfig.toml's; each parameter's value given, else its Default; and what
//! CloudFormation checks of a value against its parameter: its type, `AllowedValues`, its lengths and its bounds.
//! `AllowedPattern` isn't checked here: `ff` has no regular expressions, and a deploy on AWS checks it.

use std::collections::BTreeMap;

use serde_json::Value;

use super::{Template, text_of};

/// The parameters' types FF's subset takes: CloudFormation's own, not AWS's, which check a value against what the
/// account has on AWS.
pub const TYPES: [&str; 4] = ["String", "Number", "CommaDelimitedList", "List<Number>"];

/// samconfig.toml's environment, which `sam deploy` reads with no `--config-env`.
const SAMCONFIG_ENVIRONMENT: &str = "default";

/// The text apart at its spaces, but in double quotes or after a backslash.
fn tokens(text: &str) -> Vec<String> {
    let (mut tokens, mut token, mut quoted, mut chars) = (Vec::new(), String::new(), false, text.chars());
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                token.push(c);
                token.extend(chars.next());
            }
            '"' => {
                quoted = !quoted;
                token.push(c);
            }
            c if c.is_whitespace() && !quoted => {
                if !token.is_empty() {
                    tokens.push(std::mem::take(&mut token));
                }
            }
            c => token.push(c),
        }
    }
    tokens.extend((!token.is_empty()).then_some(token));
    tokens
}

/// A value without the double quotes around it, `\ ` a space and `\"` a quote, as the SAM CLI unquotes one.
fn unquoted(value: &str) -> String {
    let inner = value.strip_prefix('"').and_then(|value| value.strip_suffix('"')).filter(|_| value.len() >= 2);
    inner.unwrap_or(value).replace("\\ ", " ").replace("\\\"", "\"")
}

/// The values given, in their order: `Key=Value` and `ParameterKey=Key,ParameterValue=Value`, apart by spaces, as
/// the SAM CLI reads `--parameter-overrides`; a value in double quotes may hold spaces.
pub fn overrides(given: &[String]) -> Result<Vec<(String, String)>, String> {
    let mut values = Vec::new();
    for token in given.iter().flat_map(|text| tokens(text)) {
        let pair = match token.strip_prefix("ParameterKey=") {
            Some(rest) => rest.split_once(",ParameterValue="),
            None => token.split_once('='),
        };
        let (key, value) = pair
            .filter(|(key, value)| {
                !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric()) && !value.is_empty()
            })
            .ok_or_else(|| {
                format!("{token}: a parameter's value is given as Key=Value or ParameterKey=Key,ParameterValue=Value")
            })?;
        values.push((key.to_owned(), unquoted(value)));
    }
    Ok(values)
}

/// samconfig.toml's values for `sam deploy`: its default environment's `deploy` parameters' `parameter_overrides`,
/// else its `global` ones', a string or a list of strings.
pub fn samconfig(text: &str) -> Result<Vec<(String, String)>, String> {
    let document: toml_edit::DocumentMut = text.parse().map_err(|error| format!("it isn't TOML: {error}"))?;
    let found = ["deploy", "global"].into_iter().find_map(|command| {
        document.get(SAMCONFIG_ENVIRONMENT)?.get(command)?.get("parameters")?.get("parameter_overrides")
    });
    let Some(item) = found else { return Ok(Vec::new()) };
    let given = match (item.as_str(), item.as_array()) {
        (Some(text), _) => vec![text.to_owned()],
        (_, Some(list)) => list.iter().filter_map(|value| value.as_str().map(str::to_owned)).collect(),
        _ => return Err("parameter_overrides is a string, or a list of strings".to_owned()),
    };
    overrides(&given).map_err(|error| format!("parameter_overrides: {error}"))
}

/// The parameters' values, and what CloudFormation would refuse of them.
#[derive(Debug, Default, PartialEq)]
pub struct Values {
    /// Each parameter's value known, given or its Default, as `Ref` gives it: text, or a list's items.
    pub values: BTreeMap<String, Value>,
    /// Each parameter whose value CloudFormation would refuse, and why.
    pub refused: Vec<(String, String)>,
    /// The parameters with no value: none given, and no Default.
    pub missing: Vec<String>,
    /// The names given that the template has no parameter for, which `sam deploy` passes over.
    pub unknown: Vec<String>,
}

/// The value of a parameter, as `Ref` gives it, or the item CloudFormation refuses and why.
fn checked(parameter: &Value, text: &str) -> Result<Value, (String, String)> {
    let kind = parameter.get("Type").and_then(Value::as_str).unwrap_or("String");
    let is_list = kind == "CommaDelimitedList" || kind == "List<Number>";
    let is_number = kind == "Number" || kind == "List<Number>";
    let bound = |name: &str| parameter.get(name).and_then(text_of).and_then(|text| text.trim().parse::<f64>().ok());
    let allowed: Option<Vec<String>> = parameter
        .get("AllowedValues")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(text_of).collect());
    // A list's items, each trimmed of its spaces, as CloudFormation splits one.
    let items: Vec<String> =
        if is_list { text.split(',').map(|item| item.trim().to_owned()).collect() } else { vec![text.to_owned()] };
    for item in &items {
        let refused = |why: String| Err((item.clone(), why));
        if let Some(allowed) = &allowed
            && !allowed.contains(item)
        {
            return refused(format!("isn't one of its AllowedValues, {}", allowed.join(", ")));
        }
        if is_number {
            let Some(number) = item.trim().parse::<f64>().ok().filter(|number| number.is_finite()) else {
                return refused("isn't a number".to_owned());
            };
            if let Some(least) = bound("MinValue").filter(|least| number < *least) {
                return refused(format!("is under its MinValue, {least}"));
            }
            if let Some(most) = bound("MaxValue").filter(|most| number > *most) {
                return refused(format!("is over its MaxValue, {most}"));
            }
        } else if !is_list {
            let length = item.chars().count() as f64;
            if let Some(least) = bound("MinLength").filter(|least| length < *least) {
                return refused(format!("is shorter than its MinLength, {least}"));
            }
            if let Some(most) = bound("MaxLength").filter(|most| length > *most) {
                return refused(format!("is longer than its MaxLength, {most}"));
            }
        }
    }
    Ok(if is_list { Value::Array(items.into_iter().map(Value::String).collect()) } else { Value::String(text.into()) })
}

/// Each parameter's value: the last given for it, else its Default; checked as CloudFormation checks it.
pub fn values(template: &Template, given: &[(String, String)]) -> Values {
    let parameters = template.value.get("Parameters").and_then(Value::as_object);
    let mut values = Values::default();
    for (key, _) in given {
        if !parameters.is_some_and(|parameters| parameters.contains_key(key)) && !values.unknown.contains(key) {
            values.unknown.push(key.clone());
        }
    }
    for (name, parameter) in parameters.into_iter().flatten() {
        let given = given.iter().rev().find(|(key, _)| key == name).map(|(_, value)| value.clone());
        let (text, origin) = match (given, parameter.get("Default")) {
            (Some(text), _) => (text, "the value given"),
            (None, Some(default)) => match text_of(default) {
                Some(text) => (text, "its Default"),
                None => {
                    let why = "its Default is a list or a mapping, where CloudFormation takes text: a list's items \
                               apart by commas";
                    values.refused.push((name.clone(), why.to_owned()));
                    continue;
                }
            },
            (None, None) => {
                values.missing.push(name.clone());
                continue;
            }
        };
        match checked(parameter, &text) {
            Ok(value) => {
                values.values.insert(name.clone(), value);
            }
            Err((item, why)) if item == text => values.refused.push((name.clone(), format!("{origin}, {text}, {why}"))),
            Err((item, why)) => {
                values.refused.push((name.clone(), format!("{origin}, {text}, has {item}, which {why}")))
            }
        }
    }
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sam::read;
    use serde_json::json;

    fn given(texts: &[&str]) -> Result<Vec<(String, String)>, String> {
        overrides(&texts.iter().map(|text| (*text).to_owned()).collect::<Vec<_>>())
    }

    fn pairs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect()
    }

    #[test]
    fn overrides_are_read_as_the_sam_cli_reads_them() {
        assert_eq!(
            given(&["Stage=prod Memory=512", "ParameterKey=Name,ParameterValue=\"two words\"", r"Path=a\ b"]),
            Ok(pairs(&[("Stage", "prod"), ("Memory", "512"), ("Name", "two words"), ("Path", "a b")]))
        );
        assert_eq!(
            given(&["Empty=\"\" Quote=\"say \\\"hi\\\"\""]),
            Ok(pairs(&[("Empty", ""), ("Quote", "say \"hi\"")]))
        );
        assert_eq!(
            given(&["Stage=prod", "Stage"]),
            Err("Stage: a parameter's value is given as Key=Value or ParameterKey=Key,ParameterValue=Value".to_owned())
        );
        assert!(given(&["Stage="]).is_err());
        assert!(given(&["my-stage=prod"]).is_err());
    }

    #[test]
    fn samconfigs_deploy_values_else_its_globals_a_string_or_a_list() {
        let deploy = "version = 0.1\n[default.global.parameters]\nstack_name = \"shop\"\nparameter_overrides = \"A=1\"\n\
                      [default.deploy.parameters]\nparameter_overrides = [\"Stage=prod\", \"Memory=512\"]\n\
                      [other.deploy.parameters]\nparameter_overrides = \"Stage=test\"\n";
        assert_eq!(samconfig(deploy), Ok(pairs(&[("Stage", "prod"), ("Memory", "512")])));
        assert_eq!(
            samconfig("[default.global.parameters]\nparameter_overrides = \"A=1 B=2\"\n"),
            Ok(pairs(&[("A", "1"), ("B", "2")]))
        );
        // sam init's: a stack's name and no values.
        assert_eq!(samconfig("version = 0.1\n[default.global.parameters]\nstack_name = \"hello\"\n"), Ok(vec![]));
        assert!(samconfig("[default.deploy.parameters]\nparameter_overrides = 3\n").is_err());
        assert!(samconfig("[default\n").unwrap_err().starts_with("it isn't TOML"));
    }

    const TEMPLATE: &str = "\
Parameters:
  Stage:
    Type: String
    AllowedValues: [prod, test]
    Default: test
  Memory:
    Type: Number
    MinValue: 128
    MaxValue: 10240
    Default: 512
  Name:
    Type: String
    MinLength: 3
  Ports:
    Type: List<Number>
    Default: 80, 443
  Zones:
    Type: CommaDelimitedList
    Default: a,b
  Flag:
    Type: String
    Default: yes
";

    #[test]
    fn each_parameter_has_its_value_given_else_its_default_as_ref_gives_it() {
        let template = read(TEMPLATE).unwrap();
        let values = values(&template, &pairs(&[("Stage", "test"), ("Stage", "prod"), ("Other", "x")]));
        assert_eq!(
            values.values,
            BTreeMap::from_iter(
                [
                    ("Stage", json!("prod")),
                    ("Memory", json!("512")),
                    ("Ports", json!(["80", "443"])),
                    ("Zones", json!(["a", "b"])),
                    // YAML 1.1's yes, a boolean, which CloudFormation takes as its text.
                    ("Flag", json!("true")),
                ]
                .map(|(name, value)| (name.to_owned(), value))
            )
        );
        assert_eq!((values.missing, values.unknown), (vec!["Name".to_owned()], vec!["Other".to_owned()]));
        assert_eq!(values.refused, []);
    }

    #[test]
    fn a_value_cloudformation_would_refuse_says_why() {
        let template = read(TEMPLATE).unwrap();
        let refused = |given: &[(&str, &str)]| {
            values(&template, &pairs(given)).refused.into_iter().map(|(_, why)| why).collect::<Vec<_>>()
        };
        assert_eq!(refused(&[("Stage", "dev")]), ["the value given, dev, isn't one of its AllowedValues, prod, test"]);
        assert_eq!(refused(&[("Memory", "20480")]), ["the value given, 20480, is over its MaxValue, 10240"]);
        assert_eq!(refused(&[("Memory", "lots")]), ["the value given, lots, isn't a number"]);
        assert_eq!(refused(&[("Name", "ab")]), ["the value given, ab, is shorter than its MinLength, 3"]);
        assert_eq!(refused(&[("Ports", "80,x")]), ["the value given, 80,x, has x, which isn't a number"]);
        let template =
            read("Parameters:\n  P:\n    Type: Number\n    Default: [1]\n  Q:\n    Type: Number\n    Default: 1.5\n")
                .unwrap();
        let checked = values(&template, &[]);
        assert!(checked.refused[0].1.starts_with("its Default is a list or a mapping"), "{:?}", checked.refused);
        assert_eq!(checked.values["Q"], json!("1.5"));
    }
}
