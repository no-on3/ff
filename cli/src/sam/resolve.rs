//! A template's values as SAM and CloudFormation make them: the Globals merged into each function as SAM merges them,
//! and the intrinsics resolved, `Ref`, `Fn::GetAtt`, `Fn::Sub` and `Fn::Join`, from what is known: a parameter's
//! value, and once a deploy has made them, what the resources give. What isn't known yet is left as it is, its known
//! parts resolved, for a later pass.

use serde_json::{Map, Value};

/// SAM's resource type whose properties the Globals' `Function` gives.
pub const FUNCTION: &str = "AWS::Serverless::Function";

/// A mapping that is an intrinsic function, as SAM and CloudFormation tell one: a single key, `Ref`, `Condition` or
/// `Fn::` and a name; with its name and what it is given.
pub fn intrinsic(map: &Map<String, Value>) -> Option<(&str, &Value)> {
    let (name, args) = map.iter().next().filter(|_| map.len() == 1)?;
    (name == "Ref" || name == "Condition" || name.starts_with("Fn::")).then_some((name.as_str(), args))
}

/// A global value and a function's own merged, as SAM's Globals are: a mapping's keys merged, the function's value
/// winning at each, a list the Globals' items then the function's, and any other value, an intrinsic's included, the
/// function's, as two values of different kinds are.
pub fn merged(global: &Value, own: &Value) -> Value {
    match (global, own) {
        (Value::Object(global), Value::Object(own)) if intrinsic(global).is_none() && intrinsic(own).is_none() => {
            let mut merged = global.clone();
            for (key, value) in own {
                let value = match global.get(key) {
                    Some(global) => self::merged(global, value),
                    None => value.clone(),
                };
                merged.insert(key.clone(), value);
            }
            Value::Object(merged)
        }
        (Value::Array(global), Value::Array(own)) => Value::Array(global.iter().chain(own).cloned().collect()),
        _ => own.clone(),
    }
}

/// The template with the Globals' `Function` merged into each function's properties, as SAM gives them to Lambda.
pub fn with_globals(template: &Value) -> Value {
    let mut template = template.clone();
    let Some(global) = template.pointer("/Globals/Function").filter(|global| global.is_object()).cloned() else {
        return template;
    };
    let resources = template.get_mut("Resources").and_then(Value::as_object_mut).into_iter().flatten();
    for (_, resource) in
        resources.filter(|(_, resource)| resource.get("Type").and_then(Value::as_str) == Some(FUNCTION))
    {
        let Some(resource) = resource.as_object_mut() else { continue };
        let own = resource.get("Properties").cloned().unwrap_or_else(|| Value::Object(Map::new()));
        resource.insert("Properties".to_owned(), merged(&global, &own));
    }
    template
}

/// A piece of `Fn::Sub`'s text: text as it is, or a name, `${Name}` or `${Resource.Attribute}`.
#[derive(Debug, PartialEq, Eq)]
pub enum Part<'a> {
    Text(String),
    Name(&'a str),
}

/// `Fn::Sub`'s text in its pieces, as CloudFormation reads it: `${Name}` a name, `${!Literal}` the text `${Literal}`,
/// and a `${` with no `}` after it text.
pub fn sub_parts(text: &str) -> Vec<Part<'_>> {
    let mut parts = Vec::new();
    let mut literal = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        let Some(length) = rest[start + 2..].find('}') else { break };
        literal.push_str(&rest[..start]);
        let name = &rest[start + 2..start + 2 + length];
        match name.strip_prefix('!') {
            Some(escaped) => literal.push_str(&format!("${{{escaped}}}")),
            None if name.is_empty() => literal.push_str("${}"),
            None => {
                parts.extend((!literal.is_empty()).then(|| Part::Text(std::mem::take(&mut literal))));
                parts.push(Part::Name(name));
            }
        }
        rest = &rest[start + 3 + length..];
    }
    literal.push_str(rest);
    parts.extend((!literal.is_empty()).then_some(Part::Text(literal)));
    parts
}

/// What a name gives, if it is known: a `Ref`'s value (no attribute) or a `Fn::GetAtt`'s.
pub type Known<'a> = &'a dyn Fn(&str, Option<&str>) -> Option<Value>;

/// The value with each intrinsic resolved that can be: `Ref` and `Fn::GetAtt` by what is known, `Fn::Sub` and
/// `Fn::Join` once all they hold is text. What isn't known is left, its known parts resolved: a `Fn::Sub`'s values
/// written into its text, each `${` in them escaped so that they stay text.
pub fn resolve(value: &Value, known: Known) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| resolve(item, known)).collect()),
        Value::Object(map) => match intrinsic(map) {
            Some(("Ref", Value::String(name))) => known(name, None).unwrap_or_else(|| value.clone()),
            Some(("Fn::GetAtt", Value::Array(args))) => match args.as_slice() {
                [Value::String(resource), Value::String(attribute)] => {
                    known(resource, Some(attribute)).unwrap_or_else(|| value.clone())
                }
                _ => value.clone(),
            },
            Some(("Fn::Sub", args)) => sub(args, known).unwrap_or_else(|| value.clone()),
            Some(("Fn::Join", Value::Array(args))) => match args.as_slice() {
                [Value::String(delimiter), list] => join(delimiter, &resolve(list, known)),
                _ => value.clone(),
            },
            _ => Value::Object(map.iter().map(|(key, value)| (key.clone(), resolve(value, known))).collect()),
        },
        _ => value.clone(),
    }
}

/// `Fn::Join` of a list resolved: its text, or the function with what is resolved so far.
fn join(delimiter: &str, list: &Value) -> Value {
    let texts: Option<Vec<&str>> = list.as_array().and_then(|items| items.iter().map(Value::as_str).collect());
    match texts {
        Some(texts) => Value::String(texts.join(delimiter)),
        None => {
            Value::Object(Map::from_iter([("Fn::Join".to_owned(), Value::Array(vec![delimiter.into(), list.clone()]))]))
        }
    }
}

/// `Fn::Sub`, its text or `[text, values]`, resolved: its text once each name is known, else the function with the
/// names known written in. None for what isn't `Fn::Sub`'s shape, left as it is.
fn sub(args: &Value, known: Known) -> Option<Value> {
    let (text, values) = match args {
        Value::String(text) => (text.as_str(), None),
        Value::Array(args) => match args.as_slice() {
            [Value::String(text), Value::Object(values)] => (text.as_str(), Some(values)),
            _ => return None,
        },
        _ => return None,
    };
    let values: Map<String, Value> =
        values.into_iter().flatten().map(|(name, value)| (name.clone(), resolve(value, known))).collect();
    let (mut written, mut unknown) = (String::new(), Vec::new());
    for part in sub_parts(text) {
        match part {
            // Text that stays text in a function written again: `${` as `${!`.
            Part::Text(text) => written.push_str(&text.replace("${", "${!")),
            Part::Name(name) => {
                let value = match values.get(name) {
                    Some(value) => Some(value.clone()),
                    None => match name.split_once('.') {
                        Some((resource, attribute)) => known(resource, Some(attribute)),
                        None => known(name, None),
                    },
                };
                match value {
                    Some(Value::String(text)) => written.push_str(&text.replace("${", "${!")),
                    _ => {
                        written.push_str(&format!("${{{name}}}"));
                        unknown.push(name);
                    }
                }
            }
        }
    }
    if unknown.is_empty() {
        // Each `${!` was text's: none is left to escape.
        return Some(Value::String(written.replace("${!", "${")));
    }
    let left: Map<String, Value> = values.into_iter().filter(|(name, _)| unknown.contains(&name.as_str())).collect();
    let args = if left.is_empty() { Value::String(written) } else { Value::Array(vec![written.into(), left.into()]) };
    Some(Value::Object(Map::from_iter([("Fn::Sub".to_owned(), args)])))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parameters(name: &str, attribute: Option<&str>) -> Option<Value> {
        match (name, attribute) {
            ("Stage", None) => Some("prod".into()),
            ("Subnets", None) => Some(json!(["a", "b"])),
            ("Queue", Some("Arn")) => Some("arn:aws:sqs:tn-tunis-1:123456789012:orders".into()),
            ("Odd", None) => Some("${x}".into()),
            _ => None,
        }
    }

    #[test]
    fn globals_merge_as_sam_merges_them_maps_by_key_lists_after_and_the_rest_the_functions() {
        assert_eq!(
            merged(
                &json!({"Timeout": 3, "Environment": {"Variables": {"A": "1", "B": "2"}}, "Layers": ["x"], "Tags": {"t": "g"}}),
                &json!({"Timeout": 10, "Environment": {"Variables": {"B": "own"}}, "Layers": ["y"], "Tags": {"Ref": "T"}})
            ),
            json!({"Timeout": 10, "Environment": {"Variables": {"A": "1", "B": "own"}}, "Layers": ["x", "y"], "Tags": {"Ref": "T"}})
        );
        // Of two kinds, the function's.
        assert_eq!(merged(&json!({"a": 1}), &json!(["b"])), json!(["b"]));
        let template = json!({
            "Globals": {"Function": {"Runtime": "nodejs24.x", "Timeout": 3}},
            "Resources": {
                "Orders": {"Type": FUNCTION, "Properties": {"Timeout": 10}},
                "Bare": {"Type": FUNCTION},
                "Queue": {"Type": "AWS::SQS::Queue", "Properties": {"QueueName": "q"}}
            }
        });
        let template = with_globals(&template);
        assert_eq!(
            template.pointer("/Resources/Orders/Properties"),
            Some(&json!({"Runtime": "nodejs24.x", "Timeout": 10}))
        );
        assert_eq!(
            template.pointer("/Resources/Bare/Properties"),
            Some(&json!({"Runtime": "nodejs24.x", "Timeout": 3}))
        );
        assert_eq!(template.pointer("/Resources/Queue/Properties"), Some(&json!({"QueueName": "q"})));
    }

    #[test]
    fn subs_text_is_read_in_pieces_as_cloudformation_reads_it() {
        assert_eq!(
            sub_parts("arn:${AWS::Partition}:s3:::${Bucket}/${!Literal}-${Queue.Arn}${"),
            [
                Part::Text("arn:".into()),
                Part::Name("AWS::Partition"),
                Part::Text(":s3:::".into()),
                Part::Name("Bucket"),
                Part::Text("/${Literal}-".into()),
                Part::Name("Queue.Arn"),
                Part::Text("${".into()),
            ]
        );
        assert_eq!(sub_parts(""), []);
    }

    #[test]
    fn what_is_known_resolves_and_what_isnt_stays_with_its_known_parts_resolved() {
        let resolved = resolve(
            &json!({
                "Name": {"Ref": "Stage"},
                "Arn": {"Fn::GetAtt": ["Queue", "Arn"]},
                "Url": {"Fn::Sub": "https://${Stage}.example/${!Path}"},
                "Mixed": {"Fn::Sub": "${Stage}-${Bucket}-${Odd}"},
                "Given": {"Fn::Sub": ["${A}/${B}", {"A": {"Ref": "Stage"}, "B": {"Ref": "Bucket"}}]},
                "Joined": {"Fn::Join": [",", {"Ref": "Subnets"}]},
                "Partly": {"Fn::Join": ["-", [{"Ref": "Stage"}, {"Ref": "Bucket"}]]},
                "Later": [{"Ref": "Bucket"}, 5]
            }),
            &parameters,
        );
        assert_eq!(
            resolved,
            json!({
                "Name": "prod",
                "Arn": "arn:aws:sqs:tn-tunis-1:123456789012:orders",
                "Url": "https://prod.example/${Path}",
                "Mixed": {"Fn::Sub": "prod-${Bucket}-${!x}"},
                "Given": {"Fn::Sub": ["prod/${B}", {"B": {"Ref": "Bucket"}}]},
                "Joined": "a,b",
                "Partly": {"Fn::Join": ["-", ["prod", {"Ref": "Bucket"}]]},
                "Later": [{"Ref": "Bucket"}, 5]
            })
        );
        // Resolved again once the bucket is known, a later pass gives the text, the escaped value as it was.
        let known = |name: &str, attribute: Option<&str>| match (name, attribute) {
            ("Bucket", None) => Some(Value::from("photos")),
            _ => None,
        };
        assert_eq!(resolve(&resolved["Mixed"], &known), json!("prod-photos-${x}"));
        assert_eq!(resolve(&resolved["Given"], &known), json!("prod/photos"));
    }
}
