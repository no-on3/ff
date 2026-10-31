//! What a package leaves out of its folder: version control, Python's caches, ff's own `.ff`
//! folder, `.env` files, which usually hold secrets, and what `.ffignore` names, in the part of
//! `.gitignore`'s syntax ff reads: a name matches at any depth, a path with a slash from the
//! folder's root, a trailing slash folders only; `*` and `?` within a name, `**` across folders;
//! `#` comments. `!` isn't read: a pattern starting with it is refused, rather than taken another
//! way.

use std::path::Path;

use crate::error::Error;

/// Left out of every package, at any depth: version control, editors' and Python's own files,
/// and ff's: `.ff/` holds the zips `ff package` writes.
const ALWAYS: &[&str] = &[".git/", ".hg/", ".svn/", "__pycache__/", ".DS_Store", ".ff/", ".ffignore"];

struct Pattern {
    glob: String,
    /// From the root, rather than any folder's name.
    anchored: bool,
    /// Folders only.
    folders: bool,
}

pub struct Ignore {
    patterns: Vec<Pattern>,
}

/// Whether `text` matches `glob`: `*` and `?` within a part of the path, `**` across them.
fn glob_matches(glob: &[u8], text: &[u8]) -> bool {
    match glob.first() {
        None => text.is_empty(),
        Some(b'*') if glob.get(1) == Some(&b'*') => {
            let rest = glob[2..].strip_prefix(b"/").unwrap_or(&glob[2..]);
            (0..=text.len())
                .any(|at| (at == 0 || text[at - 1] == b'/' || rest.is_empty()) && glob_matches(rest, &text[at..]))
        }
        Some(b'*') => (0..=text.len())
            .take_while(|at| *at == 0 || text[at - 1] != b'/')
            .any(|at| glob_matches(&glob[1..], &text[at..])),
        Some(b'?') => text.first().is_some_and(|c| *c != b'/') && glob_matches(&glob[1..], &text[1..]),
        Some(c) => text.first() == Some(c) && glob_matches(&glob[1..], &text[1..]),
    }
}

impl Pattern {
    fn parse(line: &str) -> Option<Pattern> {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let folders = line.ends_with('/');
        let line = line.trim_end_matches('/');
        let anchored = line.contains('/');
        Some(Pattern { glob: line.trim_start_matches('/').to_owned(), anchored, folders })
    }

    fn matches(&self, path: &str, is_folder: bool) -> bool {
        if self.folders && !is_folder {
            return false;
        }
        let target = if self.anchored { path } else { path.rsplit('/').next().unwrap_or(path) };
        glob_matches(self.glob.as_bytes(), target.as_bytes())
    }
}

impl Ignore {
    /// ff's own rules, which the build's copy of the folder follows: what `.ffignore` names may
    /// be what the build makes the package from.
    pub fn always() -> Ignore {
        Ignore { patterns: ALWAYS.iter().filter_map(|line| Pattern::parse(line)).collect() }
    }

    /// The package's rules: ff's own, and the folder's `.ffignore` if it has one.
    pub fn of(root: &Path) -> Result<Ignore, Error> {
        let mut patterns = Ignore::always().patterns;
        let file = root.join(".ffignore");
        if file.is_file() {
            let text = std::fs::read_to_string(&file)
                .map_err(|error| Error::usage(format!("Couldn't read {}: {error}", file.display())))?;
            for (number, line) in text.lines().enumerate() {
                if line.starts_with('!') {
                    return Err(Error::usage(format!(
                        "{}, line {}: ff doesn't read negated patterns (!): name what to leave out",
                        file.display(),
                        number + 1
                    )));
                }
                patterns.extend(Pattern::parse(line));
            }
        }
        Ok(Ignore { patterns })
    }

    /// Whether the path, '/'-separated from the root, is left out.
    pub fn excludes(&self, path: &str, is_folder: bool) -> bool {
        self.patterns.iter().any(|pattern| pattern.matches(path, is_folder))
    }
}

/// A `.env` file, which usually holds secrets: left out, and named in a warning.
pub fn is_env_file(name: &str) -> bool {
    name == ".env" || name.starts_with(".env.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ignore(lines: &str) -> Ignore {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join(".ffignore"), lines).unwrap();
        Ignore::of(dir.path()).unwrap()
    }

    #[test]
    fn leaves_out_version_control_python_caches_and_ffs_own_files_at_any_depth() {
        let rules = Ignore::of(tempfile::TempDir::new().unwrap().path()).unwrap();

        assert!(rules.excludes(".git", true));
        assert!(rules.excludes("lib/__pycache__", true));
        assert!(rules.excludes("src/.DS_Store", false));
        assert!(rules.excludes(".ff", true));
        assert!(rules.excludes(".ffignore", false));
        assert!(!rules.excludes("src/app.js", false));
        // A file called like a folder ff leaves out is a file.
        assert!(!rules.excludes(".git", false));
    }

    #[test]
    fn the_builds_copy_follows_ffs_rules_alone() {
        let rules = ignore("docs/\n");

        assert!(rules.excludes("docs", true));
        assert!(!Ignore::always().excludes("docs", true));
        assert!(Ignore::always().excludes(".git", true));
    }

    #[test]
    fn reads_names_paths_folders_and_wildcards_as_gitignore_does() {
        let rules = ignore("# tests stay home\n*.test.js\n/docs\nfixtures/\nsrc/**/*.map\nlog?.txt\n");

        assert!(rules.excludes("app.test.js", false));
        assert!(rules.excludes("src/deep/app.test.js", false));
        assert!(rules.excludes("docs", true));
        assert!(!rules.excludes("src/docs", true), "/docs is the root's only");
        assert!(rules.excludes("src/fixtures", true));
        assert!(!rules.excludes("fixtures", false), "fixtures/ names folders only");
        assert!(rules.excludes("src/a/b/app.js.map", false));
        assert!(rules.excludes("src/app.js.map", false));
        assert!(rules.excludes("log1.txt", false));
        assert!(!rules.excludes("log12.txt", false));
        assert!(!rules.excludes("app.js", false));
    }

    #[test]
    fn refuses_a_negated_pattern_rather_than_take_it_another_way() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join(".ffignore"), "*.log\n!keep.log\n").unwrap();

        let error = Ignore::of(dir.path()).map(|_| ()).unwrap_err();
        assert!(
            error.message.ends_with(".ffignore, line 2: ff doesn't read negated patterns (!): name what to leave out"),
            "{}",
            error.message
        );
    }

    #[test]
    fn knows_env_files() {
        assert!(is_env_file(".env"));
        assert!(is_env_file(".env.production"));
        assert!(!is_env_file(".envrc") && !is_env_file("env.js"));
    }
}
