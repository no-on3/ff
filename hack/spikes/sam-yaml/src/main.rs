//! Reads a SAM template and prints it as JSON, its short tags in their long forms, as `cfn-flip -j` prints it; with
//! --at, where each value starts instead, its line and column before its JSON pointer. A template it refuses, it
//! names with the line and the reason.
//!   sam-yaml-spike <template.yaml> [--at]
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.first() else {
        eprintln!("usage: sam-yaml-spike <template.yaml> [--at]");
        return ExitCode::from(2);
    };
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("{path}: {error}");
            return ExitCode::from(2);
        }
    };
    match sam_yaml_spike::read(&text) {
        Ok(template) if args.iter().any(|arg| arg == "--at") => {
            for (pointer, at) in &template.at {
                println!("{}:{} {pointer}", at.line, at.column);
            }
            ExitCode::SUCCESS
        }
        Ok(template) => {
            println!("{}", serde_json::to_string_pretty(&template.value).expect("a JSON value prints"));
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{path}, {error}");
            ExitCode::FAILURE
        }
    }
}
