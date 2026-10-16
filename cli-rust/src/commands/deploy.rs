use crate::error::CliError;
use colored::*;
use indicatif::ProgressBar;
use std::path::PathBuf;

pub async fn execute(path: PathBuf) -> Result<(), CliError> {
    let spinner = ProgressBar::new_spinner();
    spinner.set_message("Deploying lambda function...");
    spinner.enable_steady_tick(100);

    // First pack the function
    let output_path = {
        let parent = path.parent().unwrap_or(std::path::Path::new(""));
        let file_name = format!(
            "{}.zip",
            path.file_name()
                .ok_or_else(|| CliError::InvalidPath("Invalid path".to_string()))?
                .to_string_lossy()
        );
        parent.join(file_name)
    };

    super::pack::execute(path, Some(output_path.clone())).await?;

    // Then upload it
    super::upload::execute(output_path).await?;

    spinner.finish_with_message("✨ Lambda function deployed successfully".green().to_string());

    Ok(())
}
