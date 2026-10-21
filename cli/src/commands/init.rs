//! `ff init <name>`: a function's folder, its handler and an event to call it with, from
//! templates the binary holds, with AWS Lambda's handler and event.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::Context;
use crate::cli::Runtime;
use crate::config::is_function_name;
use crate::error::{Error, Kind};

const FUNCTION_TS: &str = include_str!("../../templates/function.ts");
const FUNCTION_PY: &str = include_str!("../../templates/function.py");
const EVENT: &str = include_str!("../../templates/event.json");
const README: &str = include_str!("../../templates/README.md");

/// The files of a new function's folder, by their path in it, with the function's name in them.
pub fn files(name: &str, runtime: Runtime) -> Vec<(&'static str, String)> {
    let (file, handler, language, extension) = match runtime {
        Runtime::Nodejs => ("function.ts", FUNCTION_TS, "TypeScript, for Node.js", "ts"),
        Runtime::Python => ("function.py", FUNCTION_PY, "Python", "py"),
    };
    let fill = |template: &str| {
        template.replace("{{name}}", name).replace("{{language}}", language).replace("{{extension}}", extension)
    };
    vec![(file, fill(handler)), ("events/event.json", EVENT.to_owned()), ("README.md", fill(README))]
}

#[derive(Serialize)]
struct Created {
    name: String,
    runtime: &'static str,
    folder: PathBuf,
    files: Vec<String>,
}

/// Writes the folder, which must not exist yet, or be empty.
pub fn create(folder: &Path, name: &str, runtime: Runtime) -> Result<Vec<PathBuf>, Error> {
    if !is_function_name(name) {
        return Err(Error::new(
            Kind::Usage,
            format!(
                "\"{name}\" can't be a function's name: 1 to 64 letters, digits, hyphens or underscores, as on AWS Lambda"
            ),
        ));
    }
    let occupied = std::fs::read_dir(folder).map(|mut entries| entries.next().is_some()).unwrap_or(false);
    if occupied {
        return Err(Error::new(
            Kind::Usage,
            format!("{} already holds files: ff init makes a new folder", folder.display()),
        ));
    }
    let failed = |path: &Path, error: std::io::Error| {
        Error::new(Kind::Failed, format!("Couldn't write {}: {error}", path.display()))
    };
    let mut written = Vec::new();
    for (relative, text) in files(name, runtime) {
        let path = folder.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| failed(parent, error))?;
        }
        std::fs::write(&path, text).map_err(|error| failed(&path, error))?;
        written.push(path);
    }
    Ok(written)
}

pub fn run(name: &str, runtime: Runtime, context: &Context) -> Result<(), Error> {
    let folder = PathBuf::from(name);
    let written = create(&folder, name, runtime)?;
    let created = Created {
        name: name.to_owned(),
        runtime: runtime.as_str(),
        folder: folder.clone(),
        files: written.iter().map(|path| path.display().to_string()).collect(),
    };
    context.out.result(&created, || {
        format!(
            "created {}\nthen: cd {name} && ff local invoke . --data @events/event.json, and ff deploy function.{} to put it on FF",
            created.files.join(", "),
            if runtime == Runtime::Nodejs { "ts" } else { "py" }
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_python_function_has_its_handler_an_event_and_a_readme_with_its_name() {
        let files = files("orders", Runtime::Python);
        let paths: Vec<&str> = files.iter().map(|(path, _)| *path).collect();

        assert_eq!(paths, ["function.py", "events/event.json", "README.md"]);
        assert_eq!(
            files[0].1,
            "# orders: a function in Python, with AWS Lambda's handler: FF calls handler(event, context),\n\
             # and event is what the caller sent, as a payload is on Lambda. The code moves to Lambda as it is.\n\
             def handler(event, context):\n    name = event.get(\"name\", \"world\")\n    \
             print(f\"greeting {name}\")  # a line of the function's log: ff logs orders\n    \
             return {\"message\": f\"Hello {name}\", \"requestId\": context.aws_request_id}\n"
        );
        assert_eq!(files[1].1, "{\n  \"name\": \"Tunis\"\n}\n");
        assert!(
            files[2].1.starts_with("# orders\n\nA function for FF, in Python: `function.py` holds its handler"),
            "{}",
            files[2].1
        );
        assert!(files[2].1.contains("ff invoke orders --data @events/event.json"));
        assert!(!files.iter().any(|(_, text)| text.contains("{{")), "every placeholder is filled");
    }

    #[test]
    fn a_nodejs_function_is_typescript() {
        let files = files("orders", Runtime::Nodejs);

        assert_eq!(files[0].0, "function.ts");
        assert!(
            files[0]
                .1
                .contains("export async function handler(event: { name?: string }, context: { awsRequestId: string })")
        );
        assert!(files[2].1.contains("in TypeScript, for Node.js: `function.ts`"));
    }

    #[test]
    fn it_makes_a_new_folder_and_refuses_one_with_files_or_a_name_lambda_refuses() {
        let dir = tempfile::TempDir::new().unwrap();
        let folder = dir.path().join("orders");

        let written = create(&folder, "orders", Runtime::Python).unwrap();
        assert_eq!(written.len(), 3);
        assert!(folder.join("events/event.json").is_file());
        assert_eq!(create(&folder, "orders", Runtime::Python).unwrap_err().exit_code(), 2);
        assert_eq!(create(&dir.path().join("my orders"), "my orders", Runtime::Python).unwrap_err().exit_code(), 2);
    }
}
