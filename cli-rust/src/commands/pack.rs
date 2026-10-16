use crate::error::CliError;
use crate::package::Packager;
use colored::*;
use indicatif::ProgressBar;
use std::path::PathBuf;

pub async fn execute(path: PathBuf, output: Option<PathBuf>) -> Result<(), CliError> {
    let spinner = ProgressBar::new_spinner();
    spinner.set_message("Packaging lambda function...");
    spinner.enable_steady_tick(100);

    let packager = Packager::new();

    // Install dependencies
    spinner.set_message("Installing dependencies...");
    packager.install_dependencies(&path).await?;

    // Compile TypeScript if needed
    spinner.set_message("Compiling TypeScript...");
    packager.compile_typescript(&path).await?;

    // Create zip file
    spinner.set_message("Creating zip file...");
    let output_path = packager.pack_function(&path, output).await?;

    spinner.finish_with_message(
        format!(
            "✨ Lambda function packaged successfully to {}",
            output_path.display()
        )
        .green()
        .to_string(),
    );

    Ok(())
}
