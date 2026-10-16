use thiserror::Error;

#[derive(Error, Debug)]
pub enum CliError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Zip error: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("S3 error: {0}")]
    S3(#[from] s3::error::S3Error),

    #[error("Missing environment variable: {0}")]
    EnvVar(String),

    #[error("Package error: {0}")]
    Package(String),

    #[error("Invalid path: {0}")]
    InvalidPath(String),
}
