//! The real `ff` binary, black-box: what it prints and the exit codes scripts rely on.

use assert_cmd::Command;
use predicates::prelude::*;

fn ff() -> Command {
    let mut command = Command::cargo_bin("ff").expect("the ff binary is built");
    command.env_remove("NO_COLOR");
    command
}

#[test]
fn help_lists_the_commands() {
    ff().arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("version").and(predicate::str::contains("completion")))
        .stdout(predicate::str::contains("--output <OUTPUT>"));
}

#[test]
fn an_unknown_command_is_a_usage_error() {
    ff().arg("deplyo").assert().code(2).stderr(predicate::str::contains("unrecognized subcommand 'deplyo'"));
}

#[test]
fn an_unknown_output_format_is_a_usage_error() {
    ff().args(["version", "--output", "yaml"]).assert().code(2).stderr(predicate::str::contains("'yaml'"));
}

#[test]
fn version_names_the_commit_it_was_built_from() {
    let expected = format!(r"^ff {} \(commit ([0-9a-f]{{12}}|unknown)\)\n$", env!("CARGO_PKG_VERSION"));
    ff().arg("version").assert().success().stdout(predicate::str::is_match(expected).unwrap());
    ff().arg("--version").assert().success().stdout(predicate::str::is_match(r"^ff \d+\.\d+\.\d+ \(commit ").unwrap());
}

#[test]
fn version_says_the_platform_when_verbose() {
    ff().args(["version", "--verbose"]).assert().success().stdout(predicate::str::contains("\nbuilt for "));
}

#[test]
fn version_as_json_is_one_document_with_its_three_fields() {
    let output = ff().args(["--output", "json", "version"]).output().unwrap();
    assert!(output.status.success());

    let document: serde_json::Value = serde_json::from_slice(&output.stdout).expect("one JSON document");
    let fields: Vec<&str> = document.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(fields, ["commit", "target", "version"]);
    assert_eq!(document["version"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn completion_prints_a_script_for_the_shell() {
    ff().args(["completion", "bash"]).assert().success().stdout(predicate::str::contains("_ff()"));
    ff().args(["completion", "zsh"]).assert().success().stdout(predicate::str::contains("#compdef ff"));
    ff().args(["completion", "tcsh"]).assert().code(2);
}
