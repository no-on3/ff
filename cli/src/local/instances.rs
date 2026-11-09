//! A template's functions running on this machine (ADR 0017): each started at its first call, in a container of its
//! own, and kept while calls come; stopped after a while without one, and started again at the next; started again at
//! once when its code changes, if it runs. Docker runs them, or the tests' stand-in.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::process::Child;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{Answer, Asks, Container, LocalFunction, Readiness, call, wait_until_ready};
use crate::cli::Runtime;
use crate::error::Error;

/// How a start ended: the function running, or its code failed to load, with the runtime's error.
pub enum Started<T> {
    Running(T),
    Failed { error_type: String, message: String },
}

/// What starts functions and calls them.
pub trait Runner: Send + Sync + 'static {
    type Running: Send + Sync + 'static;

    /// Starts the function, and waits for its code to load.
    fn start(&self, function: &LocalFunction) -> Result<Started<Self::Running>, Error>;

    /// Calls it with the event under the request's ID, with what the call asks, waited for up to its timeout.
    fn call(
        &self,
        running: &Self::Running,
        function: &LocalFunction,
        event: &Value,
        request_id: &str,
        asks: &Asks,
    ) -> Result<Answer, Error>;
}

/// What a call came to: the function's answer, its error among them, or its code's failure to load.
pub enum Called {
    Answered(Answer),
    NotLoaded { error_type: String, message: String },
}

/// One function: running or not, and its calls.
struct Slot<T> {
    running: Option<Arc<T>>,
    last_call: Instant,
    /// The calls under way, which keep it from being stopped as idle.
    calls: usize,
}

/// A function, and how it runs.
struct Entry<T> {
    function: LocalFunction,
    slot: Mutex<Slot<T>>,
}

/// The template's functions, by name.
pub struct Instances<R: Runner> {
    runner: R,
    functions: BTreeMap<String, Entry<R::Running>>,
    idle: Duration,
    /// Says what happens to them, a line each.
    say: Box<dyn Fn(&str) + Send + Sync>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<R: Runner> Instances<R> {
    pub fn new(
        runner: R,
        functions: Vec<LocalFunction>,
        idle: Duration,
        say: impl Fn(&str) + Send + Sync + 'static,
    ) -> Self {
        let functions = functions
            .into_iter()
            .map(|function| {
                let slot = Slot { running: None, last_call: Instant::now(), calls: 0 };
                (function.name.clone(), Entry { function, slot: Mutex::new(slot) })
            })
            .collect();
        Instances { runner, functions, idle, say: Box::new(say) }
    }

    pub fn function(&self, name: &str) -> Option<&LocalFunction> {
        self.functions.get(name).map(|entry| &entry.function)
    }

    /// The names of those running.
    #[cfg(test)]
    pub fn running(&self) -> Vec<String> {
        let running =
            |(name, entry): (&String, &Entry<R::Running>)| locked(&entry.slot).running.is_some().then(|| name.clone());
        self.functions.iter().filter_map(running).collect()
    }

    /// Starts it, saying how it went: what to keep, or its code's error.
    fn start(&self, function: &LocalFunction) -> Result<Started<Arc<R::Running>>, Error> {
        let began = Instant::now();
        let started = self.runner.start(function).inspect_err(|error| {
            (self.say)(&format!("{}: couldn't start: {}", function.name, error.message));
        })?;
        Ok(match started {
            Started::Running(running) => {
                (self.say)(&format!(
                    "{}: started ({}, {} MB) in {:.1} s",
                    function.name,
                    function.runtime.as_str(),
                    function.memory,
                    began.elapsed().as_secs_f64()
                ));
                Started::Running(Arc::new(running))
            }
            Started::Failed { error_type, message } => {
                (self.say)(&format!(
                    "{}: its code failed to load: {error_type}: {message}; its next call tries again",
                    function.name
                ));
                Started::Failed { error_type, message }
            }
        })
    }

    /// Calls the function named, started first if it doesn't run; one that ended its runtime, or didn't answer, is
    /// started again at the next call. None when the template has no function of that name.
    pub fn call(&self, name: &str, event: &Value, request_id: &str, asks: &Asks) -> Option<Result<Called, Error>> {
        let Entry { function, slot } = self.functions.get(name)?;
        let running = {
            let mut slot = locked(slot);
            let running = match &slot.running {
                Some(running) => Arc::clone(running),
                None => match self.start(function) {
                    Ok(Started::Running(running)) => {
                        slot.running = Some(Arc::clone(&running));
                        running
                    }
                    Ok(Started::Failed { error_type, message }) => {
                        return Some(Ok(Called::NotLoaded { error_type, message }));
                    }
                    Err(error) => return Some(Err(error)),
                },
            };
            slot.calls += 1;
            running
        };
        let answered = self.runner.call(&running, function, event, request_id, asks);
        let mut slot = locked(slot);
        slot.calls -= 1;
        slot.last_call = Instant::now();
        let ended = answered.as_ref().map_or(true, Answer::ended_the_runtime);
        if ended && slot.running.as_ref().is_some_and(|current| Arc::ptr_eq(current, &running)) {
            slot.running = None;
        }
        Some(answered.map(Called::Answered))
    }

    /// Stops each function that had no call for the idle time, at `now`; each one's next call starts it again.
    pub fn stop_idle(&self, now: Instant) {
        for (name, entry) in &self.functions {
            let stopped = {
                let mut slot = locked(&entry.slot);
                let idle = slot.calls == 0 && now.saturating_duration_since(slot.last_call) >= self.idle;
                if idle { slot.running.take() } else { None }
            };
            if let Some(stopped) = stopped {
                drop(stopped);
                (self.say)(&format!(
                    "{name}: no call for {}: stopped, until its next call",
                    humantime::format_duration(self.idle)
                ));
            }
        }
    }

    /// Starts the function named again, if it runs, as its code changed.
    pub fn restart(&self, name: &str) {
        let Some(Entry { function, slot }) = self.functions.get(name) else { return };
        let mut slot = locked(slot);
        let Some(old) = slot.running.take() else { return };
        drop(old);
        (self.say)(&format!("{name}: its code changed: starting it again"));
        if let Ok(Started::Running(running)) = self.start(function) {
            slot.running = Some(running);
        }
    }
}

/// Functions run in Docker, each one's log on stderr after its name and in its file, `<function>.log` in `logs`.
pub struct Docker {
    pub images: BTreeMap<Runtime, String>,
    pub logs: std::path::PathBuf,
    /// Whether the log is said on stderr too.
    pub echo: bool,
}

/// A function's container, and what follows its log.
pub struct DockerRunning {
    container: Option<Container>,
    follower: Child,
}

impl Drop for DockerRunning {
    fn drop(&mut self) {
        // The container first, which ends its log; what follows the log is given a moment to write its last lines.
        drop(self.container.take());
        let until = Instant::now() + Duration::from_secs(1);
        while Instant::now() < until && matches!(self.follower.try_wait(), Ok(None)) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.follower.kill();
        let _ = self.follower.wait();
    }
}

impl Runner for Docker {
    type Running = DockerRunning;

    fn start(&self, function: &LocalFunction) -> Result<Started<DockerRunning>, Error> {
        let image = self.images.get(&function.runtime).map_or("", String::as_str);
        let container = Container::start(function, image, None)?;
        let log = Log::open(&self.logs, &function.name, self.echo);
        let follower = container.follow_log(log)?;
        let readiness = wait_until_ready(&container, function.timeout);
        let running = DockerRunning { container: Some(container), follower };
        match readiness? {
            Readiness::Ready => Ok(Started::Running(running)),
            Readiness::Failed { error_type, message } => Ok(Started::Failed { error_type, message }),
        }
    }

    fn call(
        &self,
        running: &DockerRunning,
        function: &LocalFunction,
        event: &Value,
        request_id: &str,
        asks: &Asks,
    ) -> Result<Answer, Error> {
        let port = running.container.as_ref().map_or(0, |container| container.port);
        call(port, event, Some(request_id), asks, function.timeout)
    }
}

/// A function's log, line by line: in its file, and on stderr after its name.
struct Log {
    name: String,
    file: Option<File>,
    echo: bool,
}

impl Log {
    /// Its file, `<name>.log` in the folder, added to; without it, stderr alone.
    fn open(folder: &Path, name: &str, echo: bool) -> Log {
        let file = OpenOptions::new().create(true).append(true).open(folder.join(format!("{name}.log"))).ok();
        Log { name: name.to_owned(), file, echo }
    }
}

impl Write for Log {
    fn write(&mut self, line: &[u8]) -> io::Result<usize> {
        if let Some(file) = &mut self.file {
            file.write_all(line)?;
        }
        if self.echo {
            let text = String::from_utf8_lossy(line);
            eprintln!("{} | {}", self.name, text.trim_end_matches(['\r', '\n']));
        }
        Ok(line.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.as_mut().map_or(Ok(()), File::flush)
    }
}

/// A stand-in for Docker, for the tests of what runs functions and calls them.
#[cfg(test)]
pub mod stand {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::local::Code;

    /// Starts and calls nothing: counts its starts and its stops, keeps each call's event and asks, and answers as
    /// `script` says, the next call first, else with the event; a load fails when the function's handler is
    /// `broken.handler`, a call throws when its event says `throw`, and ends the runtime when it says `exit`.
    #[derive(Clone, Default)]
    pub struct Stand {
        pub starts: Arc<AtomicUsize>,
        pub stops: Arc<AtomicUsize>,
        pub script: Arc<Mutex<VecDeque<Result<Answer, Error>>>>,
        pub received: Arc<Mutex<Vec<(Value, Asks)>>>,
    }

    pub struct Running {
        stops: Arc<AtomicUsize>,
    }

    impl Drop for Running {
        fn drop(&mut self) {
            self.stops.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl Runner for Stand {
        type Running = Running;

        fn start(&self, function: &LocalFunction) -> Result<Started<Running>, Error> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            if function.handler == "broken.handler" {
                return Ok(Started::Failed { error_type: "Runtime.UserCodeSyntaxError".into(), message: "bad".into() });
            }
            Ok(Started::Running(Running { stops: Arc::clone(&self.stops) }))
        }

        fn call(
            &self,
            _: &Running,
            _: &LocalFunction,
            event: &Value,
            request_id: &str,
            asks: &Asks,
        ) -> Result<Answer, Error> {
            locked(&self.received).push((event.clone(), asks.clone()));
            if let Some(scripted) = locked(&self.script).pop_front() {
                return scripted;
            }
            let error = match (event["exit"].as_bool(), event["throw"].as_bool()) {
                (Some(true), _) => Some(("Runtime.ExitError", "exited")),
                (_, Some(true)) => Some(("Error", "thrown")),
                _ => None,
            };
            Ok(Answer {
                status: if error.is_some() { 500 } else { 200 },
                request_id: Some(request_id.to_owned()),
                duration_ms: None,
                memory_mb: None,
                function_error: error.is_some(),
                body: match error {
                    Some((error_type, message)) => {
                        serde_json::json!({ "errorType": error_type, "errorMessage": message }).to_string()
                    }
                    None => event.to_string(),
                },
                log_result: None,
            })
        }
    }

    pub fn function(name: &str, handler: &str) -> LocalFunction {
        LocalFunction {
            name: name.into(),
            runtime: Runtime::Nodejs,
            memory: 128,
            timeout: 3,
            code: Code::Folder("/app".into()),
            handler: handler.into(),
            environment: BTreeMap::new(),
            secrets: BTreeMap::new(),
            reaches_this_machine: true,
        }
    }

    /// `Orders`, and `Broken`, whose code doesn't load; what they say kept in `said`.
    pub fn instances(said: &Arc<Mutex<Vec<String>>>) -> (Instances<Stand>, Stand) {
        instances_of(vec![function("Orders", "app.handler"), function("Broken", "broken.handler")], said)
    }

    /// The functions on the stand-in, and the stand-in's counts, script and calls, shared with it.
    pub fn instances_of(functions: Vec<LocalFunction>, said: &Arc<Mutex<Vec<String>>>) -> (Instances<Stand>, Stand) {
        let stand = Stand::default();
        let said = Arc::clone(said);
        let instances = Instances::new(stand.clone(), functions, Duration::from_secs(600), move |line| {
            said.lock().unwrap().push(line.to_owned());
        });
        (instances, stand)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use serde_json::json;

    use super::stand::{Stand, instances};
    use super::*;

    fn answered(called: Option<Result<Called, Error>>) -> String {
        match called {
            Some(Ok(Called::Answered(answer))) => answer.body,
            Some(Ok(Called::NotLoaded { error_type, message })) => format!("not loaded: {error_type}: {message}"),
            Some(Err(error)) => format!("error: {}", error.message),
            None => "no such function".into(),
        }
    }

    #[test]
    fn a_function_starts_at_its_first_call_and_is_kept() {
        let said = Arc::default();
        let (instances, Stand { starts, .. }) = instances(&said);

        assert!(instances.running().is_empty());
        assert_eq!(answered(instances.call("Orders", &json!({ "n": 1 }), "r1", &Asks::default())), r#"{"n":1}"#);
        assert_eq!(answered(instances.call("Orders", &json!({ "n": 2 }), "r2", &Asks::default())), r#"{"n":2}"#);
        assert_eq!(answered(instances.call("Missing", &json!({}), "r3", &Asks::default())), "no such function");

        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(instances.running(), ["Orders"]);
        assert!(said.lock().unwrap()[0].starts_with("Orders: started (nodejs, 128 MB) in "), "{said:?}");
    }

    #[test]
    fn code_that_fails_to_load_answers_its_error_and_the_next_call_tries_again() {
        let said = Arc::default();
        let (instances, Stand { starts, .. }) = instances(&said);

        let first = answered(instances.call("Broken", &json!({}), "r1", &Asks::default()));
        let second = answered(instances.call("Broken", &json!({}), "r2", &Asks::default()));

        assert_eq!(first, "not loaded: Runtime.UserCodeSyntaxError: bad");
        assert_eq!(second, first);
        assert_eq!(starts.load(Ordering::SeqCst), 2);
        assert!(instances.running().is_empty());
        assert_eq!(
            said.lock().unwrap()[0],
            "Broken: its code failed to load: Runtime.UserCodeSyntaxError: bad; its next call tries again"
        );
    }

    #[test]
    fn a_call_that_ends_the_runtime_has_the_next_one_start_it_again() {
        let said = Arc::default();
        let (instances, Stand { starts, stops, .. }) = instances(&said);

        let exited = answered(instances.call("Orders", &json!({ "exit": true }), "r1", &Asks::default()));
        instances.call("Orders", &json!({}), "r2", &Asks::default());

        assert!(exited.contains("Runtime.ExitError"), "{exited}");
        assert_eq!((starts.load(Ordering::SeqCst), stops.load(Ordering::SeqCst)), (2, 1));
    }

    #[test]
    fn an_idle_function_is_stopped_until_its_next_call() {
        let said = Arc::default();
        let (instances, Stand { starts, stops, .. }) = instances(&said);
        instances.call("Orders", &json!({}), "r1", &Asks::default());

        instances.stop_idle(Instant::now() + Duration::from_secs(599));
        assert_eq!(instances.running(), ["Orders"]);
        instances.stop_idle(Instant::now() + Duration::from_secs(600));
        assert!(instances.running().is_empty());
        instances.call("Orders", &json!({}), "r2", &Asks::default());

        assert_eq!((starts.load(Ordering::SeqCst), stops.load(Ordering::SeqCst)), (2, 1));
        assert_eq!(said.lock().unwrap()[1], "Orders: no call for 10m: stopped, until its next call");
    }

    #[test]
    fn a_change_starts_a_running_function_again_and_leaves_a_stopped_one() {
        let said = Arc::default();
        let (instances, Stand { starts, stops, .. }) = instances(&said);

        instances.restart("Orders");
        assert_eq!(starts.load(Ordering::SeqCst), 0);
        instances.call("Orders", &json!({}), "r1", &Asks::default());
        instances.restart("Orders");

        assert_eq!((starts.load(Ordering::SeqCst), stops.load(Ordering::SeqCst)), (2, 1));
        assert_eq!(instances.running(), ["Orders"]);
        assert_eq!(said.lock().unwrap()[1], "Orders: its code changed: starting it again");
    }
}
