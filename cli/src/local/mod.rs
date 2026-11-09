//! A function run on this machine as production runs it (ADR 0002): in its runtime image, on
//! Docker, with the pod's hardening (a read-only root, uid 10001, no capability, no new
//! privileges), its memory and CPU, and the variables the backend gives a function's pod; started,
//! its code loaded, called and its log followed the same way by each of `ff local`'s commands.
//! [`images`] finds its runtime's image, [`http`] serves HTTP on this machine, [`url`] serves a
//! function as its URL would, [`schedules`] runs a template's schedules, [`sqs`] keeps its queues, [`mappings`]
//! reads them for the functions whose SQS events name them, [`s3`] keeps its buckets, and [`services`] runs the
//! PostgreSQL and the Valkey `--with` asks for.

pub mod events;
pub mod front_door;
pub mod http;
pub mod images;
pub mod instances;
pub mod key;
pub mod mappings;
pub mod s3;
pub mod schedule_expression;
pub mod schedules;
pub mod services;
pub mod sqs;
pub mod sqs_event;
pub mod url;

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::cli::Runtime;
use crate::error::{Error, Kind};

/// The repository's runtime images, as `docker build` tags them from `runtimes/`: those a build without a release's
/// manifest runs (`images`), the protocol this CLI speaks theirs.
pub const NODEJS_IMAGE: &str = "ff-runtime-nodejs:24-v3";
pub const PYTHON_IMAGE: &str = "ff-runtime-python:3.13-v3";
/// The runtime's port inside its container.
const RUNTIME_PORT: u16 = 8080;
/// The runtime's uid in production, which owns nothing in the image.
const RUNTIME_UID: u32 = 10001;

/// What runs: the code mounted read-only at /var/task, and its settings.
#[derive(Clone, Debug)]
pub struct LocalFunction {
    pub name: String,
    pub runtime: Runtime,
    pub memory: u32,
    pub timeout: u32,
    pub code: Code,
    /// What the runtime calls: the module's path from the code's root, a dot, and its function.
    pub handler: String,
    /// The function's own variables.
    pub environment: std::collections::BTreeMap<String, String>,
    /// Variables whose values `docker run` takes from its own environment, by their names alone, so that no command
    /// line shows them: a template's secrets, and its functions' key.
    pub secrets: std::collections::BTreeMap<String, String>,
    /// The names it reaches other machines by, each with its address as Docker's `--add-host` takes it: this machine,
    /// as `host-gateway`, at `host.docker.internal`, where a template's front door listens, and at each bucket's name
    /// under it, as AWS's SDK for JavaScript addresses a bucket; the data services, at their addresses on Docker's
    /// network.
    pub hosts: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Code {
    /// One file, mounted as /var/task/function.<extension>, as the backend's one-file package of inline code has it.
    File { path: PathBuf, extension: String },
    /// A folder, mounted as /var/task.
    Folder(PathBuf),
}

impl Code {
    /// The file or folder, by its absolute path, which Docker's mounts need.
    pub fn of(path: &Path) -> Result<Code, Error> {
        let absolute = std::fs::canonicalize(path)
            .map_err(|error| Error::usage(format!("Couldn't open {}: {error}", path.display())))?;
        if absolute.is_dir() {
            return Ok(Code::Folder(absolute));
        }
        let extension = absolute.extension().and_then(|extension| extension.to_str()).unwrap_or("").to_owned();
        Ok(Code::File { path: absolute, extension })
    }
}

/// AWS Lambda's CPU for the memory, as the pods get it: 1 vCPU per 1,769 MB, 0.1 at least.
pub fn cpus(memory: u32) -> String {
    let millis = (u64::from(memory) * 1000).div_ceil(1769).max(100);
    format!("{}.{:03}", millis / 1000, millis % 1000)
}

/// `docker run`'s arguments: detached, removed once stopped, named, with production's
/// hardening and variables, the code read-only, and the port on this machine only (any free
/// one when none is given).
pub fn run_args(function: &LocalFunction, container: &str, image: &str, port: Option<u16>) -> Vec<String> {
    let timeout_ms = u64::from(function.timeout) * 1000;
    let mut args: Vec<String> = [
        "run",
        "--detach",
        "--rm",
        "--name",
        container,
        "--read-only",
        "--tmpfs",
        "/tmp:rw,size=512m,mode=1777",
        "--user",
        &format!("{RUNTIME_UID}:{RUNTIME_UID}"),
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        &format!("{}m", function.memory),
        "--memory-swap",
        &format!("{}m", function.memory),
        "--cpus",
        &cpus(function.memory),
        "--publish",
        &format!("127.0.0.1:{}:{RUNTIME_PORT}", port.map(|port| port.to_string()).unwrap_or_default()),
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    let variables = [
        ("FUNCTION_NAME", function.name.clone()),
        ("FUNCTION_VERSION", "$LATEST".to_owned()),
        ("FUNCTION_MEMORY_LIMIT", function.memory.to_string()),
        ("FUNCTION_TIMEOUT", timeout_ms.to_string()),
        ("FF_MAX_QUEUE_WAIT_MS", timeout_ms.to_string()),
        ("LAMBDA_TASK_ROOT", "/var/task".to_owned()),
        ("FF_HANDLER", function.handler.clone()),
        ("FF_EVENT_FORMAT", "lambda".to_owned()),
        ("PORT", RUNTIME_PORT.to_string()),
    ];
    for (name, value) in variables {
        args.push("--env".to_owned());
        args.push(format!("{name}={value}"));
    }
    // UTC, as on Lambda, unless the function sets its own, as the backend does for a pod.
    if !function.environment.contains_key("TZ") {
        args.extend(["--env".to_owned(), "TZ=UTC".to_owned()]);
    }
    for (name, value) in &function.environment {
        args.push("--env".to_owned());
        args.push(format!("{name}={value}"));
    }
    let mount = match &function.code {
        Code::File { path, extension } => format!("{}:/var/task/function.{extension}:ro", path.display()),
        Code::Folder(path) => format!("{}:/var/task:ro", path.display()),
    };
    args.push("--volume".to_owned());
    args.push(mount);
    for name in function.secrets.keys() {
        args.extend(["--env".to_owned(), name.clone()]);
    }
    for (name, address) in &function.hosts {
        args.extend(["--add-host".to_owned(), format!("{name}:{address}")]);
    }
    args.push(image.to_owned());
    args
}

/// A Docker command's output, or why Docker couldn't be run at all.
pub fn docker(args: &[String]) -> Result<Output, Error> {
    Command::new("docker").args(args).stdin(Stdio::null()).output().map_err(|error| {
        Error::new(Kind::Failed, format!("Couldn't run docker ({error}): ff local runs a function in Docker, in the runtime image production uses; install it, or start it"))
    })
}

pub fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_owned()
}

/// Docker answers: the image is `images::ready`'s to find.
pub fn check_docker() -> Result<(), Error> {
    let version = docker(&["version".into(), "--format".into(), "{{.Server.Version}}".into()])?;
    if !version.status.success() {
        return Err(Error::new(
            Kind::Failed,
            format!("Docker doesn't answer: {}. ff local runs a function in Docker: start it", stderr_of(&version)),
        ));
    }
    Ok(())
}

/// The containers running now, which Ctrl-C removes before ff exits, each with whether it is stopped first.
static RUNNING: Mutex<Vec<(String, bool)>> = Mutex::new(Vec::new());
/// Set by Ctrl-C: from then on, only the handler removes containers, and it ends ff.
static INTERRUPTED: AtomicBool = AtomicBool::new(false);

/// On Ctrl-C, the containers are removed, and ff exits as a shell expects of an interrupt. Until
/// it is done, a thread that would remove one too waits: two removals at once may leave the
/// container in place a moment longer than ff runs, and ff would exit with another code.
pub fn remove_on_interrupt() {
    let _ = ctrlc::set_handler(|| {
        INTERRUPTED.store(true, Ordering::SeqCst);
        let containers = RUNNING.lock().map(|containers| containers.clone()).unwrap_or_default();
        for (name, gently) in containers {
            remove(&name, gently);
        }
        std::process::exit(130);
    });
}

/// Removes a container; one kept `gently`, a data service's, is stopped first, so that it ends as its server ends,
/// within 10 s.
fn remove(name: &str, gently: bool) {
    if gently {
        let _ = docker(&["stop".into(), "--time".into(), "10".into(), name.to_owned()]);
    }
    let _ = docker(&["rm".into(), "--force".into(), name.to_owned()]);
}

/// A container ff started, removed when dropped: after the command, an error, or Ctrl-C.
pub struct Container {
    pub name: String,
    pub port: u16,
    /// Stopped before it is removed, as a data service is.
    gently: bool,
}

impl Container {
    /// A container Docker started for ff, kept from here on as its others are: removed when dropped or at Ctrl-C,
    /// stopped first when `gently`.
    pub fn kept(name: String, port: u16, gently: bool) -> Container {
        if let Ok(mut running) = RUNNING.lock() {
            running.push((name.clone(), gently));
        }
        Container { name, port, gently }
    }

    pub fn start(function: &LocalFunction, image: &str, port: Option<u16>) -> Result<Container, Error> {
        let name = format!("ff-local-{}-{}", function.name.to_ascii_lowercase(), std::process::id());
        let started = Command::new("docker")
            .args(run_args(function, &name, image, port))
            .envs(&function.secrets)
            .stdin(Stdio::null())
            .output()
            .map_err(|error| {
                Error::new(Kind::Failed, format!("Couldn't run docker ({error}): ff local runs a function in Docker"))
            })?;
        if !started.status.success() {
            return Err(Error::new(
                Kind::Failed,
                format!("Docker couldn't start the function: {}", stderr_of(&started)),
            ));
        }
        // Removed from here on, whatever happens next.
        let mut container = Container::kept(name, 0, false);
        let published = docker(&["port".into(), container.name.clone(), format!("{RUNTIME_PORT}/tcp")])?;
        let text = String::from_utf8_lossy(&published.stdout);
        match text.lines().find_map(|line| line.rsplit(':').next().and_then(|port| port.trim().parse().ok())) {
            Some(port) => {
                container.port = port;
                Ok(container)
            }
            None => {
                Err(Error::new(Kind::Failed, format!("Docker didn't say which port the function has: {}", text.trim())))
            }
        }
    }

    /// Starts it, then waits for its code to load: a load that failed is an error that exits 4, its log given to
    /// `failed_log` before the container goes.
    pub fn start_loaded(
        function: &LocalFunction,
        image: &str,
        port: Option<u16>,
        failed_log: impl FnOnce(&str),
    ) -> Result<Container, Error> {
        let container = Container::start(function, image, port)?;
        match wait_until_ready(&container, function.timeout)? {
            Readiness::Ready => Ok(container),
            Readiness::Failed { error_type, message } => {
                failed_log(&container.logs());
                Err(Error::new(Kind::DeployFailed, format!("The function failed to load: {error_type}: {message}")))
            }
        }
    }

    /// Its log as it comes, the runtime's and the function's, written to `sink` line by line until the container goes
    /// or the child is killed.
    pub fn follow_log(&self, sink: impl Write + Send + 'static) -> Result<Child, Error> {
        let mut follower = Command::new("docker")
            .args(["logs", "--follow", &self.name])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| Error::new(Kind::Failed, format!("Couldn't follow the function's log: {error}")))?;
        let sink = Arc::new(Mutex::new(sink));
        let streams: [Option<Box<dyn Read + Send>>; 2] = [
            follower.stdout.take().map(|stream| Box::new(stream) as Box<dyn Read + Send>),
            follower.stderr.take().map(|stream| Box::new(stream) as Box<dyn Read + Send>),
        ];
        for stream in streams.into_iter().flatten() {
            let sink = Arc::clone(&sink);
            std::thread::spawn(move || {
                let mut lines = BufReader::new(stream);
                let mut line = Vec::new();
                while lines.read_until(b'\n', &mut line).is_ok_and(|read| read > 0) {
                    if let Ok(mut sink) = sink.lock() {
                        let _ = sink.write_all(&line).and_then(|()| sink.flush());
                    }
                    line.clear();
                }
            });
        }
        Ok(follower)
    }

    /// Its log lines so far: the runtime's and the function's.
    pub fn logs(&self) -> String {
        docker(&["logs".into(), self.name.clone()])
            .map(|output| {
                format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr))
            })
            .unwrap_or_default()
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

impl Drop for Container {
    fn drop(&mut self) {
        if INTERRUPTED.load(Ordering::SeqCst) {
            // The handler removes it, then ends ff.
            loop {
                std::thread::park();
            }
        }
        remove(&self.name, self.gently);
        if let Ok(mut running) = RUNNING.lock() {
            running.retain(|(name, _)| *name != self.name);
        }
    }
}

/// An agent for the runtime on this machine: never through a proxy.
fn local_agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(timeout)).proxy(None).build().into()
}

/// What the runtime answered a call: its status, its headers' measures, its body, and its log's last 4 KB when asked.
pub struct Answer {
    pub status: u16,
    pub request_id: Option<String>,
    pub duration_ms: Option<String>,
    pub memory_mb: Option<String>,
    pub function_error: bool,
    pub body: String,
    pub log_result: Option<String>,
}

/// What a call asks of the runtime beside its event, as Lambda's `Invoke` asks it: its log's last 4 KB, given back in
/// base64; and the caller's ClientContext, passed on as sent.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Asks {
    pub log_tail: bool,
    pub client_context: Option<String>,
}

impl Answer {
    /// The function's own error, its type and its message, as Lambda's error document has them: what it threw, its
    /// timeout, its memory, its exit; none for its answer, or for a refusal of the call itself.
    pub fn function_error(&self) -> Option<(String, String)> {
        if self.status == 200 {
            return None;
        }
        let body: serde_json::Value = serde_json::from_str(&self.body).unwrap_or_default();
        let error_type = body["errorType"].as_str().unwrap_or("Runtime.Unknown");
        let the_functions = self.function_error
            || matches!(error_type, "Sandbox.Timedout" | "Runtime.OutOfMemory" | "Runtime.ExitError");
        the_functions
            .then(|| (error_type.to_owned(), body["errorMessage"].as_str().unwrap_or(self.body.trim()).to_owned()))
    }

    /// Whether the call ended the runtime's process, its memory or its exit, whose container then has to start again.
    pub fn ended_the_runtime(&self) -> bool {
        self.function_error()
            .is_some_and(|(error_type, _)| matches!(error_type.as_str(), "Runtime.OutOfMemory" | "Runtime.ExitError"))
    }
}

/// `POST /invoke` with the event to the runtime on this machine's port, as the backend calls a pod,
/// under the request's ID when one is given, which the function's context has, and with what the call asks: waited
/// for up to the timeout and 10 s more.
pub fn call(
    port: u16,
    event: &serde_json::Value,
    request_id: Option<&str>,
    asks: &Asks,
    timeout: u32,
) -> Result<Answer, Error> {
    let agent = local_agent(Duration::from_secs(u64::from(timeout) + 10));
    let mut request = agent.post(format!("http://127.0.0.1:{port}/invoke")).header("content-type", "application/json");
    if let Some(id) = request_id {
        request = request.header("x-ff-request-id", id);
    }
    if asks.log_tail {
        request = request.header("x-ff-log-type", "Tail");
    }
    if let Some(context) = &asks.client_context {
        request = request.header("x-ff-client-context", context);
    }
    let mut response = request
        .send(event.to_string())
        .map_err(|error| Error::new(Kind::Failed, format!("The function's container didn't answer: {error}")))?;
    let header = |name: &str| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_owned);
    let (request_id, duration_ms, memory_mb, function_error, log_result) = (
        header("x-ff-request-id"),
        header("x-ff-duration-ms"),
        header("x-ff-max-memory-used-mb"),
        header("x-ff-function-error").is_some(),
        header("x-ff-log-result"),
    );
    let mut body = String::new();
    response
        .body_mut()
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|error| Error::new(Kind::Failed, format!("The function's answer was cut short: {error}")))?;
    Ok(Answer {
        status: response.status().as_u16(),
        request_id,
        duration_ms,
        memory_mb,
        function_error,
        body,
        log_result,
    })
}

/// How the runtime's loading of the code ended: ready, or failed with the runtime's error.
pub enum Readiness {
    Ready,
    Failed { error_type: String, message: String },
}

/// Waits for `/readyz`: ready, or the runtime's reason the code didn't load; at most the load's
/// limit, `max(10 s, the timeout)`, and a few seconds for the container to start.
pub fn wait_until_ready(container: &Container, timeout: u32) -> Result<Readiness, Error> {
    let agent = local_agent(Duration::from_secs(2));
    let deadline = Instant::now() + Duration::from_secs(u64::from(timeout).max(10) + 15);
    while Instant::now() < deadline {
        if let Ok(mut response) = agent.get(container.url("/readyz")).call() {
            let mut text = String::new();
            let _ = response.body_mut().as_reader().read_to_string(&mut text);
            let body: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            match body.get("status").and_then(serde_json::Value::as_str) {
                Some("ready") => return Ok(Readiness::Ready),
                Some("failed") => {
                    let error = &body["error"];
                    return Ok(Readiness::Failed {
                        error_type: error["errorType"].as_str().unwrap_or("Runtime.Unknown").to_owned(),
                        message: error["errorMessage"].as_str().unwrap_or("").to_owned(),
                    });
                }
                _ => {}
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(Error::new(
        Kind::DeployFailed,
        format!(
            "The function didn't load within {} s. Its log:\n{}",
            u64::from(timeout).max(10) + 15,
            container.logs().trim_end()
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(code: Code) -> LocalFunction {
        LocalFunction {
            name: "hello".into(),
            runtime: Runtime::Python,
            memory: 128,
            timeout: 5,
            code,
            handler: "function.handler".into(),
            environment: Default::default(),
            secrets: Default::default(),
            hosts: Vec::new(),
        }
    }

    #[test]
    fn the_container_gets_the_pods_hardening_variables_and_code_read_only() {
        let function = hello(Code::File { path: PathBuf::from("/home/me/hello.py"), extension: "py".into() });

        assert_eq!(
            run_args(&function, "ff-local-hello-1", PYTHON_IMAGE, None).join(" "),
            "run --detach --rm --name ff-local-hello-1 --read-only --tmpfs /tmp:rw,size=512m,mode=1777 --user 10001:10001 \
             --cap-drop ALL --security-opt no-new-privileges --memory 128m --memory-swap 128m --cpus 0.100 \
             --publish 127.0.0.1::8080 --env FUNCTION_NAME=hello --env FUNCTION_VERSION=$LATEST --env FUNCTION_MEMORY_LIMIT=128 \
             --env FUNCTION_TIMEOUT=5000 --env FF_MAX_QUEUE_WAIT_MS=5000 --env LAMBDA_TASK_ROOT=/var/task \
             --env FF_HANDLER=function.handler --env FF_EVENT_FORMAT=lambda --env PORT=8080 --env TZ=UTC \
             --volume /home/me/hello.py:/var/task/function.py:ro ff-runtime-python:3.13-v3"
        );
    }

    #[test]
    fn a_folder_is_the_task_root_and_a_port_can_be_chosen() {
        let args = run_args(&hello(Code::Folder(PathBuf::from("/home/me/app"))), "c", "img", Some(9000));

        assert!(args.windows(2).any(|pair| pair == ["--volume", "/home/me/app:/var/task:ro"]));
        assert!(args.windows(2).any(|pair| pair == ["--publish", "127.0.0.1:9000:8080"]));
    }

    #[test]
    fn a_templates_function_has_its_handler_its_secrets_by_name_alone_and_reaches_other_machines_by_their_names() {
        let mut function = hello(Code::Folder(PathBuf::from("/home/me/app")));
        function.handler = "src/app.handler".into();
        function.secrets = [("API_TOKEN".to_owned(), "s3cr3t".to_owned())].into();
        function.hosts = [("host.docker.internal", "host-gateway"), ("photos.host.docker.internal", "host-gateway")]
            .into_iter()
            .chain([("postgres", "172.17.0.5")])
            .map(|(name, address)| (name.to_owned(), address.to_owned()))
            .collect();

        let args = run_args(&function, "c", "img", None);

        assert!(args.windows(2).any(|pair| pair == ["--env", "FF_HANDLER=src/app.handler"]));
        assert!(args.windows(2).any(|pair| pair == ["--env", "API_TOKEN"]));
        assert!(!args.iter().any(|arg| arg.contains("s3cr3t")));
        assert!(args.windows(2).any(|pair| pair == ["--add-host", "host.docker.internal:host-gateway"]));
        assert!(args.windows(2).any(|pair| pair == ["--add-host", "photos.host.docker.internal:host-gateway"]));
        assert!(args.windows(2).any(|pair| pair == ["--add-host", "postgres:172.17.0.5"]));
        assert_eq!(args.last().map(String::as_str), Some("img"));
    }

    #[test]
    fn the_cpu_follows_the_memory_as_on_lambda() {
        assert_eq!([cpus(128), cpus(1024), cpus(1769), cpus(3008)], ["0.100", "0.579", "1.000", "1.701"]);
    }
}
