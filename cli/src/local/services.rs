//! The data services `ff local start --with` runs beside a template's functions: a PostgreSQL and a Valkey, each a
//! container of the image FF's servers of customers' databases and caches are built on, pinned by digest, its data in
//! a Docker volume of the project's, kept from a start to the next until `ff local reset --data`. The functions reach
//! each at its name, `postgres:5432` and `valkey:6379`, through `DATABASE_URL` and `REDIS_URL`, named as FF names a
//! database and a cache, without TLS; this machine reaches each at 127.0.0.1, on a port kept from a start to the next.
//! Each has a password, kept with its port in `.ff/local/services.json` and set at each start, so that the data
//! outlives the file.

use std::collections::BTreeMap;
use std::io::{self, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::key::random_text;
use super::{Container, docker, stderr_of};
use crate::config::write_whole;
use crate::error::{Error, Kind};
use crate::output::Output;
use crate::progress::Progress;

/// The user and the database a PostgreSQL here has, which its URL names.
const DATABASE: &str = "app";
/// How long a data service is given to answer once started: a PostgreSQL's first start makes its data first.
const READY_WITHIN: Duration = Duration::from_secs(60);
/// A password's characters: letters and digits, which a URL and SQL take as they are.
const PASSWORD: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/// The label of a project's volumes, naming its folder, by which `ff local reset --data` finds them.
const PROJECT_LABEL: &str = "ff.local.project";
/// Valkey's start: its password and its append-only file in a configuration only its user reads, then its image's
/// own entrypoint, which hands it the volume, as a command line would show the password.
const VALKEY_START: &str = "printf 'requirepass %s\\nappendonly yes\\n' \"$FF_VALKEY_PASSWORD\" >/tmp/valkey.conf \
     && chown valkey /tmp/valkey.conf && exec docker-entrypoint.sh valkey-server /tmp/valkey.conf";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Service {
    /// PostgreSQL 18, as FF's server of customers' databases, at DATABASE_URL
    Postgres,
    /// Valkey 9.1, as FF's server of customers' caches, at REDIS_URL
    Valkey,
}

impl Service {
    /// Its name, which the functions reach it by too.
    pub fn name(self) -> &'static str {
        match self {
            Service::Postgres => "postgres",
            Service::Valkey => "valkey",
        }
    }

    /// The image FF's server is built on, pinned by digest: the tag says which, the digest is what runs.
    pub fn image(self) -> &'static str {
        match self {
            Service::Postgres => {
                "postgres:18.6-bookworm@sha256:bbf83594798e144bff365a9c191c5d779f181fb3135902064ab8ff11918020fc"
            }
            Service::Valkey => {
                "valkey/valkey:9.1.2-alpine3.24@sha256:48332870af354a799964c0012ae1194a0bf2bf894eb508f945810596dc2d8d11"
            }
        }
    }

    /// The port it listens on in its container, where the functions reach it.
    pub fn port(self) -> u16 {
        match self {
            Service::Postgres => 5432,
            Service::Valkey => 6379,
        }
    }

    /// The variable a function finds it by, as FF's secrets name a database's and a cache's.
    pub fn variable(self) -> &'static str {
        match self {
            Service::Postgres => "DATABASE_URL",
            Service::Valkey => "REDIS_URL",
        }
    }

    /// Its URL at `host:port`, with its password, as FF's names a database or a cache, without TLS.
    pub fn url(self, host: &str, port: u16, password: &str) -> String {
        match self {
            Service::Postgres => format!("postgresql://{DATABASE}:{password}@{host}:{port}/{DATABASE}"),
            Service::Valkey => format!("redis://default:{password}@{host}:{port}"),
        }
    }

    /// Where its image keeps its data, which the volume holds.
    fn data(self) -> &'static str {
        match self {
            Service::Postgres => "/var/lib/postgresql",
            Service::Valkey => "/data",
        }
    }

    /// The variable its container takes its password from, by its name alone.
    fn password_variable(self) -> &'static str {
        match self {
            Service::Postgres => "POSTGRES_PASSWORD",
            Service::Valkey => "FF_VALKEY_PASSWORD",
        }
    }
}

/// What a project keeps of a service from a start to the next: its password, and its port on 127.0.0.1.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Access {
    pub password: String,
    pub port: u16,
}

/// Each service's access, as the file keeps them: none without the file.
pub fn read_kept(path: &Path) -> Result<BTreeMap<Service, Access>, Error> {
    let unreadable = |error: &dyn std::fmt::Display| {
        Error::new(
            Kind::Failed,
            format!("Couldn't read {}: {error}: remove it, and the services' passwords are made again", path.display()),
        )
    };
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| unreadable(&error)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(unreadable(&error)),
    }
}

/// Each service's access, written to the file, which its owner alone may read.
pub fn write_kept(path: &Path, kept: &BTreeMap<Service, Access>) -> Result<(), Error> {
    let text = serde_json::to_string_pretty(kept).expect("the services' access as JSON");
    write_whole(path, &format!("{text}\n"), true)
}

/// Each service asked for with its access: the kept password, else one made; the kept port while it is free on
/// 127.0.0.1, else one that is. Those kept and not asked for are kept as they are.
pub fn accesses(wanted: &[Service], kept: &BTreeMap<Service, Access>) -> Result<BTreeMap<Service, Access>, Error> {
    let mut all = kept.clone();
    for &service in wanted {
        let password = match kept.get(&service) {
            Some(access) => access.password.clone(),
            None => random_text(PASSWORD, 32, &format!("{}'s password", service.name()))?,
        };
        let port = match kept.get(&service).map(|access| access.port).filter(|port| is_free(*port)) {
            Some(port) => port,
            None => free_port()?,
        };
        all.insert(service, Access { password, port });
    }
    Ok(all)
}

fn is_free(port: u16) -> bool {
    port != 0 && TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn free_port() -> Result<u16, Error> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| Error::new(Kind::Failed, format!("No free port on 127.0.0.1 for a data service: {error}")))
}

/// The project's volume of a service: named for its folder, then a hash of its path, which tells two folders of one
/// name apart.
pub fn volume(project: &Path, service: Service) -> String {
    let path = project.display().to_string();
    let folder = project.file_name().map(|name| name.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let slug: String = folder.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).take(24).collect();
    let slug = match slug.trim_matches('-') {
        "" => "project",
        trimmed => trimmed,
    };
    format!("ff-local-{slug}-{}-{}", &crate::md5::hex(path.as_bytes())[..8], service.name())
}

/// The project's volumes, by their label, as Docker lists them.
pub fn volumes_of(project: &Path) -> Result<Vec<String>, Error> {
    let label = format!("label={PROJECT_LABEL}={}", project.display());
    let listed = docker(&strings(&["volume", "ls", "--quiet", "--filter", &label]))?;
    if !listed.status.success() {
        return Err(Error::new(Kind::Failed, format!("Docker couldn't list the volumes: {}", stderr_of(&listed))));
    }
    Ok(String::from_utf8_lossy(&listed.stdout).split_whitespace().map(str::to_owned).collect())
}

/// A data service running for the project, removed with ff's other containers, its data kept in its volume.
pub struct Running {
    pub service: Service,
    /// Held for its removal, when the service is dropped.
    _container: Container,
    /// Its address on Docker's network, where the functions reach it by its name.
    pub address: String,
    pub volume: String,
}

/// Starts the service for the project, its image pulled once, its volume made at its first start: answering, its
/// password the one given.
pub fn start(service: Service, project: &Path, access: &Access, out: &Output) -> Result<Running, Error> {
    let image = service.image();
    if !docker(&strings(&["image", "inspect", "--format", "{{.Id}}", image]))?.status.success() {
        let progress = Progress::start(out, &format!("pulling {image}, once"));
        let pulled = docker(&strings(&["pull", "--quiet", image]));
        progress.stop();
        let pulled = pulled?;
        if !pulled.status.success() {
            return Err(Error::new(
                Kind::Failed,
                format!("Couldn't pull {image}: {}: Docker pulls it once, online", stderr_of(&pulled)),
            ));
        }
    }
    let volume = volume(project, service);
    let label = format!("{PROJECT_LABEL}={}", project.display());
    let made = docker(&strings(&["volume", "create", "--label", &label, &volume]))?;
    if !made.status.success() {
        return Err(Error::new(
            Kind::Failed,
            format!("Docker couldn't make the volume {volume}: {}", stderr_of(&made)),
        ));
    }
    let filter = format!("volume={volume}");
    let using = docker(&strings(&["ps", "--all", "--filter", &filter, "--format", "{{.Names}}"]))?;
    let using: Vec<String> = String::from_utf8_lossy(&using.stdout).split_whitespace().map(str::to_owned).collect();
    if let Some(first) = using.first() {
        return Err(Error::new(
            Kind::Failed,
            format!(
                "The project's {} keeps its data in Docker's volume {volume}, which {} uses: another ff local start of this project runs it; stop it, or remove the container with docker rm --force {first}",
                service.name(),
                using.join(", ")
            ),
        ));
    }
    let name = format!("{volume}-{}", std::process::id());
    let started = Command::new("docker")
        .args(run_args(service, &name, &volume, access.port))
        .env(service.password_variable(), &access.password)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| Error::new(Kind::Failed, format!("Couldn't run docker ({error})")))?;
    if !started.status.success() {
        return Err(Error::new(
            Kind::Failed,
            format!("Docker couldn't start {}: {}", service.name(), stderr_of(&started)),
        ));
    }
    // Removed from here on, whatever happens next, stopped first, as its server ends.
    let container = Container::kept(name, access.port, true);
    answering(service, &container.name)?;
    if service == Service::Postgres {
        set_password(&container.name, &access.password)?;
    }
    let address = address_of(&container.name)?;
    Ok(Running { service, _container: container, address, volume })
}

/// `docker run`'s arguments for the service: its data in the volume, its port on 127.0.0.1 alone, its password by
/// its variable's name alone, so that no command line shows it.
fn run_args(service: Service, name: &str, volume: &str, port: u16) -> Vec<String> {
    let data = format!("{volume}:{}", service.data());
    let published = format!("127.0.0.1:{port}:{}", service.port());
    let mut args = strings(&["run", "--detach", "--name", name, "--volume", &data, "--publish", &published]);
    match service {
        Service::Postgres => {
            let user = format!("POSTGRES_USER={DATABASE}");
            let database = format!("POSTGRES_DB={DATABASE}");
            args.extend(strings(&["--env", &user, "--env", &database, "--env", service.password_variable()]));
            args.push(service.image().to_owned());
        }
        Service::Valkey => {
            args.extend(strings(&["--env", service.password_variable(), service.image(), "sh", "-c", VALKEY_START]));
        }
    }
    args
}

/// Waits for the service to answer: a PostgreSQL over TCP, as its first start serves its socket alone until its data
/// is made, then starts again; a Valkey refusing a client without its password, or answering one.
fn answering(service: Service, name: &str) -> Result<(), Error> {
    let check = match service {
        Service::Postgres => strings(&[
            "exec",
            name,
            "pg_isready",
            "--quiet",
            "--host",
            "127.0.0.1",
            "--username",
            DATABASE,
            "--dbname",
            DATABASE,
        ]),
        Service::Valkey => strings(&["exec", name, "valkey-cli", "ping"]),
    };
    let until = Instant::now() + READY_WITHIN;
    loop {
        let answered = docker(&check)?;
        let said =
            format!("{}{}", String::from_utf8_lossy(&answered.stdout), String::from_utf8_lossy(&answered.stderr));
        let ready = match service {
            Service::Postgres => answered.status.success(),
            Service::Valkey => said.contains("NOAUTH") || said.contains("PONG"),
        };
        if ready {
            return Ok(());
        }
        let ended = said.contains("is not running") || said.contains("No such container");
        if ended || Instant::now() >= until {
            let log = docker(&strings(&["logs", "--tail", "20", name]))?;
            let log = format!("{}{}", String::from_utf8_lossy(&log.stdout), String::from_utf8_lossy(&log.stderr));
            let why = if ended { "ended" } else { "didn't answer within 60 s" };
            return Err(Error::new(
                Kind::Failed,
                format!("{} {why}; its log ends:\n{}", service.name(), log.trim_end()),
            ));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Sets the PostgreSQL's password to the one kept, over its socket, where its image lets its own user in: its first
/// start took it from its variable, and a start after the file was removed makes another. The SQL goes on stdin.
fn set_password(name: &str, password: &str) -> Result<(), Error> {
    let failed = |why: String| Error::new(Kind::Failed, format!("Couldn't set postgres's password: {why}"));
    let psql = strings(&[
        "exec",
        "--interactive",
        name,
        "psql",
        "--quiet",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--username",
        DATABASE,
        "--dbname",
        DATABASE,
    ]);
    let mut child = Command::new("docker")
        .args(psql)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| failed(error.to_string()))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(format!("ALTER ROLE {DATABASE} PASSWORD '{password}';\n").as_bytes())
            .map_err(|error| failed(error.to_string()))?;
    }
    let output = child.wait_with_output().map_err(|error| failed(error.to_string()))?;
    match output.status.success() {
        true => Ok(()),
        false => Err(failed(stderr_of(&output))),
    }
}

/// The container's address on Docker's network.
fn address_of(name: &str) -> Result<String, Error> {
    let format = "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}";
    let inspected = docker(&strings(&["inspect", "--format", format, name]))?;
    let text = String::from_utf8_lossy(&inspected.stdout);
    text.split_whitespace().next().map(str::to_owned).ok_or_else(|| {
        Error::new(Kind::Failed, format!("Docker didn't say {name}'s address: {}", stderr_of(&inspected)))
    })
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_service_is_the_image_ffs_server_is_built_on_pinned_by_digest_at_the_variable_ff_names_it_by() {
        let urls = [Service::Postgres, Service::Valkey].map(|service| {
            let image = service.image();
            assert!(image.split_once("@sha256:").is_some_and(|(_, digest)| digest.len() == 64), "{image}");
            format!("{}={}", service.variable(), service.url(service.name(), service.port(), "pw"))
        });

        assert_eq!(
            urls,
            ["DATABASE_URL=postgresql://app:pw@postgres:5432/app", "REDIS_URL=redis://default:pw@valkey:6379"]
        );
        assert!(Service::Postgres.image().starts_with("postgres:18.6-bookworm@"), "FF's database server's");
        assert!(Service::Valkey.image().starts_with("valkey/valkey:9.1.2-alpine3.24@"), "FF's cache server's");
    }

    #[test]
    fn its_container_keeps_its_data_in_the_volume_answers_this_machine_alone_and_takes_its_password_by_name() {
        let postgres = run_args(Service::Postgres, "c", "v", 54321).join(" ");
        let valkey = run_args(Service::Valkey, "c", "v", 6400);

        assert_eq!(
            postgres,
            format!(
                "run --detach --name c --volume v:/var/lib/postgresql --publish 127.0.0.1:54321:5432 \
                 --env POSTGRES_USER=app --env POSTGRES_DB=app --env POSTGRES_PASSWORD {}",
                Service::Postgres.image()
            )
        );
        assert_eq!(
            valkey[..12].join(" "),
            format!(
                "run --detach --name c --volume v:/data --publish 127.0.0.1:6400:6379 --env FF_VALKEY_PASSWORD {} sh",
                Service::Valkey.image()
            )
        );
        assert!(valkey.last().is_some_and(|start| start.contains("\"$FF_VALKEY_PASSWORD\"")));
    }

    #[test]
    fn a_projects_volume_is_named_for_its_folder_and_its_path() {
        let one = volume(Path::new("/home/me/My Shop"), Service::Postgres);
        let other = volume(Path::new("/srv/My Shop"), Service::Postgres);

        assert!(one.starts_with("ff-local-my-shop-") && one.ends_with("-postgres"), "{one}");
        assert_ne!(one, other, "two folders of one name");
        assert_eq!(volume(Path::new("/home/me/My Shop"), Service::Valkey), one.replace("-postgres", "-valkey"));
        assert!(volume(Path::new("/"), Service::Valkey).starts_with("ff-local-project-"));
    }

    #[test]
    fn a_password_is_kept_from_a_start_to_the_next_and_a_port_while_it_is_free() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("services.json");
        assert_eq!(read_kept(&file).unwrap(), BTreeMap::new());

        let first = accesses(&[Service::Postgres], &BTreeMap::new()).unwrap();
        write_kept(&file, &first).unwrap();
        let held = TcpListener::bind(("127.0.0.1", first[&Service::Postgres].port)).unwrap();
        let second = accesses(&[Service::Postgres, Service::Valkey], &read_kept(&file).unwrap()).unwrap();
        drop(held);

        let postgres = &first[&Service::Postgres];
        assert!(postgres.password.len() == 32 && postgres.password.bytes().all(|byte| byte.is_ascii_alphanumeric()));
        assert_eq!(second[&Service::Postgres].password, postgres.password);
        assert_ne!(second[&Service::Postgres].port, postgres.port, "its port taken meanwhile");
        assert_ne!(second[&Service::Valkey].password, postgres.password);
        let third = accesses(&[], &second).unwrap();
        assert_eq!(third, second, "those not asked for kept as they are");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::write(&file, "not JSON").unwrap();
        assert!(read_kept(&file).unwrap_err().to_string().contains("remove it"));
    }
}
