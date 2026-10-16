use crate::error::CliError;
use crate::minio::MinioClient;
use colored::*;
use indicatif::ProgressBar;
use std::path::PathBuf;

pub async fn execute(path: PathBuf) -> Result<(), CliError> {
    let spinner = ProgressBar::new_spinner();
    spinner.set_message("Uploading lambda function...");
    spinner.enable_steady_tick(100);

    let minio_client = MinioClient::new()?;

    // Ensure bucket exists
    spinner.set_message("Checking MinIO bucket...");
    minio_client.ensure_bucket_exists().await?;

    // Upload file
    spinner.set_message("Uploading to MinIO...");
    minio_client.upload_file(&path).await?;

    spinner.finish_with_message(
        format!(
            "✨ Lambda function uploaded successfully as {}",
            path.file_name().unwrap().to_string_lossy()
        )
        .green()
        .to_string(),
    );

    Ok(())
}
