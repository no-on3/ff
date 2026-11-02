//! What a function's code does that works on FF and not on AWS Lambda, read line by line: FF's
//! variables and hosts, FF's API keys, FF's original event, and files written outside `/tmp`.
//! Heuristics on the text, not a parser: each finding names its line, for a person to judge.

use super::{Finding, Level};

/// How a file is read.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Language {
    JavaScript,
    Python,
    /// Configuration or data: read for FF's keys and hosts alone.
    Text,
}

impl Language {
    /// By the file's name: JavaScript's and TypeScript's extensions, Python's, else text.
    pub fn of(name: &str) -> Language {
        if name.ends_with(".d.ts") {
            return Language::Text;
        }
        match name.rsplit_once('.').map(|(_, extension)| extension) {
            Some("js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx") => Language::JavaScript,
            Some("py") => Language::Python,
            _ => Language::Text,
        }
    }
}

/// FF's runtime's variables, which Lambda's runtime names otherwise, with what to read there.
const RUNTIME_VARIABLES: [(&str, &str); 5] = [
    ("FUNCTION_NAME", "AWS_LAMBDA_FUNCTION_NAME, or the context's function name"),
    ("FUNCTION_VERSION", "AWS_LAMBDA_FUNCTION_VERSION"),
    ("FUNCTION_MEMORY_LIMIT", "AWS_LAMBDA_FUNCTION_MEMORY_SIZE"),
    ("FUNCTION_TIMEOUT", "the time left that the context gives"),
    ("PORT", "nothing: Lambda's runtime serves no port of the function's"),
];

/// What a string has that Lambda's function URL event's body, a string, has too: read on it,
/// they aren't FF's original event.
const STRING_MEMBERS: [&str; 30] = [
    "at",
    "charAt",
    "charCodeAt",
    "codePointAt",
    "concat",
    "endsWith",
    "includes",
    "indexOf",
    "lastIndexOf",
    "length",
    "localeCompare",
    "match",
    "matchAll",
    "normalize",
    "padEnd",
    "padStart",
    "repeat",
    "replace",
    "replaceAll",
    "search",
    "slice",
    "split",
    "startsWith",
    "substr",
    "substring",
    "toLowerCase",
    "toString",
    "toUpperCase",
    "trim",
    "trimEnd",
];

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

/// Where `word` starts in `line` as a name of its own, not the end of a longer one.
fn starts_of<'a>(line: &'a str, word: &'a str) -> impl Iterator<Item = usize> + 'a {
    line.match_indices(word).map(|(at, _)| at).filter(move |at| !line[..*at].chars().next_back().is_some_and(is_word))
}

/// The name a quote opens at the start of `text`, spaces before it skipped: `'FF_X'` gives FF_X.
fn quoted(text: &str) -> Option<&str> {
    let text = text.trim_start();
    let quote = text.chars().next().filter(|c| matches!(c, '\'' | '"' | '`'))?;
    let rest = &text[1..];
    rest.find(quote).map(|end| &rest[..end])
}

/// A call's arguments from just after its `(`, split at the commas outside quotes and brackets,
/// up to its `)` or the line's end.
fn arguments(text: &str) -> Vec<&str> {
    let (mut depth, mut quote, mut start) = (0usize, None, 0usize);
    let mut found = Vec::new();
    for (at, c) in text.char_indices() {
        match (quote, c) {
            (Some(open), _) if c == open => quote = None,
            (Some(_), _) => {}
            (None, '\'' | '"' | '`') => quote = Some(c),
            (None, '(' | '[' | '{') => depth += 1,
            (None, ')' | ']' | '}') if depth == 0 => {
                found.push(text[start..at].trim());
                return found;
            }
            (None, ')' | ']' | '}') => depth -= 1,
            (None, ',') if depth == 0 => {
                found.push(text[start..at].trim());
                start = at + 1;
            }
            _ => {}
        }
    }
    found.push(text[start..].trim());
    found
}

/// Whether a line is a comment alone, which the checks but the keys' skip.
fn is_comment(line: &str, language: Language) -> bool {
    let line = line.trim_start();
    match language {
        Language::JavaScript => line.starts_with("//") || line.starts_with("/*") || line.starts_with('*'),
        Language::Python => line.starts_with('#'),
        Language::Text => false,
    }
}

/// FF's API keys in a line, by their IDs: `ffk_`, 12 hex characters, `_`, 43 of base64url.
fn api_keys(line: &str) -> Vec<&str> {
    let base64url = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    starts_of(line, "ffk_")
        .filter_map(|at| {
            let rest = &line[at + 4..];
            let id = rest.get(..12)?;
            let secret = rest.get(13..56)?;
            let whole = id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                && rest[12..].starts_with('_')
                && secret.chars().all(base64url)
                && !rest[56..].starts_with(base64url);
            whole.then_some(id)
        })
        .collect()
}

/// The environment variables a line reads by name: `process.env.NAME`, `process.env['NAME']` and
/// `const { NAME } = process.env` in JavaScript; `environ['NAME']`, `environ.get('NAME')` and
/// `getenv('NAME')` in Python.
fn variables_read(line: &str, language: Language) -> Vec<&str> {
    let mut names = Vec::new();
    match language {
        Language::JavaScript => {
            for at in starts_of(line, "process.env") {
                let rest = &line[at + "process.env".len()..];
                let rest = rest.strip_prefix('?').unwrap_or(rest);
                if let Some(name) = rest.strip_prefix('.') {
                    names.push(&name[..name.find(|c: char| !is_word(c)).unwrap_or(name.len())]);
                } else if let Some(name) = rest.strip_prefix('[').and_then(quoted) {
                    names.push(name);
                } else if let Some(open) = line[..at]
                    .trim_end()
                    .strip_suffix('=')
                    .and_then(|left| left.trim_end().strip_suffix('}'))
                    .and_then(|left| left.rfind('{').map(|open| &left[open + 1..]))
                {
                    // Each name destructured, before its new name or its default.
                    let destructured =
                        open.split(',').map(|part| part.split([':', '=']).next().unwrap_or_default().trim());
                    names.extend(destructured.filter(|name| !name.is_empty() && name.chars().all(is_word)));
                }
            }
        }
        Language::Python => {
            for accessor in ["environ[", "environ.get(", "getenv("] {
                names.extend(starts_of(line, accessor).filter_map(|at| quoted(&line[at + accessor.len()..])));
            }
        }
        Language::Text => {}
    }
    names
}

/// What a line reads of the event's `body` as an object, as FF's original event gave the
/// payload, where on Lambda a direct call's event is the payload and a function URL's body a
/// string: `event.body.name`, `event.body['name']`; `event['body']['name']`,
/// `event.get('body', {})`.
fn reads_wrapped_body(line: &str, language: Language) -> bool {
    starts_of(line, "event").any(|at| {
        let rest = &line[at + "event".len()..];
        match language {
            Language::JavaScript => {
                let after = ["?.body", ".body", "['body']", "[\"body\"]"]
                    .iter()
                    .find_map(|accessor| rest.strip_prefix(accessor))
                    .filter(|after| !after.starts_with(is_word));
                let Some(after) = after else { return false };
                if let Some(member) = after.strip_prefix("?.").or_else(|| after.strip_prefix('.')) {
                    let member = &member[..member.find(|c: char| !is_word(c)).unwrap_or(member.len())];
                    !member.is_empty() && !STRING_MEMBERS.contains(&member)
                } else {
                    after.strip_prefix('[').is_some_and(|index| quoted(index).is_some())
                }
            }
            Language::Python => {
                if let Some(call) =
                    [".get('body'", ".get(\"body\""].iter().find_map(|accessor| rest.strip_prefix(accessor))
                {
                    // A default of {} says the body is a dict.
                    return arguments(call).iter().any(|argument| argument.starts_with('{'))
                        || dict_read(&call[call.find(')').map_or(call.len(), |end| end + 1)..]);
                }
                ["['body']", "[\"body\"]"]
                    .iter()
                    .find_map(|accessor| rest.strip_prefix(accessor))
                    .is_some_and(dict_read)
            }
            Language::Text => false,
        }
    })
}

/// Whether Python code goes on to read a dict: an item by its key, or a dict's method.
fn dict_read(after: &str) -> bool {
    after.strip_prefix('[').is_some_and(|index| quoted(index).is_some())
        || [".get(", ".items(", ".keys(", ".values("].iter().any(|method| after.starts_with(method))
}

/// Where a write's path goes, from its argument as written: a path in quotes, or the code's own
/// folder; None for a path the code computes, which the check can't judge, and for `/tmp`.
fn written_outside_tmp(argument: &str) -> Option<String> {
    let in_tmp = |path: &str| {
        path == "/tmp" || path.starts_with("/tmp/") || path.contains("tmpdir") || path.contains("gettempdir")
    };
    if let Some(path) = quoted(argument) {
        return (!in_tmp(path)).then(|| path.to_owned());
    }
    let next_to_code = ["__dirname", "__filename", "process.cwd()", "import.meta", "__file__", "os.getcwd()"];
    (next_to_code.iter().any(|name| argument.contains(name)) && !in_tmp(argument))
        .then(|| "next to the code".to_owned())
}

/// The paths a line writes outside `/tmp`: Node.js's file writes and folders made; Python's
/// `open` for writing, its folders made, and a `Path`'s writes.
fn writes_outside_tmp(line: &str, language: Language) -> Vec<String> {
    let mut paths = Vec::new();
    match language {
        Language::JavaScript => {
            let calls = [
                "writeFileSync(",
                "writeFile(",
                "appendFileSync(",
                "appendFile(",
                "createWriteStream(",
                "mkdirSync(",
                "mkdir(",
            ];
            for call in calls {
                for at in starts_of(line, call) {
                    paths.extend(
                        arguments(&line[at + call.len()..]).first().and_then(|first| written_outside_tmp(first)),
                    );
                }
            }
        }
        Language::Python => {
            for at in starts_of(line, "open(").filter(|at| !line[..*at].ends_with('.') || line[..*at].ends_with("io."))
            {
                let arguments = arguments(&line[at + "open(".len()..]);
                let mode = arguments
                    .iter()
                    .find_map(|argument| argument.strip_prefix("mode=").and_then(quoted))
                    .or_else(|| arguments.get(1).and_then(|second| quoted(second)));
                if mode.is_some_and(|mode| mode.contains(['w', 'a', 'x', '+'])) {
                    paths.extend(arguments.first().and_then(|first| written_outside_tmp(first)));
                }
            }
            for call in ["makedirs(", "mkdir("] {
                for at in starts_of(line, call).filter(|at| line[..*at].ends_with("os.")) {
                    paths.extend(
                        arguments(&line[at + call.len()..]).first().and_then(|first| written_outside_tmp(first)),
                    );
                }
            }
            for at in starts_of(line, "Path(") {
                let rest = &line[at + "Path(".len()..];
                let writes = [".write_text(", ".write_bytes(", ".mkdir(", ".touch(", ".open('w"]
                    .iter()
                    .any(|write| rest.contains(write));
                if writes {
                    paths.extend(arguments(rest).first().and_then(|first| written_outside_tmp(first)));
                }
            }
        }
        Language::Text => {}
    }
    paths
}

/// The findings of a file's text: `hosts` are FF's, which code on AWS wouldn't reach.
pub fn check(file: &str, text: &str, hosts: &[String]) -> Vec<Finding> {
    let language = Language::of(file);
    let mut findings = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let mut found = |level: Level, check: &'static str, message: String| {
            findings.push(Finding { file: file.to_owned(), line: Some(index + 1), level, check, message });
        };
        // A key is a secret wherever it is, a comment included.
        for id in api_keys(line) {
            found(
                Level::Error,
                "ff-key",
                format!(
                    "holds FF's API key ffk_{id}_…, a secret, which AWS doesn't take: keep it out of the code and revoke it"
                ),
            );
        }
        if is_comment(line, language) {
            continue;
        }
        for host in hosts.iter().filter(|host| line.contains(host.as_str())) {
            found(
                Level::Warning,
                "ff-host",
                format!("names {host}, FF's: on AWS, the service's own address, or a variable set at deploy"),
            );
        }
        for name in variables_read(line, language) {
            let message = match RUNTIME_VARIABLES.iter().find(|(variable, _)| *variable == name) {
                Some((_, instead)) => format!("reads {name}, which FF's runtime sets: on Lambda, {instead}"),
                None if name.starts_with("FF_") => {
                    format!("reads {name}, a variable of FF's own, which Lambda never sets")
                }
                None => continue,
            };
            found(Level::Warning, "ff-variable", message);
        }
        if reads_wrapped_body(line, language) {
            let parse = if language == Language::Python { "json.loads" } else { "JSON.parse" };
            found(
                Level::Warning,
                "wrapped-event",
                format!(
                    "reads event.body as an object, as FF's original event gave the payload: on Lambda, a direct call's \
                     event is the payload itself, and a function URL's body a string to {parse}"
                ),
            );
        }
        for path in writes_outside_tmp(line, language) {
            let place = if path == "next to the code" { path } else { format!("to {path}") };
            found(
                Level::Warning,
                "write-outside-tmp",
                format!("writes {place}: Lambda's file system is read-only but /tmp"),
            );
        }
    }
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each finding of a file's text as `(line, check)`.
    fn found(file: &str, text: &str) -> Vec<(usize, &'static str)> {
        check(file, text, &["dev.ffunc.cloud".to_owned(), "svc.cluster.local".to_owned()])
            .into_iter()
            .map(|finding| (finding.line.unwrap(), finding.check))
            .collect()
    }

    const KEY: &str = "ffk_3f9a2b1c0d4e_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

    #[test]
    fn an_api_key_is_an_error_wherever_it_is_and_its_secret_never_shown() {
        let text = format!("const key = '{KEY}';\n// {KEY}\nconst other = 'ffk_short';\n");
        assert_eq!(found("index.js", &text), [(1, "ff-key"), (2, "ff-key")]);
        let finding = &check("config.json", &format!("{{\"key\": \"{KEY}\"}}"), &[])[0];
        assert_eq!((finding.level, finding.line), (Level::Error, Some(1)));
        assert!(
            finding.message.contains("ffk_3f9a2b1c0d4e_…") && !finding.message.contains("AbCd"),
            "{}",
            finding.message
        );
        // Longer than a key: not one.
        assert_eq!(found("index.js", &format!("x = '{KEY}x'")), []);
    }

    #[test]
    fn ffs_hosts_are_named_outside_comments() {
        let text = "fetch('https://api.dev.ffunc.cloud/functions');\n// https://api.dev.ffunc.cloud\nconst q = 'http://sqs.ff.svc.cluster.local';\n";
        assert_eq!(found("index.js", text), [(1, "ff-host"), (3, "ff-host")]);
        assert_eq!(found("app.py", "# dev.ffunc.cloud\nURL = 'https://x.dev.ffunc.cloud'\n"), [(2, "ff-host")]);
    }

    #[test]
    fn ffs_variables_are_named_with_lambdas_own() {
        let text = "const name = process.env.FUNCTION_NAME;\nconst f = process.env['FF_EVENT_FORMAT'];\nconst ok = process.env.TABLE;\nprocess.env?.FUNCTION_TIMEOUT\nconst { TABLE, FUNCTION_VERSION: version, FF_HANDLER = 'x', ...rest } = process.env;\n";
        assert_eq!(
            found("index.mjs", text),
            [(1, "ff-variable"), (2, "ff-variable"), (4, "ff-variable"), (5, "ff-variable"), (5, "ff-variable")]
        );
        let python = "import os\nname = os.environ['FUNCTION_NAME']\nmemory = os.environ.get(\"FUNCTION_MEMORY_LIMIT\", '128')\nx = os.getenv('FF_THING')\ny = os.getenv('BUCKET')\n";
        assert_eq!(found("app.py", python), [(2, "ff-variable"), (3, "ff-variable"), (4, "ff-variable")]);
        let message = &check("index.js", "process.env.FUNCTION_NAME", &[])[0].message;
        assert_eq!(
            message,
            "reads FUNCTION_NAME, which FF's runtime sets: on Lambda, AWS_LAMBDA_FUNCTION_NAME, or the context's function name"
        );
    }

    #[test]
    fn the_body_read_as_an_object_is_ffs_original_event_and_a_strings_isnt() {
        let javascript = [
            ("const name = event.body.name;", true),
            ("const name = event.body?.name;", true),
            ("const { name } = event.body['user'];", true),
            ("const id = event['body'].id;", true),
            ("const data = JSON.parse(event.body);", false),
            ("if (event.body.length > 0) {}", false),
            ("const raw = event.body.toString('utf8');", false),
            ("const name = myevent.body.name;", false),
            ("const name = event.name;", false),
            ("const name = event.bodyText.name;", false),
        ];
        for (line, wrapped) in javascript {
            assert_eq!(!found("index.js", line).is_empty(), wrapped, "{line}");
        }
        let python = [
            ("name = event['body']['name']", true),
            ("name = event[\"body\"].get('name')", true),
            ("body = event.get('body', {})", true),
            ("name = event.get('body').get('name')", true),
            ("data = json.loads(event['body'])", false),
            ("raw = event.get('body')", false),
            ("name = event['name']", false),
        ];
        for (line, wrapped) in python {
            assert_eq!(!found("app.py", line).is_empty(), wrapped, "{line}");
        }
        assert!(check("app.py", "event['body']['x']", &[])[0].message.ends_with("a string to json.loads"));
    }

    #[test]
    fn a_write_outside_tmp_is_named_and_one_inside_isnt() {
        let javascript = "fs.writeFileSync('/var/task/out.json', data);\nawait fs.promises.writeFile('/tmp/out.json', data);\nfs.mkdirSync(path.join(__dirname, 'cache'));\nfs.createWriteStream(`${os.tmpdir()}/log`);\nfs.appendFile(\"report.csv\", line, done);\nfs.writeFile(computed, data);\n";
        assert_eq!(
            found("index.js", javascript),
            [(1, "write-outside-tmp"), (3, "write-outside-tmp"), (5, "write-outside-tmp")]
        );
        let python = "with open('/data/out.txt', 'w') as f:\nwith open('/tmp/out.txt', 'w') as f:\nwith open('config.json') as f:\nopen('log.txt', mode='a')\nos.makedirs('/opt/cache')\nPath('result.json').write_text(text)\nos.path.join(here, open)\n";
        assert_eq!(
            found("app.py", python),
            [(1, "write-outside-tmp"), (4, "write-outside-tmp"), (5, "write-outside-tmp"), (6, "write-outside-tmp")]
        );
        let messages: Vec<String> =
            check("index.js", javascript, &[]).into_iter().map(|finding| finding.message).collect();
        assert_eq!(
            messages,
            [
                "writes to /var/task/out.json: Lambda's file system is read-only but /tmp",
                "writes next to the code: Lambda's file system is read-only but /tmp",
                "writes to report.csv: Lambda's file system is read-only but /tmp",
            ]
        );
    }

    #[test]
    fn data_files_are_read_for_keys_and_hosts_alone() {
        let text = format!("event.body.name\nprocess.env.FUNCTION_NAME\nhttps://api.dev.ffunc.cloud\n{KEY}\n");
        assert_eq!(found("notes.md", &text), [(3, "ff-host"), (4, "ff-key")]);
        assert_eq!(Language::of("types.d.ts"), Language::Text);
        assert_eq!(
            [Language::of("a.ts"), Language::of("a.cjs"), Language::of("a.py")],
            [Language::JavaScript, Language::JavaScript, Language::Python]
        );
    }
}
