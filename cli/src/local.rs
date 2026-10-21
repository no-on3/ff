//! A function run on this machine as production runs it (ADR 0002): in its runtime image, on
//! Docker, with the pod's hardening (a read-only root, uid 10001, no capability, no new
//! privileges), its memory and CPU, and the variables the backend gives a function's pod.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::cli::Runtime;
use crate::error::{Error, Kind};

/// The runtime images this CLI speaks the protocol of, unless the environment names others.
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
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Code {
    /// One file, mounted as /var/task/function.<extension>, as the backend's ConfigMap holds it.
    File { path: PathBuf, extension: String },
    /// A folder, mounted as /var/task.
    Folder(PathBuf),
}

impl Code {
    /// The file or folder, by its absolute path, which Docker's mounts need.
    pub fn of(path: &Path) -> Result<Code, Error> {
        let absolute = std::fs::canonicalize(path)
            .map_err(|error| Error::new(Kind::Usage, format!("Couldn't open {}: {error}", path.display())))?;
        if absolute.is_dir() {
            return Ok(Code::Folder(absolute));
        }
        let extension = absolute.extension().and_then(|extension| extension.to_str()).unwrap_or("").to_owned();
        Ok(Code::File { path: absolute, extension })
    }
}

/// The image: `FF_RUNTIME_IMAGE_NODEJS` or `FF_RUNTIME_IMAGE_PYTHON`, else the protocol's own.
pub fn image(runtime: Runtime, env: &dyn Fn(&str) -> Option<String>) -> String {
    let (variable, default) = match runtime {
        Runtime::Nodejs => ("FF_RUNTIME_IMAGE_NODEJS", NODEJS_IMAGE),
        Runtime::Python => ("FF_RUNTIME_IMAGE_PYTHON", PYTHON_IMAGE),
    };
    env(variable).filter(|image| !image.is_empty()).unwrap_or_else(|| default.to_owned())
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
        ("FF_HANDLER", "function.handler".to_owned()),
        ("FF_EVENT_FORMAT", "lambda".to_owned()),
        ("PORT", RUNTIME_PORT.to_string()),
        ("TZ", "UTC".to_owned()),
    ];
    for (name, value) in variables {
        args.push("--env".to_owned());
        args.push(format!("{name}={value}"));
    }
    let mount = match &function.code {
        Code::File { path, extension } => format!("{}:/var/task/function.{extension}:ro", path.display()),
        Code::Folder(path) => format!("{}:/var/task:ro", path.display()),
    };
    args.push("--volume".to_owned());
    args.push(mount);
    args.push(image.to_owned());
    args
}

/// A Docker command's output, or why Docker couldn't be run at all.
pub fn docker(args: &[String]) -> Result<Output, Error> {
    Command::new("docker").args(args).stdin(Stdio::null()).output().map_err(|error| {
        Error::new(Kind::Failed, format!("Couldn't run docker ({error}): ff local runs a function in Docker, in the runtime image production uses; install it, or start it"))
    })
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_owned()
}

/// Docker answers, and has the image.
pub fn check_docker(image: &str) -> Result<(), Error> {
    let version = docker(&["version".into(), "--format".into(), "{{.Server.Version}}".into()])?;
    if !version.status.success() {
        return Err(Error::new(
            Kind::Failed,
            format!("Docker doesn't answer: {}. ff local runs a function in Docker: start it", stderr_of(&version)),
        ));
    }
    let inspected = docker(&["image".into(), "inspect".into(), "--format".into(), "{{.Id}}".into(), image.into()])?;
    if !inspected.status.success() {
        return Err(Error::new(
            Kind::Failed,
            format!(
                "The runtime image {image} isn't on this machine: build it from FF's repository (docker build -t {image} runtimes/<runtime>), or name another with FF_RUNTIME_IMAGE_NODEJS or FF_RUNTIME_IMAGE_PYTHON"
            ),
        ));
    }
    Ok(())
}

/// The containers running now, which Ctrl-C removes before ff exits.
static RUNNING: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Set by Ctrl-C: from then on, only the handler removes containers, and it ends ff.
static INTERRUPTED: AtomicBool = AtomicBool::new(false);

/// On Ctrl-C, the containers are removed, and ff exits as a shell expects of an interrupt. Until
/// it is done, a thread that would remove one too waits: two removals at once may leave the
/// container in place a moment longer than ff runs, and ff would exit with another code.
pub fn remove_on_interrupt() {
    let _ = ctrlc::set_handler(|| {
        INTERRUPTED.store(true, Ordering::SeqCst);
        let names = RUNNING.lock().map(|names| names.clone()).unwrap_or_default();
        for name in names {
            let _ = docker(&["rm".into(), "--force".into(), name]);
        }
        std::process::exit(130);
    });
}

/// A container ff started, removed when dropped: after the command, an error, or Ctrl-C.
pub struct Container {
    pub name: String,
    pub port: u16,
}

impl Container {
    pub fn start(function: &LocalFunction, image: &str, port: Option<u16>) -> Result<Container, Error> {
        let name = format!("ff-local-{}-{}", function.name.to_ascii_lowercase(), std::process::id());
        let started = docker(&run_args(function, &name, image, port))?;
        if !started.status.success() {
            return Err(Error::new(
                Kind::Failed,
                format!("Docker couldn't start the function: {}", stderr_of(&started)),
            ));
        }
        if let Ok(mut running) = RUNNING.lock() {
            running.push(name.clone());
        }
        // Removed from here on, whatever happens next.
        let mut container = Container { name, port: 0 };
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
        let _ = docker(&["rm".into(), "--force".into(), self.name.clone()]);
        if let Ok(mut running) = RUNNING.lock() {
            running.retain(|name| *name != self.name);
        }
    }
}

/// An agent for the runtime on this machine: never through a proxy.
fn local_agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(timeout)).proxy(None).build().into()
}

/// What the runtime answered a call: its status, its headers' measures, its body.
pub struct Answer {
    pub status: u16,
    pub request_id: Option<String>,
    pub duration_ms: Option<String>,
    pub memory_mb: Option<String>,
    pub function_error: bool,
    pub body: String,
}

/// `POST /invoke` with the event, as the backend calls a pod: waited for up to the timeout and
/// 10 s more.
pub fn invoke(container: &Container, event: &serde_json::Value, timeout: u32) -> Result<Answer, Error> {
    let agent = local_agent(Duration::from_secs(u64::from(timeout) + 10));
    let mut response = agent
        .post(container.url("/invoke"))
        .header("content-type", "application/json")
        .send(event.to_string())
        .map_err(|error| Error::new(Kind::Failed, format!("The function's container didn't answer: {error}")))?;
    let header = |name: &str| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_owned);
    let (request_id, duration_ms, memory_mb, function_error) = (
        header("x-ff-request-id"),
        header("x-ff-duration-ms"),
        header("x-ff-max-memory-used-mb"),
        header("x-ff-function-error").is_some(),
    );
    let mut body = String::new();
    response
        .body_mut()
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|error| Error::new(Kind::Failed, format!("The function's answer was cut short: {error}")))?;
    Ok(Answer { status: response.status().as_u16(), request_id, duration_ms, memory_mb, function_error, body })
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
        LocalFunction { name: "hello".into(), runtime: Runtime::Python, memory: 128, timeout: 5, code }
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
    fn the_cpu_follows_the_memory_as_on_lambda() {
        assert_eq!([cpus(128), cpus(1024), cpus(1769), cpus(3008)], ["0.100", "0.579", "1.000", "1.701"]);
    }

    #[test]
    fn the_image_is_the_protocols_unless_the_environment_names_another() {
        let none = |_: &str| None;
        let named =
            |name: &str| (name == "FF_RUNTIME_IMAGE_NODEJS").then(|| "registry.ff.example/nodejs:24".to_owned());

        assert_eq!(image(Runtime::Nodejs, &none), NODEJS_IMAGE);
        assert_eq!(image(Runtime::Python, &none), PYTHON_IMAGE);
        assert_eq!(image(Runtime::Nodejs, &named), "registry.ff.example/nodejs:24");
    }
}
