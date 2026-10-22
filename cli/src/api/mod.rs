//! FF's API, as ff calls it.

mod client;
mod error;
pub mod events;
pub mod types;

pub use client::{Call, Client};
