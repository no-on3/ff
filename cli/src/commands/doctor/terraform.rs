//! A Terraform project's checks: what its AWS provider block holds for FF, which a move to AWS removes, as
//! `ff init --template terraform` writes it between its two "FF" comments. Its `endpoints` block, which sends the
//! provider's calls elsewhere than AWS, is an error; each setting that skips what FF has no answer for, and S3's path
//! style, a warning. HCL read by its lines and braces, not parsed: a provider block's settings at its own level.

use std::ops::RangeInclusive;

use super::{Finding, Level};
use crate::table::in_words;

/// Terraform's and OpenTofu's configuration files, which each reads in a module's folder.
pub fn is_configuration(name: &str) -> bool {
    name.ends_with(".tf")
}

/// The provider's settings FF needs, set to true, each with what it does and why a move to AWS removes it.
const FF_SETTINGS: [(&str, &str); 5] = [
    (
        "skip_credentials_validation",
        "skips checking the key with STS, which FF hasn't: on AWS, remove it, so that a key AWS refuses fails the plan",
    ),
    (
        "skip_requesting_account_id",
        "skips asking STS for the account's ID, which FF hasn't: on AWS, remove it, as the provider builds some ARNs \
         with it",
    ),
    (
        "skip_metadata_api_check",
        "skips the instance metadata service, which FF hasn't: on AWS, remove it, so that a machine's role can give \
         the provider its key",
    ),
    (
        "skip_region_validation",
        "skips checking the region against AWS's, which FF's isn't one of: on AWS, remove it, with an AWS region",
    ),
    (
        "s3_use_path_style",
        "reaches each bucket at a path of S3's endpoint, as FF's S3 takes it: on AWS, remove it, and the provider \
         reaches a bucket at its own host",
    ),
];

/// A line as the checks read it: its number from 1, its code without comments, and the braces open before and after.
struct Line {
    number: usize,
    code: String,
    depth: usize,
    after: usize,
}

/// The file's lines, comments left out and heredocs' bodies skipped, with the depth of braces at each, outside
/// strings. A string's quotes pair as they come: an interpolation's own strings, `"${a == "b"}"`, leave its braces
/// inside one or the other.
fn lines(text: &str) -> Vec<Line> {
    let (mut depth, mut in_comment, mut heredoc) = (0usize, false, None::<String>);
    let mut found = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if let Some(end) = &heredoc {
            if line.trim() == end {
                heredoc = None;
            }
            continue;
        }
        let (chars, mut code, mut in_string, mut at) = (line.chars().collect::<Vec<_>>(), String::new(), false, 0);
        let before = depth;
        while at < chars.len() {
            let (c, next) = (chars[at], chars.get(at + 1).copied());
            at += 1;
            if in_comment {
                if c == '*' && next == Some('/') {
                    in_comment = false;
                    at += 1;
                }
                continue;
            }
            code.push(c);
            if in_string {
                // An escaped character is the string's, a quote included.
                if c == '\\' {
                    code.extend(next);
                    at += 1;
                } else if c == '"' {
                    in_string = false;
                }
                continue;
            }
            match c {
                '#' => {
                    code.pop();
                    break;
                }
                '/' if next == Some('/') => {
                    code.pop();
                    break;
                }
                '/' if next == Some('*') => {
                    code.pop();
                    in_comment = true;
                    at += 1;
                }
                '"' => in_string = true,
                '{' => depth += 1,
                '}' => depth = depth.saturating_sub(1),
                '<' if next == Some('<') => {
                    let rest = chars[at + 1..].iter().skip_while(|c| **c == '-');
                    let marker: String = rest.take_while(|c| c.is_ascii_alphanumeric() || **c == '_').collect();
                    heredoc = (!marker.is_empty()).then_some(marker);
                }
                _ => {}
            }
        }
        found.push(Line { number: index + 1, code: code.trim().to_owned(), depth: before, after: depth });
    }
    found
}

/// Whether the code opens a block of that type, with the labels given: `provider "aws" {`, `endpoints {`.
fn opens(code: &str, block: &str, label: Option<&str>) -> bool {
    let Some(rest) = code.strip_prefix(block) else { return false };
    let rest = rest.trim_start();
    let rest = match label {
        Some(label) => {
            let quoted = format!("\"{label}\"");
            match rest.strip_prefix(quoted.as_str()).or_else(|| rest.strip_prefix(label)) {
                Some(rest) => rest.trim_start(),
                None => return false,
            }
        }
        None => rest,
    };
    rest.starts_with('{')
}

/// An argument's name and its value as written: `skip_region_validation = true`.
fn argument(code: &str) -> Option<(&str, &str)> {
    let (name, value) = code.split_once('=')?;
    let name = name.trim();
    let value = value.trim();
    let is_name = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    (is_name && !value.starts_with('=')).then_some((name, value))
}

fn endpoints_finding(file: &str, line: usize, services: &[String]) -> Finding {
    let calls =
        if services.is_empty() { "its calls".to_owned() } else { format!("its calls to {}", in_words(services)) };
    Finding {
        file: file.to_owned(),
        line: Some(line),
        level: Level::Error,
        check: "provider-endpoints",
        message: format!(
            "the AWS provider's endpoints block sends {calls} elsewhere than AWS: on AWS, remove it, and the provider \
             calls AWS's own"
        ),
    }
}

/// The findings of a Terraform file, added to the file's others: FF's hosts named in an endpoints block are the
/// block's finding, not one each.
pub fn check(file: &str, text: &str, findings: &mut Vec<Finding>) {
    let mut blocks: Vec<RangeInclusive<usize>> = Vec::new();
    // Inside an AWS provider block, the depth of its settings; inside its endpoints block, where it opened, the depth
    // of its services and their names.
    let mut provider: Option<usize> = None;
    let mut endpoints: Option<(usize, usize, Vec<String>)> = None;
    for line in lines(text) {
        if let Some((_, inner, services)) = endpoints.as_mut()
            && line.depth == *inner
        {
            services.extend(argument(&line.code).map(|(name, _)| name.to_owned()));
        }
        match provider {
            None if line.depth == 0 && opens(&line.code, "provider", Some("aws")) => provider = Some(1),
            Some(inner) if line.depth == inner && opens(&line.code, "endpoints", None) => {
                endpoints = Some((line.number, inner + 1, Vec::new()));
            }
            Some(inner) if line.depth == inner => {
                let setting = argument(&line.code).and_then(|(name, value)| {
                    FF_SETTINGS.iter().find(|(setting, _)| *setting == name && value == "true")
                });
                if let Some((name, message)) = setting {
                    findings.push(Finding {
                        file: file.to_owned(),
                        line: Some(line.number),
                        level: Level::Warning,
                        check: "provider-setting",
                        message: format!("{name} {message}"),
                    });
                }
            }
            _ => {}
        }
        if let Some((opened, _, services)) = endpoints.take_if(|(_, inner, _)| line.after < *inner) {
            findings.push(endpoints_finding(file, opened, &services));
            blocks.push(opened..=line.number);
        }
        if provider.is_some_and(|inner| line.after < inner) {
            provider = None;
        }
    }
    findings.retain(|finding| {
        finding.file != file
            || finding.check != "ff-host"
            || !finding.line.is_some_and(|line| blocks.iter().any(|block| block.contains(&line)))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(text: &str) -> Vec<(Option<usize>, Level, &'static str, String)> {
        let mut findings = Vec::new();
        check("providers.tf", text, &mut findings);
        findings.into_iter().map(|finding| (finding.line, finding.level, finding.check, finding.message)).collect()
    }

    #[test]
    fn an_aws_providers_endpoints_block_is_an_error_naming_its_services_and_each_ff_setting_a_warning() {
        let text = "provider \"aws\" {\n  region = \"tn-tunis-1\"\n  skip_credentials_validation = true # FF\n  \
                    skip_region_validation      = true\n  s3_use_path_style           = true\n  endpoints {\n    \
                    lambda = \"https://lambda.ffunc.cloud\"\n    s3     = \"https://s3.ffunc.cloud\"\n  }\n}\n";
        let found = found(text);
        assert_eq!(
            found.iter().map(|(line, level, check, _)| (*line, *level, *check)).collect::<Vec<_>>(),
            [
                (Some(3), Level::Warning, "provider-setting"),
                (Some(4), Level::Warning, "provider-setting"),
                (Some(5), Level::Warning, "provider-setting"),
                (Some(6), Level::Error, "provider-endpoints"),
            ]
        );
        assert_eq!(
            found[3].3,
            "the AWS provider's endpoints block sends its calls to lambda and s3 elsewhere than AWS: on AWS, remove \
             it, and the provider calls AWS's own"
        );
        assert!(
            found[0].3.starts_with("skip_credentials_validation skips checking the key with STS"),
            "{}",
            found[0].3
        );
    }

    #[test]
    fn only_an_aws_providers_own_settings_count_not_a_comments_a_false_one_nor_another_blocks() {
        let text = "# provider \"aws\" { endpoints { s3 = \"x\" } }\nprovider \"awscc\" {\n  \
                    skip_region_validation = true\n}\nprovider aws {\n  alias = \"other\"\n  \
                    skip_region_validation = false\n  // skip_metadata_api_check = true\n  default_tags {\n    \
                    tags = { skip_credentials_validation = true }\n  }\n  /* endpoints {\n  } */\n}\n\
                    resource \"x\" \"y\" {\n  endpoints {\n  }\n}\n";
        assert_eq!(found(text), []);
    }

    #[test]
    fn a_heredoc_or_a_string_with_braces_leaves_the_blocks_as_they_are() {
        let text = "locals {\n  policy = <<-EOF\n    { \"Statement\": [ {\n  EOF\n  name = \"${var.app}-}\"\n}\n\
                    provider \"aws\" {\n  skip_requesting_account_id = true\n  endpoints { sqs = \"http://localhost\" }\n}\n";
        let found = found(text);
        assert_eq!(
            found.iter().map(|(line, _, check, _)| (*line, *check)).collect::<Vec<_>>(),
            [(Some(8), "provider-setting"), (Some(9), "provider-endpoints")]
        );
        // A block opened and closed on its line: its services aren't read, and its finding says its calls.
        assert!(found[1].3.starts_with("the AWS provider's endpoints block sends its calls elsewhere than AWS"));
    }

    #[test]
    fn ff_hosts_in_an_endpoints_block_are_its_finding_and_elsewhere_their_own() {
        let host = |line| Finding {
            file: "providers.tf".to_owned(),
            line: Some(line),
            level: Level::Warning,
            check: "ff-host",
            message: "names ffunc.cloud".to_owned(),
        };
        let mut findings = vec![host(3), host(6)];
        check(
            "providers.tf",
            "provider \"aws\" {\n  endpoints {\n    s3 = \"https://s3.ffunc.cloud\"\n  }\n}\n# https://s3.ffunc.cloud\n",
            &mut findings,
        );
        assert_eq!(
            findings.iter().map(|finding| (finding.line, finding.check)).collect::<Vec<_>>(),
            [(Some(6), "ff-host"), (Some(2), "provider-endpoints")]
        );
    }
}
