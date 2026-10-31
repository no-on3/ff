//! The backend's TypeScript, as the tests read it to check that ff's names are the API's: the
//! fields a class declares, the strings of a list.

use serde::Serialize;

/// The fields `class` declares in a source, in its order.
pub fn class_fields(source: &str, class: &str) -> Vec<String> {
    let start = source.find(&format!("export class {class} ")).unwrap_or_else(|| panic!("no class {class}"));
    let body = &source[start..];
    body[..body.find("\n}").expect("the class's end")]
        .lines()
        .skip(1)
        .filter_map(|line| line.strip_prefix("  "))
        .filter(|line| !line.starts_with(['@', ' ', '}', '/', '*', ')']))
        .filter_map(|line| line.split([':', '?']).next())
        .map(str::to_owned)
        .collect()
}

/// The strings of the list `const name = [...]` in a source, in its order.
pub fn listed(source: &str, name: &str) -> Vec<String> {
    let start = source.find(&format!("const {name} = [")).unwrap_or_else(|| panic!("no list {name}"));
    let body = &source[start..start + source[start..].find(']').expect("the list's end")];
    body.split('\'').skip(1).step_by(2).map(str::to_owned).collect()
}

/// The fields a value of ff's own serializes with, sorted.
pub fn sorted_keys(value: &impl Serialize) -> Vec<String> {
    let mut keys: Vec<String> =
        serde_json::to_value(value).unwrap().as_object().expect("an object").keys().cloned().collect();
    keys.sort();
    keys
}

/// Names sorted, to compare with what a value serializes with.
pub fn sorted(mut names: Vec<String>) -> Vec<String> {
    names.sort();
    names
}
