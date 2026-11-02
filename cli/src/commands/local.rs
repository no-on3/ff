//! `ff local invoke` and `ff local start`: a function run on this machine before it is deployed,
//! in the runtime image and with the hardening production gives it.

use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::{Value, json};

use super::Context;
use super::deploy::{name_of, runtime_of};
use super::invoke::input_of;
use crate::cli::{Format, LocalArgs, Runtime};
use crate::error::{Error, Kind};
use crate::local::{self, Answer, Code, Container, LocalFunction, Readiness};
use crate::local_url;
use crate::progress::Progress;

/// The function a path holds: a file, its runtime from its extension; or a folder, its runtime
/// from the `function.*` file in it. Its name is the file's or the folder's, unless named.
pub fn local_function(args: &LocalArgs) -> Result<LocalFunction, Error> {
    let code = Code::of(&args.path)?;
    let runtime = match &code {
        Code::File { path, .. } => runtime_of(path, args.runtime)?,
        Code::Folder(dir) => match args.runtime {
            Some(runtime) => runtime,
            None => folder_runtime(dir)?,
        },
    };
    let path = match &code {
        Code::File { path, .. } | Code::Folder(path) => path.clone(),
    };
    let environment = super::env::variables(&args.env)?;
    if let Some(problem) = environment.keys().find_map(|name| super::env::reserved(name)) {
        return Err(Error::usage(problem));
    }
    Ok(LocalFunction {
        name: name_of(&path, args.name.as_deref())?,
        runtime,
        memory: args.memory,
        timeout: args.timeout,
        code,
        environment,
    })
}

fn folder_runtime(dir: &Path) -> Result<Runtime, Error> {
    let has = |file: &str| dir.join(file).is_file();
    if ["function.ts", "function.js", "function.mjs", "function.cjs"].into_iter().any(has) {
        Ok(Runtime::Nodejs)
    } else if has("function.py") {
        Ok(Runtime::Python)
    } else {
        Err(Error::usage(format!(
            "{} has no function.ts, function.js, function.mjs, function.cjs or function.py, which the runtime loads: name a file, or the runtime with --runtime",
            dir.display()
        )))
    }
}

/// The runtime's refusal of a call: a function's error, its timeout or its memory exit 5, as
/// they do through the API; anything else is a failure of the run itself.
pub fn answer_error(answer: &Answer) -> Option<Error> {
    if answer.status == 200 {
        return None;
    }
    let body: Value = serde_json::from_str(&answer.body).unwrap_or_default();
    let error_type = body["errorType"].as_str().unwrap_or("Runtime.Unknown");
    let message = body["errorMessage"].as_str().unwrap_or(answer.body.trim());
    let the_functions =
        answer.function_error || matches!(error_type, "Sandbox.Timedout" | "Runtime.OutOfMemory" | "Runtime.ExitError");
    Some(Error::new(
        if the_functions { Kind::InvocationFailed } else { Kind::Failed },
        format!("{error_type}: {message}"),
    ))
}

fn print_log(context: &Context, log: &str) {
    if context.out.quiet || context.out.format == Format::Json || log.trim().is_empty() {
        return;
    }
    eprintln!("{}", log.trim_end());
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalCall {
    output: Value,
    request_id: Option<String>,
    duration_ms: Option<f64>,
    max_memory_used_mb: Option<f64>,
    log: Vec<String>,
}

/// Starts the container and waits for the code to load; a failed load exits 4, with its log.
fn started(function: &LocalFunction, image: &str, port: Option<u16>, context: &Context) -> Result<Container, Error> {
    let progress = Progress::start(
        context.out,
        &format!("starting {} ({}, {} MB) in {image}", function.name, function.runtime.as_str(), function.memory),
    );
    let started = Container::start(function, image, port).and_then(|container| {
        let readiness = local::wait_until_ready(&container, function.timeout)?;
        Ok((container, readiness))
    });
    progress.stop();
    let (container, readiness) = started?;
    if let Readiness::Failed { error_type, message } = readiness {
        print_log(context, &container.logs());
        return Err(Error::new(Kind::DeployFailed, format!("The function failed to load: {error_type}: {message}")));
    }
    Ok(container)
}

pub fn invoke(args: &LocalArgs, data: Option<&str>, raw: bool, context: &Context) -> Result<(), Error> {
    let function = local_function(args)?;
    let event = input_of(data)?.unwrap_or_else(|| json!({}));
    let image = local::image(function.runtime, &|name| std::env::var(name).ok());
    local::check_docker(&image)?;
    local::remove_on_interrupt();

    let container = started(&function, &image, None, context)?;
    let answer = local::invoke(&container, &event, function.timeout)?;
    let log = container.logs();
    drop(container);
    print_log(context, &log);
    if let Some(error) = answer_error(&answer) {
        return Err(error);
    }
    let output: Value = serde_json::from_str(&answer.body).unwrap_or(Value::String(answer.body.clone()));
    if raw && context.out.format == Format::Text {
        return context.out.result(&output, || output.to_string());
    }
    let call = LocalCall {
        output,
        request_id: answer.request_id.clone(),
        duration_ms: answer.duration_ms.as_deref().and_then(|value| value.parse().ok()),
        max_memory_used_mb: answer.memory_mb.as_deref().and_then(|value| value.parse().ok()),
        log: log.lines().map(str::to_owned).collect(),
    };
    context.out.result(&call, || {
        let mut summary: Vec<String> = call.request_id.iter().map(|id| format!("request {id}")).collect();
        summary.extend(call.duration_ms.map(|duration| format!("{duration} ms")));
        summary.extend(call.max_memory_used_mb.map(|memory| format!("{memory} MB")));
        format!(
            "{}\n{}, on this machine",
            serde_json::to_string_pretty(&call.output).expect("JSON serializes"),
            summary.join(" · ")
        )
    })
}

pub fn start(args: &LocalArgs, port: Option<u16>, watch: bool, url: bool, context: &Context) -> Result<(), Error> {
    let function = local_function(args)?;
    let image = local::image(function.runtime, &|name| std::env::var(name).ok());
    local::check_docker(&image)?;
    local::remove_on_interrupt();

    // As its URL: a front on the port asked for, calling the container wherever it runs, a restart's too.
    let front = if url {
        let listener = TcpListener::bind(("127.0.0.1", port.unwrap_or(0))).map_err(|error| {
            Error::new(Kind::Failed, format!("Couldn't listen on 127.0.0.1:{}: {error}", port.unwrap_or(0)))
        })?;
        let address = format!("http://127.0.0.1:{}/", listener.local_addr().map(|address| address.port()).unwrap_or(0));
        let runtime_port = Arc::new(AtomicU16::new(0));
        local_url::serve(listener, Arc::clone(&runtime_port), function.timeout);
        Some((address, runtime_port))
    } else {
        None
    };
    let mut port = if url { None } else { port };
    loop {
        let container = match started(&function, &image, port, context) {
            Ok(container) => container,
            // While watching, code that doesn't load waits for the next change.
            Err(error) if watch && error.kind == Kind::DeployFailed => {
                context.out.warn(&format!("{error}: ff starts it again when a file changes"));
                wait_for_change(&function.code)?;
                continue;
            }
            Err(error) => return Err(error),
        };
        let again = if watch { "; a change of its code starts it again" } else { "" };
        let (address, how) = match &front {
            Some((address, runtime_port)) => {
                runtime_port.store(container.port, Ordering::SeqCst);
                (address.clone(), "as its URL would")
            }
            None => {
                port = Some(container.port);
                (container.url("/invoke"), "")
            }
        };
        context.out.result(&json!({ "name": function.name, "url": address }), || {
            if url {
                format!(
                    "{} ({}) runs {how} at {address}: any request calls it with AWS Lambda's URL event. Ctrl-C stops it{again}",
                    function.name,
                    function.runtime.as_str()
                )
            } else {
                format!("{} ({}) runs at {address}: POST an event to it. Ctrl-C stops it{again}", function.name, function.runtime.as_str())
            }
        })?;
        // Its log as it comes, on stderr, until the container goes, or a file changes: stdout has the address alone.
        let mut logs = Command::new("docker")
            .args(["logs", "--follow", &container.name])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|error| Error::new(Kind::Failed, format!("Couldn't follow the function's log: {error}")))?;
        if let Some(mut lines) = logs.stdout.take() {
            std::thread::spawn(move || std::io::copy(&mut lines, &mut std::io::stderr()));
        }
        if !watch {
            let _ = logs.wait();
            return Ok(());
        }
        wait_for_change(&function.code)?;
        let _ = logs.kill();
        let _ = logs.wait();
        drop(container);
        context.out.warn(&format!("{} changed: starting it again", path_of(&function.code).display()));
    }
}

fn path_of(code: &Code) -> &Path {
    match code {
        Code::File { path, .. } | Code::Folder(path) => path,
    }
}

/// Blocks until the code changes: its file (watched through its folder, since an editor may
/// replace it), or anything in its folder; then until a second passes without another change of
/// it. Other files of the folder, which may be written all the time, are let be.
fn wait_for_change(code: &Code) -> Result<(), Error> {
    let failed =
        |error: notify::Error| Error::new(Kind::Failed, format!("Couldn't watch the code for changes: {error}"));
    let (sender, changes) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(sender).map_err(failed)?;
    let (watched, file, mode) = match code {
        Code::File { path, .. } => (path.parent().unwrap_or(path), Some(path.as_path()), RecursiveMode::NonRecursive),
        Code::Folder(dir) => (dir.as_path(), None, RecursiveMode::Recursive),
    };
    watcher.watch(watched, mode).map_err(failed)?;
    let relevant = |event: &notify::Event| {
        !event.kind.is_access()
            && file.is_none_or(|file| event.paths.iter().any(|path| path.file_name() == file.file_name()))
    };
    loop {
        let event =
            changes.recv().map_err(|_| Error::new(Kind::Failed, "The watch of the code ended"))?.map_err(failed)?;
        if relevant(&event) {
            break;
        }
    }
    let mut quiet_from = Instant::now();
    while let Some(left) = Duration::from_secs(1).checked_sub(quiet_from.elapsed()) {
        match changes.recv_timeout(left) {
            Ok(Ok(event)) if relevant(&event) => quiet_from = Instant::now(),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(path: &Path) -> LocalArgs {
        LocalArgs { path: path.to_owned(), name: None, runtime: None, memory: 128, timeout: 5, env: Vec::new() }
    }

    #[test]
    fn a_file_or_a_folder_says_its_name_and_runtime() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("hello.py");
        std::fs::write(&file, "def handler(event, context): return 1\n").unwrap();
        let app = dir.path().join("orders-api");
        std::fs::create_dir(&app).unwrap();
        std::fs::write(app.join("function.ts"), "export const handler = async () => 1;\n").unwrap();

        let from_file = local_function(&args(&file)).unwrap();
        let from_folder = local_function(&args(&app)).unwrap();

        assert_eq!((from_file.name.as_str(), from_file.runtime), ("hello", Runtime::Python));
        assert!(matches!(from_file.code, Code::File { ref extension, .. } if extension == "py"));
        assert_eq!((from_folder.name.as_str(), from_folder.runtime), ("orders-api", Runtime::Nodejs));
        assert!(matches!(from_folder.code, Code::Folder(_)));
        // An ES module, which the runtime imports as AWS Lambda's does.
        let module = dir.path().join("module");
        std::fs::create_dir(&module).unwrap();
        std::fs::write(module.join("function.mjs"), "export const handler = async () => 1;\n").unwrap();
        assert_eq!(local_function(&args(&module)).unwrap().runtime, Runtime::Nodejs);
        let empty = dir.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        assert_eq!(local_function(&args(&empty)).unwrap_err().exit_code(), 2);
        assert_eq!(local_function(&args(&dir.path().join("missing.py"))).unwrap_err().exit_code(), 2);
    }

    fn answer(status: u16, function_error: bool, body: &str) -> Answer {
        Answer { status, request_id: None, duration_ms: None, memory_mb: None, function_error, body: body.into() }
    }

    #[test]
    fn the_runtimes_refusals_exit_as_through_the_api() {
        let error = |answer: Answer| answer_error(&answer).map(|error| (error.exit_code(), error.message));

        assert_eq!(error(answer(200, false, "{}")), None);
        assert_eq!(
            error(answer(500, true, r#"{"errorType":"ValueError","errorMessage":"bad"}"#)),
            Some((5, "ValueError: bad".into()))
        );
        assert_eq!(
            error(answer(
                504,
                false,
                r#"{"errorType":"Sandbox.Timedout","errorMessage":"Task timed out after 1.00 seconds"}"#
            )),
            Some((5, "Sandbox.Timedout: Task timed out after 1.00 seconds".into()))
        );
        assert_eq!(
            error(answer(
                500,
                false,
                r#"{"errorType":"Runtime.OutOfMemory","errorMessage":"Runtime exceeded its memory limit"}"#
            ))
            .map(|(code, _)| code),
            Some(5)
        );
        assert_eq!(
            error(answer(
                413,
                false,
                r#"{"errorType":"RequestEntityTooLargeException","errorMessage":"Request must be smaller"}"#
            ))
            .map(|(code, _)| code),
            Some(3)
        );
    }
}
