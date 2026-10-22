//! What a long call is doing, on stderr: a spinner in a terminal, one line in a log, nothing with
//! `--quiet` or for scripts reading JSON.

use std::io::{self, IsTerminal, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::cli::Format;
use crate::output::Output;

pub struct Progress {
    running: Arc<AtomicBool>,
    spinner: Option<JoinHandle<()>>,
}

impl Progress {
    pub fn start(out: &Output, text: &str) -> Progress {
        let running = Arc::new(AtomicBool::new(true));
        if out.quiet || out.format == Format::Json {
            return Progress { running, spinner: None };
        }
        if !io::stderr().is_terminal() {
            let _ = writeln!(io::stderr().lock(), "{text}…");
            return Progress { running, spinner: None };
        }
        let text = text.to_owned();
        let shown = Arc::clone(&running);
        let spinner = thread::spawn(move || {
            const FRAMES: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
            let mut frame = 0;
            while shown.load(Ordering::Relaxed) {
                let _ = write!(io::stderr().lock(), "\r{text} {}", FRAMES[frame % FRAMES.len()]);
                frame += 1;
                thread::sleep(Duration::from_millis(100));
            }
            // The line is cleared, for the result that follows.
            let _ = write!(io::stderr().lock(), "\r\x1b[2K");
        });
        Progress { running, spinner: Some(spinner) }
    }

    /// Ends the spinner, its line cleared: dropping it does.
    pub fn stop(self) {}
}

impl Drop for Progress {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(spinner) = self.spinner.take() {
            let _ = spinner.join();
        }
    }
}
