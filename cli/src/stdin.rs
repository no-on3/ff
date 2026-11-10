//! Stdin, which a command reads a value, an event or an answer from, unless `ff mcp` holds it: there it is the
//! protocol's, and a command reading it would take the agent's messages as its input.

use std::cell::Cell;

thread_local! {
    // Per thread, as `ff mcp` runs each command on its own thread, and the tests run sessions side by side.
    static HELD: Cell<bool> = const { Cell::new(false) };
}

/// Stdin held for `ff mcp`'s protocol until the guard is dropped.
pub fn hold() -> Held {
    HELD.with(|held| held.set(true));
    Held
}

pub struct Held;

impl Drop for Held {
    fn drop(&mut self) {
        HELD.with(|held| held.set(false));
    }
}

/// Whether `ff mcp` holds stdin: a command then refuses what it would read from it, saying how to give it instead.
pub fn held() -> bool {
    HELD.with(Cell::get)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdin_is_held_while_the_guard_lives() {
        assert!(!held());
        let guard = hold();
        assert!(held());
        drop(guard);
        assert!(!held());
    }
}
