use crate::error::CliError;
use std::fs::File;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::ZipWriter;

pub struct Packager;

impl Packager {
    pub fn new() -> Self {
        Self
    }

    pub async fn pack_function(
        &self,
        source_path: &Path,
        output_path: Option<PathBuf>,
    ) -> Result<PathBuf, CliError> {
        // Validate source directory
        if !source_path.is_dir() {
            return Err(CliError::InvalidPath(
                "Source path must be a directory".to_string(),
            ));
        }

        // Check for package.json
        let package_json_path = source_path.join("package.json");
        if !package_json_path.exists() {
            return Err(CliError::Package(
                "package.json not found in source directory".to_string(),
            ));
        }

        // Determine output path
        let output_path = match output_path {
            Some(path) => path,
            None => {
                let parent = source_path.parent().unwrap_or(Path::new(""));
                let file_name = format!(
                    "{}.zip",
                    source_path
                        .file_name()
                        .ok_or_else(|| CliError::InvalidPath("Invalid source path".to_string()))?
                        .to_string_lossy()
                );
                parent.join(file_name)
            }
        };

        // Create zip file
        let file = File::create(&output_path)?;
        let mut zip = ZipWriter::new(file);

        // Add files to zip
        for entry in WalkDir::new(source_path) {
            let entry = entry?;
            let path = entry.path();
            if path.is_file() {
                let relative_path = path.strip_prefix(source_path).unwrap();
                let file_name = relative_path.to_string_lossy();

                // Skip .git directory and other unnecessary files
                if file_name.starts_with(".git/")
                    || file_name.starts_with("node_modules/")
                    || file_name.ends_with(".log")
                {
                    continue;
                }

                zip.start_file(file_name.to_string(), FileOptions::default())?;
                let mut file = File::open(path)?;
                std::io::copy(&mut file, &mut zip)?;
            }
        }

        zip.finish()?;
        Ok(output_path)
    }

    pub async fn install_dependencies(&self, path: &Path) -> Result<(), CliError> {
        use std::process::Command;

        let output = Command::new("npm")
            .arg("install")
            .arg("--production")
            .current_dir(path)
            .output()?;

        if !output.status.success() {
            return Err(CliError::Package(
                String::from_utf8_lossy(&output.stderr).to_string(),
            ));
        }

        Ok(())
    }

    pub async fn compile_typescript(&self, path: &Path) -> Result<(), CliError> {
        let tsconfig_path = path.join("tsconfig.json");
        if !tsconfig_path.exists() {
            return Ok(());
        }

        let output = std::process::Command::new("npm")
            .arg("run")
            .arg("build")
            .current_dir(path)
            .output()?;

        if !output.status.success() {
            return Err(CliError::Package(
                String::from_utf8_lossy(&output.stderr).to_string(),
            ));
        }

        Ok(())
    }
}
