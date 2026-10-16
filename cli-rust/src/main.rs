use clap::{Parser, Subcommand};
use colored::*;
use std::path::PathBuf;

mod commands;
mod error;
mod minio;
mod package;

use commands::{deploy, pack, upload};
use error::CliError;

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Package a lambda function into a zip file
    Pack {
        /// Path to the lambda function directory
        #[arg(value_name = "DIRECTORY")]
        path: PathBuf,
        
        /// Output path for the zip file
        #[arg(short, long, value_name = "FILE")]
        output: Option<PathBuf>,
    },
    
    /// Upload a packaged lambda to MinIO
    Upload {
        /// Path to the zip file
        #[arg(value_name = "FILE")]
        path: PathBuf,
    },
    
    /// Package and upload a lambda function
    Deploy {
        /// Path to the lambda function directory
        #[arg(value_name = "DIRECTORY")]
        path: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<(), CliError> {
    dotenv::dotenv().ok();
    env_logger::init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Pack { path, output } => {
            pack::execute(path, output).await?;
        }
        Commands::Upload { path } => {
            upload::execute(path).await?;
        }
        Commands::Deploy { path } => {
            deploy::execute(path).await?;
        }
    }

    Ok(())
}
