//! `ff export <folder>`: what a move to AWS needs, written in a new folder from the account's own
//! resources: a SAM template and the same for Terraform, each function's code as Lambda runs it, the
//! values each takes, a page of `data/` for each kind of resource the account has, `MIGRATION.md`,
//! its runbook, and `cost-estimate.md`, its last months at AWS's prices.

pub(super) mod account;
#[cfg(test)]
pub(super) mod fixtures;
mod hcl;
mod kit;
pub(super) mod names;
mod roles;
pub(super) mod template;
mod terraform;
mod yaml;

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use super::Context;
use super::estimate::{self, AwsEstimate};
use super::init::new_folder;
use crate::api::{Call, Client};
use crate::cli::ExportArgs;
use crate::error::{Error, Kind};
use crate::progress::Progress;

/// How long a function's zip may take to come, 50 MB at most.
const CODE_TIMEOUT: Duration = Duration::from_secs(300);

/// The months `cost-estimate.md` prices at AWS's prices: the last three, this one so far last.
const ESTIMATE_MONTHS: u32 = 3;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FunctionView<'a> {
    name: &'a str,
    lambda_name: &'a str,
    logical_id: &'a str,
    code: &'a str,
}

/// What the export wrote, for a script.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Written<'a> {
    folder: String,
    account: &'a str,
    functions: Vec<FunctionView<'a>>,
    files: Vec<String>,
    /// The parameters `secrets.template.env` lists, which the export doesn't fill.
    to_fill: Vec<&'a str>,
    notes: &'a [String],
}

fn write(folder: &Path, relative: &str, bytes: &[u8], executable: bool) -> Result<(), Error> {
    let path = folder.join(relative);
    let failed =
        |error: std::io::Error| Error::new(Kind::Failed, format!("Couldn't write {}: {error}", path.display()));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(failed)?;
    }
    std::fs::write(&path, bytes).map_err(failed)?;
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).map_err(failed)?;
    }
    Ok(())
}

pub fn run(args: ExportArgs, context: &Context) -> Result<(), Error> {
    new_folder(&args.folder, "ff export writes a new folder")?;
    let settings = context.settings()?;
    let client = Client::new(&settings)?;
    let me = super::account::me(&client)?;
    let current = super::account::current(&me, &settings)?;
    let progress = Progress::start(context.out, &format!("reading account {}", current.id));
    let read = account::read(&client, current, &args.functions)?;
    let estimate = client.json::<AwsEstimate>(&estimate::call(Some(ESTIMATE_MONTHS), &[])?);
    progress.stop();
    let estimate = match estimate {
        Ok(estimate) => Ok(estimate),
        // A key that can't read the usage, or an FF without AWS's prices: the kit all the same, saying why.
        Err(error) if matches!(error.status, Some(403 | 404)) => {
            context.out.warn(&format!("cost-estimate.md has no estimate: {}", error.message));
            Err(error.message)
        }
        Err(error) => return Err(error),
    };
    let read_on = crate::table::today();
    let header = format!(
        "# ff export wrote this on {read_on} from FF's account {}: MIGRATION.md says how to deploy it.\n",
        read.id
    );
    let template = template::template(&read, args.with_values, &header);
    let terraform = terraform::terraform(&read, args.with_values, &header);
    let mut files = Vec::new();
    for (record, exported) in read.functions.iter().zip(&template.functions) {
        let progress = Progress::start(context.out, &format!("downloading {}'s code", record.function.name));
        let call = Call::get(format!("/functions/{}/code", record.function.id))
            .query("javascript", true)
            .accept("application/zip")
            .timeout(CODE_TIMEOUT);
        let zip = client.bytes(&call)?;
        progress.stop();
        write(&args.folder, &exported.code, &zip, false)?;
        files.push(exported.code.clone());
    }
    for file in kit::files(&read, &template, &terraform, &estimate, &read_on) {
        write(&args.folder, &file.path, file.text.as_bytes(), file.executable)?;
        files.push(file.path);
    }
    let written = Written {
        folder: args.folder.display().to_string(),
        account: &read.id,
        functions: template
            .functions
            .iter()
            .map(|function| FunctionView {
                name: &function.name,
                lambda_name: &function.lambda_name,
                logical_id: &function.logical_id,
                code: &function.code,
            })
            .collect(),
        files,
        to_fill: template.parameters.iter().map(|parameter| parameter.id.as_str()).collect(),
        notes: &template.notes,
    };
    context.out.result(&written, || {
        let mut text =
            format!("wrote {} for account {} ({}): {}", written.folder, read.name, read.id, written.files.join(", "));
        if !written.to_fill.is_empty() {
            text.push_str(&format!("\n{} value(s) to fill in secrets.template.env", written.to_fill.len()));
        }
        if !template.notes.is_empty() {
            text.push_str(&format!(
                "\nMIGRATION.md lists {} thing(s) the template changes or leaves to you",
                template.notes.len()
            ));
        }
        text.push_str(&format!(
            "\nnext: {}/MIGRATION.md, then sam validate --lint --region <your region> there",
            written.folder
        ));
        text
    })
}
