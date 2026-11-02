//! A function's folder as a project to package: its runtime and how its libraries come, the
//! handler it most likely has, and the steps that install them into a copy of it.

use std::path::{Path, PathBuf};

use crate::cli::Runtime;
use crate::error::Error;

/// How a project's libraries come.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Libraries {
    /// package.json: npm installs them into node_modules.
    Npm,
    /// requirements.txt: pip installs them next to the code.
    Requirements,
    /// pyproject.toml's [project] dependencies, which ff writes as requirements for pip.
    Pyproject(Vec<String>),
    /// None to install: the folder as it is.
    None,
}

#[derive(Debug)]
pub struct Project {
    pub root: PathBuf,
    pub runtime: Runtime,
    pub libraries: Libraries,
}

/// The files at the folder's root whose extensions say a runtime.
fn root_code(root: &Path) -> (bool, bool) {
    let mut node = false;
    let mut python = false;
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let name = entry.file_name();
        match Path::new(&name).extension().and_then(|extension| extension.to_str()) {
            Some("js" | "mjs" | "cjs" | "ts") => node = true,
            Some("py") => python = true,
            _ => {}
        }
    }
    (node, python)
}

/// pyproject.toml's `[project] dependencies`, as PEP 621 writes them.
fn pyproject_dependencies(file: &Path) -> Result<Vec<String>, Error> {
    let text = std::fs::read_to_string(file)
        .map_err(|error| Error::usage(format!("Couldn't read {}: {error}", file.display())))?;
    let document: toml_edit::DocumentMut =
        text.parse().map_err(|error| Error::usage(format!("{} isn't TOML ff can read: {error}", file.display())))?;
    let Some(dependencies) = document.get("project").and_then(|project| project.get("dependencies")) else {
        return Ok(Vec::new());
    };
    let array = dependencies.as_array().ok_or_else(|| {
        Error::usage(format!("{}: [project] dependencies must be a list of requirements", file.display()))
    })?;
    Ok(array.iter().filter_map(|value| value.as_str().map(str::to_owned)).collect())
}

impl Project {
    /// The project in `root`: package.json says Node.js, requirements.txt or pyproject.toml Python;
    /// neither, the code at its root does. `--runtime` decides when both could be.
    pub fn detect(root: &Path, runtime: Option<Runtime>) -> Result<Project, Error> {
        if !root.is_dir() {
            return Err(Error::usage(format!("{} isn't a folder", root.display())));
        }
        let npm = root.join("package.json").is_file();
        let requirements = root.join("requirements.txt").is_file();
        let pyproject = root.join("pyproject.toml").is_file();
        let python = requirements || pyproject;
        let runtime = match (runtime, npm, python) {
            (Some(runtime), _, _) => runtime,
            (None, true, false) => Runtime::Nodejs,
            (None, false, true) => Runtime::Python,
            (None, true, true) => {
                return Err(Error::usage(format!(
                    "{} has a package.json and Python's requirements: name the runtime with --runtime",
                    root.display()
                )));
            }
            (None, false, false) => match root_code(root) {
                (true, false) => Runtime::Nodejs,
                (false, true) => Runtime::Python,
                _ => {
                    return Err(Error::usage(format!(
                        "Can't tell the runtime of {}: name it with --runtime",
                        root.display()
                    )));
                }
            },
        };
        let libraries = match runtime {
            Runtime::Nodejs if npm => Libraries::Npm,
            Runtime::Python if requirements => Libraries::Requirements,
            Runtime::Python if pyproject => Libraries::Pyproject(pyproject_dependencies(&root.join("pyproject.toml"))?),
            _ => Libraries::None,
        };
        Ok(Project { root: root.to_owned(), runtime, libraries })
    }
}

/// The handler a package most likely has, from its files: `function.handler` where `ff init`'s
/// file is; else AWS Lambda's own defaults, `index.handler` for Node.js and
/// `lambda_function.lambda_handler` for Python. None: the command names it with --handler.
pub fn default_handler(files: &[String], runtime: Runtime) -> Option<String> {
    let has = |name: &str| files.iter().any(|file| file == name);
    match runtime {
        Runtime::Nodejs => ["function", "index"]
            .into_iter()
            .find(|module| ["js", "mjs", "cjs", "ts"].iter().any(|extension| has(&format!("{module}.{extension}"))))
            .map(|module| format!("{module}.handler")),
        Runtime::Python => {
            if has("function.py") {
                Some("function.handler".to_owned())
            } else if has("lambda_function.py") {
                Some("lambda_function.lambda_handler".to_owned())
            } else {
                None
            }
        }
    }
}

/// What keeps the package's files from holding the module the handler names, as the runtime
/// looks for it, in the API's words, or nothing: Node.js's file with .js, .mjs, .cjs, .ts or
/// none, or a folder; Python's module, its compiled extension, or its package's folder. The API
/// checks the handler's syntax; a handler without a function's name is refused here, as it
/// names no module.
pub fn handler_problem(files: &[String], handler: &str, runtime: Runtime) -> Option<String> {
    let name = handler.rsplit('/').next().unwrap_or(handler);
    let folders = &handler[..handler.len() - name.len()];
    let dot = match runtime {
        Runtime::Python => name.rfind('.'),
        Runtime::Nodejs => name.find('.'),
    };
    let Some(dot) = dot.filter(|dot| *dot > 0 && *dot < name.len() - 1) else {
        return Some(format!(
            "The handler {handler} names no function: it is <file>.<function>, such as index.handler"
        ));
    };
    let module = match runtime {
        // Python imports the module by its dotted name, a folder's dots included.
        Runtime::Python => format!("{folders}{}", &name[..dot]).replace('.', "/"),
        Runtime::Nodejs => format!("{folders}{}", &name[..dot]),
    };
    let holds = files.iter().any(|file| match runtime {
        Runtime::Python => {
            *file == format!("{module}.py")
                || (file.starts_with(&format!("{module}.")) && file.ends_with(".so"))
                || file.starts_with(&format!("{module}/"))
        }
        Runtime::Nodejs => {
            *file == module
                || ["js", "mjs", "cjs", "ts"].iter().any(|extension| *file == format!("{module}.{extension}"))
                || file.starts_with(&format!("{module}/"))
        }
    });
    if holds {
        return None;
    }
    let wanted = match runtime {
        Runtime::Python => format!("{module}.py, nor a package {module}/"),
        Runtime::Nodejs => format!("{module}.js, .mjs, .cjs or .ts, nor a folder {module}/"),
    };
    Some(format!("The package has no {wanted}, which the handler {handler} names"))
}

/// How a build goes: the project's lockfile and build script, whether TypeScript is compiled,
/// and whether it runs in a container of the runtime's base.
#[derive(Clone, Copy, Debug, Default)]
pub struct Build {
    pub lockfile: bool,
    pub build_script: bool,
    pub compile: bool,
    pub container: bool,
}

/// The commands that install a project's libraries into its copy, as a shell runs them there.
/// npm installs the build's tools too, runs the build script and, asked to, the project's own
/// TypeScript compiler, then drops them. On this machine, pip takes only wheels for the
/// runtimes' platform: Linux x86_64, glibc 2.28 or older, Python 3.13, as FF's runtime (glibc
/// 2.41) and AWS Lambda's (Amazon Linux 2023) both run them; in a container of the runtime's
/// base, which is that platform, it takes what it finds, a library published as source too.
pub fn build_steps(project: &Project, build: Build) -> Vec<Vec<String>> {
    let words = |line: &str| line.split(' ').map(str::to_owned).collect::<Vec<_>>();
    match &project.libraries {
        Libraries::Npm => {
            let mut steps = vec![words(if build.lockfile {
                "npm ci --no-audit --no-fund"
            } else {
                "npm install --no-audit --no-fund"
            })];
            if build.build_script {
                steps.push(words("npm run build"));
            }
            if build.compile {
                steps.push(words("node node_modules/typescript/bin/tsc -p ."));
            }
            // The build's tools go: only what the function needs to run is packaged.
            steps.push(words("npm prune --omit=dev --no-audit --no-fund"));
            steps
        }
        Libraries::Requirements | Libraries::Pyproject(_) if build.container => vec![words(
            "python3 -m pip install --quiet --disable-pip-version-check --no-compile --target . --upgrade -r requirements.txt",
        )],
        Libraries::Requirements | Libraries::Pyproject(_) => vec![words(
            "python3 -m pip install --quiet --disable-pip-version-check --no-compile --target . \
             --platform manylinux_2_28_x86_64 --implementation cp --python-version 3.13 --only-binary=:all: \
             --upgrade -r requirements.txt",
        )],
        Libraries::None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Kind;

    fn folder(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().unwrap();
        for (name, text) in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        dir
    }

    #[test]
    fn tells_the_runtime_and_the_libraries_from_the_folder() {
        let detect = |files: &[(&str, &str)]| {
            let dir = folder(files);
            Project::detect(dir.path(), None).map(|project| (project.runtime, project.libraries))
        };

        assert_eq!(detect(&[("package.json", "{}")]).unwrap(), (Runtime::Nodejs, Libraries::Npm));
        assert_eq!(detect(&[("requirements.txt", "requests\n")]).unwrap(), (Runtime::Python, Libraries::Requirements));
        assert_eq!(
            detect(&[(
                "pyproject.toml",
                "[project]\nname = \"orders\"\ndependencies = [\"requests>=2\", \"numpy\"]\n"
            )])
            .unwrap(),
            (Runtime::Python, Libraries::Pyproject(vec!["requests>=2".into(), "numpy".into()]))
        );
        assert_eq!(detect(&[("lambda_function.py", "")]).unwrap(), (Runtime::Python, Libraries::None));
        assert_eq!(detect(&[("index.mjs", "")]).unwrap(), (Runtime::Nodejs, Libraries::None));
        assert_eq!(detect(&[("package.json", "{}"), ("requirements.txt", "")]).unwrap_err().kind, Kind::Usage);
        assert_eq!(detect(&[("README.md", "")]).unwrap_err().kind, Kind::Usage);
    }

    #[test]
    fn lets_runtime_decide_when_the_folder_could_be_either() {
        let dir = folder(&[("package.json", "{}"), ("requirements.txt", "")]);

        let project = Project::detect(dir.path(), Some(Runtime::Python)).unwrap();
        assert_eq!((project.runtime, project.libraries), (Runtime::Python, Libraries::Requirements));
    }

    #[test]
    fn finds_the_handler_ff_init_or_aws_lambda_would_have_made() {
        let files = |names: &[&str]| names.iter().map(|name| name.to_string()).collect::<Vec<_>>();

        assert_eq!(
            default_handler(&files(&["function.ts", "index.js"]), Runtime::Nodejs).as_deref(),
            Some("function.handler")
        );
        assert_eq!(default_handler(&files(&["index.mjs"]), Runtime::Nodejs).as_deref(), Some("index.handler"));
        assert_eq!(
            default_handler(&files(&["lambda_function.py"]), Runtime::Python).as_deref(),
            Some("lambda_function.lambda_handler")
        );
        assert_eq!(default_handler(&files(&["src/app.js"]), Runtime::Nodejs), None);
    }

    #[test]
    fn looks_for_the_handlers_module_as_the_runtime_and_the_api_do() {
        let files =
            ["src/handlers/orders.js", "lib/greet/index.js", "app/__init__.py", "fast.cpython-313-x86_64-linux-gnu.so"]
                .map(String::from)
                .to_vec();
        let holds = |handler: &str, runtime: Runtime| handler_problem(&files, handler, runtime).is_none();

        assert!(holds("src/handlers/orders.api.get", Runtime::Nodejs));
        assert!(holds("lib/greet.handler", Runtime::Nodejs));
        assert!(holds("app.handler", Runtime::Python));
        assert!(holds("fast.handler", Runtime::Python));
        assert_eq!(
            handler_problem(&files, "index.handler", Runtime::Nodejs).unwrap(),
            "The package has no index.js, .mjs, .cjs or .ts, nor a folder index/, which the handler index.handler names"
        );
        assert_eq!(
            handler_problem(&files, "src/handlers/orders.create", Runtime::Python).unwrap(),
            "The package has no src/handlers/orders.py, nor a package src/handlers/orders/, which the handler src/handlers/orders.create names"
        );
        assert!(
            handler_problem(&files, "src/index", Runtime::Nodejs)
                .unwrap()
                .ends_with("names no function: it is <file>.<function>, such as index.handler")
        );
        assert!(handler_problem(&files, "app.", Runtime::Python).unwrap().contains("names no function"));
    }

    #[test]
    fn installs_npm_libraries_with_the_lockfile_builds_compiles_then_drops_the_build_tools() {
        let project = Project { root: PathBuf::new(), runtime: Runtime::Nodejs, libraries: Libraries::Npm };
        let lines = |steps: Vec<Vec<String>>| steps.into_iter().map(|step| step.join(" ")).collect::<Vec<_>>();

        assert_eq!(
            lines(build_steps(&project, Build { lockfile: true, build_script: true, compile: true, container: false })),
            [
                "npm ci --no-audit --no-fund",
                "npm run build",
                "node node_modules/typescript/bin/tsc -p .",
                "npm prune --omit=dev --no-audit --no-fund"
            ]
        );
        assert_eq!(
            lines(build_steps(&project, Build::default())),
            ["npm install --no-audit --no-fund", "npm prune --omit=dev --no-audit --no-fund"]
        );
    }

    #[test]
    fn installs_python_wheels_for_the_runtimes_platform_not_the_machines() {
        let project = Project { root: PathBuf::new(), runtime: Runtime::Python, libraries: Libraries::Requirements };
        let step = build_steps(&project, Build::default()).remove(0).join(" ");

        for flag in [
            "--platform manylinux_2_28_x86_64",
            "--python-version 3.13",
            "--only-binary=:all:",
            "--target .",
            "-r requirements.txt",
        ] {
            assert!(step.contains(flag), "{step}");
        }

        // A container of the runtime's base is that platform: pip takes what it finds there.
        let step = build_steps(&project, Build { container: true, ..Build::default() }).remove(0).join(" ");
        assert!(
            !step.contains("--platform")
                && !step.contains("--only-binary")
                && step.contains("--target . --upgrade -r requirements.txt"),
            "{step}"
        );
    }
}
