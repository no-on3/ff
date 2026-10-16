use crate::error::CliError;
use s3::creds::Credentials;
use s3::{Bucket, Region};
use std::path::Path;

pub struct MinioClient {
    bucket: Bucket,
}

impl MinioClient {
    pub fn new() -> Result<Self, CliError> {
        let endpoint = std::env::var("MINIO_ENDPOINT")
            .map_err(|_| CliError::EnvVar("MINIO_ENDPOINT".to_string()))?;
        let port = std::env::var("MINIO_PORT")
            .map_err(|_| CliError::EnvVar("MINIO_PORT".to_string()))?
            .parse::<u16>()
            .map_err(|_| CliError::EnvVar("Invalid MINIO_PORT".to_string()))?;
        let access_key = std::env::var("MINIO_ACCESS_KEY")
            .map_err(|_| CliError::EnvVar("MINIO_ACCESS_KEY".to_string()))?;
        let secret_key = std::env::var("MINIO_SECRET_KEY")
            .map_err(|_| CliError::EnvVar("MINIO_SECRET_KEY".to_string()))?;
        let bucket_name = std::env::var("MINIO_BUCKET_NAME")
            .map_err(|_| CliError::EnvVar("MINIO_BUCKET_NAME".to_string()))?;
        let use_ssl = std::env::var("MINIO_USE_SSL")
            .map(|v| v == "true")
            .unwrap_or(false);

        let credentials = Credentials::new(
            Some(&access_key),
            Some(&secret_key),
            None,
            None,
            None,
        )?;

        let region = Region::Custom {
            region: "us-east-1".to_string(),
            endpoint: format!("{}:{}", endpoint, port),
        };

        let bucket = Bucket::new(&bucket_name, region, credentials)?
            .with_path_style();

        Ok(Self { bucket })
    }

    pub async fn ensure_bucket_exists(&self) -> Result<(), CliError> {
        // The rust-s3 crate doesn't have a direct method to check if bucket exists
        // We'll try to list objects instead
        self.bucket
            .list("".to_string(), None)
            .await
            .map_err(CliError::S3)?;
        Ok(())
    }

    pub async fn upload_file(&self, path: &Path) -> Result<(), CliError> {
        let file_name = path
            .file_name()
            .ok_or_else(|| CliError::InvalidPath("Invalid file name".to_string()))?
            .to_string_lossy()
            .into_owned();

        let data = std::fs::read(path)?;
        self.bucket
            .put_object(&file_name, &data)
            .await
            .map_err(CliError::S3)?;

        Ok(())
    }
}
