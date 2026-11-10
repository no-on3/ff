//! The template's buckets on this machine, as `ff local start` keeps them (ADR 0017): each object a file under
//! `.ff/local/buckets/<bucket>/`, named at random with its key's extension, and beside it `<file>.object.json`, its key
//! and what a read answers of it, so that a developer can look at both. A write goes to a file of its own, which then
//! takes the object's place, so that a read under way goes on reading what it began with. Which file each key names
//! is kept in memory, read back from the folders at the start. A multipart upload's parts are files under
//! `<bucket>/.uploads/<upload>/` until it ends; its uploads end with ff local start, their parts removed at the next.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::sigv4::hex;

/// The folder of a bucket's multipart uploads' parts.
const UPLOADS: &str = ".uploads";
/// What an object's file's name is followed by in the name of the file beside it.
const DESCRIBED: &str = ".object.json";
/// What a file being written is followed by, until it is kept.
const WRITING: &str = ".part";
/// The longest extension of a key an object's file takes.
const MAX_EXTENSION: usize = 10;

/// An object as kept: its key, its file, and what a read answers of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Object {
    pub key: String,
    /// Its file's name, in its bucket's folder.
    pub file: String,
    pub size: u64,
    /// Its ETag, in quotes, as S3 gives it.
    pub etag: String,
    /// When it was written, in milliseconds since 1970.
    pub modified: i64,
    /// The headers it was written with that a read answers: its type and its metadata among them.
    pub headers: Vec<(String, String)>,
    /// Each part's size, in order, when a multipart upload made it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<u64>,
}

/// A multipart upload's part, as uploaded.
#[derive(Clone, Debug)]
pub struct Part {
    pub file: PathBuf,
    pub size: u64,
    pub md5: [u8; 16],
    pub modified: i64,
}

impl Part {
    /// Its ETag, in quotes, as S3 gives it: its MD5.
    pub fn etag(&self) -> String {
        format!("\"{}\"", hex(&self.md5))
    }
}

/// A multipart upload under way: the object it makes, the headers that object takes, and the parts so far.
#[derive(Clone, Debug)]
pub struct Upload {
    pub bucket: String,
    pub key: String,
    pub initiated: i64,
    pub headers: Vec<(String, String)>,
    pub parts: BTreeMap<u32, Part>,
}

/// A file being written: an object's, which takes its place once kept, or a part's.
pub struct Writing {
    file: File,
    /// Where it is written.
    path: PathBuf,
    /// An object's file's name once kept.
    name: String,
}

impl Write for Writing {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.file.write(data)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl Writing {
    /// What was written, gone: the write failed its checks, or its upload ended.
    pub fn discard(self) {
        drop(self.file);
        let _ = fs::remove_file(&self.path);
    }
}

#[derive(Default)]
struct State {
    /// Each bucket's objects, by their keys.
    objects: HashMap<String, BTreeMap<String, Object>>,
    /// The uploads under way, by their IDs.
    uploads: BTreeMap<String, Upload>,
}

/// The buckets' objects, and their uploads.
pub struct Store {
    root: PathBuf,
    state: Mutex<State>,
}

/// 16 random bytes, in hexadecimal: a file's name, an upload's ID.
fn random_name() -> String {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).expect("the system's random numbers");
    hex(&random)
}

/// A name `random_name` makes, with an extension or none.
fn is_random_name(name: &str) -> bool {
    let (stem, extension) = name.split_once('.').unwrap_or((name, "x"));
    stem.len() == 32
        && stem.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && (1..=MAX_EXTENSION).contains(&extension.len())
        && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// An object's file's name: random, with its key's extension when that is a short one of letters and digits, so that
/// a developer's tools open it.
fn file_name(key: &str) -> String {
    let last = key.rsplit('/').next().unwrap_or_default();
    let extension = last.rsplit_once('.').map(|(_, extension)| extension).filter(|extension| {
        (1..=MAX_EXTENSION).contains(&extension.len()) && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
    });
    match extension {
        Some(extension) => format!("{}.{extension}", random_name()),
        None => random_name(),
    }
}

impl Store {
    /// The buckets under `root`, a folder each, made when missing: their objects read back from what an earlier start
    /// kept, a key written twice its later object, and what a stop cut short removed, the files this store names
    /// alone. What can't be read back is said, and left as it is.
    pub fn open(root: &Path, buckets: &[String], say: &dyn Fn(&str)) -> io::Result<Self> {
        let mut state = State::default();
        for bucket in buckets {
            let folder = root.join(bucket);
            fs::create_dir_all(&folder)?;
            match fs::remove_dir_all(folder.join(UPLOADS)) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                _ => {}
            }
            state.objects.insert(bucket.clone(), read_back(&folder, say)?);
        }
        Ok(Self { root: root.to_path_buf(), state: Mutex::new(state) })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn has(&self, bucket: &str) -> bool {
        self.state().objects.contains_key(bucket)
    }

    /// The object a key names, and its file, opened.
    pub fn open_object(&self, bucket: &str, key: &str) -> io::Result<Option<(Object, File)>> {
        let state = self.state();
        let Some(object) = state.objects.get(bucket).and_then(|objects| objects.get(key)) else { return Ok(None) };
        // Opened while the key names it, so that a write that takes its place can't remove it first.
        let file = File::open(self.root.join(bucket).join(&object.file))?;
        Ok(Some((object.clone(), file)))
    }

    /// What `read` makes of a bucket's objects, in their keys' order; none for a bucket that isn't one.
    pub fn read<T>(&self, bucket: &str, read: impl FnOnce(&BTreeMap<String, Object>) -> T) -> Option<T> {
        self.state().objects.get(bucket).map(read)
    }

    /// A new file for an object of the bucket, under that key.
    pub fn writing(&self, bucket: &str, key: &str) -> io::Result<Writing> {
        let name = file_name(key);
        let path = self.root.join(bucket).join(format!(".{name}{WRITING}"));
        Ok(Writing { file: File::create(&path)?, path, name })
    }

    /// The object written, kept under its key, beside it what a read answers of it; the object it takes the place of
    /// removed.
    pub fn keep(&self, bucket: &str, writing: Writing, mut object: Object) -> io::Result<()> {
        let folder = self.root.join(bucket);
        let Writing { file, path, name } = writing;
        drop(file);
        let kept = folder.join(&name);
        if let Err(error) = fs::rename(&path, &kept) {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        object.file = name.clone();
        if let Err(error) = describe(&folder, &object) {
            let _ = fs::remove_file(&kept);
            return Err(error);
        }
        let replaced =
            self.state().objects.get_mut(bucket).and_then(|objects| objects.insert(object.key.clone(), object));
        if let Some(replaced) = replaced {
            remove_files(&folder, &replaced.file);
        }
        Ok(())
    }

    /// The object a key names removed, its files with it; none when there was none.
    pub fn remove(&self, bucket: &str, key: &str) -> Option<Object> {
        let removed = self.state().objects.get_mut(bucket).and_then(|objects| objects.remove(key))?;
        remove_files(&self.root.join(bucket), &removed.file);
        Some(removed)
    }

    /// A multipart upload begun, for an object of the bucket under that key with those headers: its ID.
    pub fn begin_upload(
        &self,
        bucket: &str,
        key: &str,
        headers: Vec<(String, String)>,
        now: i64,
    ) -> io::Result<String> {
        let id = random_name();
        fs::create_dir_all(self.root.join(bucket).join(UPLOADS).join(&id))?;
        let upload = Upload { bucket: bucket.into(), key: key.into(), initiated: now, headers, parts: BTreeMap::new() };
        self.state().uploads.insert(id.clone(), upload);
        Ok(id)
    }

    /// An upload under way, by its ID.
    pub fn upload(&self, id: &str) -> Option<Upload> {
        self.state().uploads.get(id).cloned()
    }

    /// The bucket's uploads under way, by their keys, then their IDs.
    pub fn uploads_of(&self, bucket: &str) -> Vec<(String, Upload)> {
        let state = self.state();
        let mut uploads: Vec<(String, Upload)> = state
            .uploads
            .iter()
            .filter(|(_, upload)| upload.bucket == bucket)
            .map(|(id, upload)| (id.clone(), upload.clone()))
            .collect();
        uploads.sort_by(|(a_id, a), (b_id, b)| (&a.key, a_id).cmp(&(&b.key, b_id)));
        uploads
    }

    /// A new file for a part of an upload.
    pub fn writing_part(&self, bucket: &str, id: &str, number: u32) -> io::Result<Writing> {
        let path = self.root.join(bucket).join(UPLOADS).join(id).join(format!("{number}-{}", random_name()));
        Ok(Writing { file: File::create(&path)?, path, name: String::new() })
    }

    /// A part written, kept as the upload's part of its number, the part it takes the place of removed; false, and
    /// the part removed, when the upload ended meanwhile.
    pub fn keep_part(&self, id: &str, number: u32, writing: Writing, size: u64, md5: [u8; 16], now: i64) -> bool {
        let Writing { file, path, .. } = writing;
        drop(file);
        let part = Part { file: path.clone(), size, md5, modified: now };
        let replaced = match self.state().uploads.get_mut(id) {
            Some(upload) => upload.parts.insert(number, part),
            None => {
                let _ = fs::remove_file(&path);
                return false;
            }
        };
        if let Some(replaced) = replaced {
            let _ = fs::remove_file(replaced.file);
        }
        true
    }

    /// An upload ended, completed or aborted: none when it had ended already. Its parts stay until `remove_parts`.
    pub fn end_upload(&self, id: &str) -> Option<Upload> {
        self.state().uploads.remove(id)
    }

    /// An ended upload's parts removed.
    pub fn remove_parts(&self, bucket: &str, id: &str) {
        let _ = fs::remove_dir_all(self.root.join(bucket).join(UPLOADS).join(id));
    }
}

/// What a read answers of an object, written beside its file, to a file of its own first, as the object's is.
fn describe(folder: &Path, object: &Object) -> io::Result<()> {
    let described = folder.join(format!("{}{DESCRIBED}", object.file));
    let writing = folder.join(format!(".{}{DESCRIBED}{WRITING}", object.file));
    let text = serde_json::to_string_pretty(object).map_err(io::Error::other)?;
    fs::write(&writing, text + "\n").and_then(|()| fs::rename(&writing, &described)).inspect_err(|_| {
        let _ = fs::remove_file(&writing);
    })
}

/// An object's files: what a read answers of it first, so that a stop between the two leaves a file read back as none.
fn remove_files(folder: &Path, file: &str) {
    let _ = fs::remove_file(folder.join(format!("{file}{DESCRIBED}")));
    let _ = fs::remove_file(folder.join(file));
}

/// A bucket's objects, from its folder's files.
fn read_back(folder: &Path, say: &dyn Fn(&str)) -> io::Result<BTreeMap<String, Object>> {
    let names: Vec<String> =
        fs::read_dir(folder)?.flatten().filter_map(|entry| entry.file_name().into_string().ok()).collect();
    let mut objects: BTreeMap<String, Object> = BTreeMap::new();
    // The files of objects that can't be read back: left as they are.
    let mut unread: HashSet<String> = HashSet::new();
    for name in &names {
        let Some(file) = name.strip_suffix(DESCRIBED).filter(|file| is_random_name(file)) else { continue };
        let path = folder.join(name);
        let read = fs::read_to_string(&path)
            .map_err(|error| error.to_string())
            .and_then(|text| serde_json::from_str::<Object>(&text).map_err(|error| error.to_string()));
        let object = match read {
            Ok(object) if object.file == file && folder.join(file).is_file() => object,
            Ok(_) => {
                // Its object's file is gone: a stop came between their removals.
                let _ = fs::remove_file(&path);
                continue;
            }
            Err(error) => {
                say(&format!("ff local couldn't read {}, which it leaves as it is: {error}", path.display()));
                unread.insert(file.to_owned());
                continue;
            }
        };
        let older = match objects.get(&object.key) {
            Some(kept) if (kept.modified, &kept.file) > (object.modified, &object.file) => object,
            _ => match objects.insert(object.key.clone(), object) {
                Some(older) => older,
                None => continue,
            },
        };
        remove_files(folder, &older.file);
    }
    let kept: HashSet<&str> = objects.values().map(|object| object.file.as_str()).collect();
    for name in &names {
        let cut_short = name
            .strip_prefix('.')
            .and_then(|name| name.strip_suffix(WRITING))
            .is_some_and(|name| is_random_name(name) || name.strip_suffix(DESCRIBED).is_some_and(is_random_name));
        let orphan = is_random_name(name) && !kept.contains(name.as_str()) && !unread.contains(name);
        if cut_short || orphan {
            let _ = fs::remove_file(folder.join(name));
        }
    }
    Ok(objects)
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::sync::Arc;

    use super::*;

    fn object(key: &str, size: u64, modified: i64) -> Object {
        Object {
            key: key.into(),
            file: String::new(),
            size,
            etag: "\"etag\"".into(),
            modified,
            headers: vec![("content-type".into(), "text/plain".into())],
            parts: Vec::new(),
        }
    }

    fn put(store: &Store, key: &str, data: &[u8], modified: i64) -> Object {
        let mut writing = store.writing("photos", key).unwrap();
        writing.write_all(data).unwrap();
        store.keep("photos", writing, object(key, data.len() as u64, modified)).unwrap();
        store.open_object("photos", key).unwrap().unwrap().0
    }

    fn files(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> =
            fs::read_dir(folder).unwrap().flatten().map(|entry| entry.file_name().into_string().unwrap()).collect();
        names.sort();
        names
    }

    fn said() -> (Arc<Mutex<Vec<String>>>, impl Fn(&str)) {
        let said = Arc::new(Mutex::new(Vec::new()));
        let to = Arc::clone(&said);
        (said, move |line: &str| to.lock().unwrap().push(line.to_owned()))
    }

    #[test]
    fn an_object_is_a_file_named_with_its_keys_extension_and_beside_it_what_a_read_answers() {
        let root = tempfile::tempdir().unwrap();
        let (_, say) = said();
        let store = Store::open(root.path(), &["photos".into()], &say).unwrap();

        let kept = put(&store, "2026/cat.JPG", b"meow", 1);

        assert!(kept.file.ends_with(".JPG") && is_random_name(&kept.file), "{}", kept.file);
        let described = format!("{}{DESCRIBED}", kept.file);
        assert_eq!(files(&root.path().join("photos")), [kept.file.clone(), described.clone()]);
        let read: Object =
            serde_json::from_str(&fs::read_to_string(root.path().join("photos").join(described)).unwrap()).unwrap();
        assert_eq!(read, kept);
        assert!(!file_name("notes").contains('.'));
        assert!(!file_name("archive.tar.gz/README").contains('.'), "the last segment's extension alone");
        assert!(!file_name("a.not-an-extension").contains('.'));
    }

    #[test]
    fn a_write_takes_its_keys_place_and_a_read_under_way_goes_on_reading_what_it_began_with() {
        let root = tempfile::tempdir().unwrap();
        let (_, say) = said();
        let store = Store::open(root.path(), &["photos".into()], &say).unwrap();
        put(&store, "a.txt", b"first", 1);

        let (_, mut reading) = store.open_object("photos", "a.txt").unwrap().unwrap();
        let second = put(&store, "a.txt", b"second", 2);
        let mut began_with = String::new();
        reading.read_to_string(&mut began_with).unwrap();

        assert_eq!(began_with, "first");
        assert_eq!(files(&root.path().join("photos")), [second.file.clone(), format!("{}{DESCRIBED}", second.file)]);
        assert_eq!(store.remove("photos", "a.txt").map(|removed| removed.size), Some(6));
        assert!(files(&root.path().join("photos")).is_empty());
        assert_eq!(store.remove("photos", "a.txt"), None);
    }

    #[test]
    fn a_start_reads_the_objects_back_a_keys_later_one_kept_and_removes_what_a_stop_cut_short() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("photos");
        let (said_lines, say) = said();
        let store = Store::open(root.path(), &["photos".into()], &say).unwrap();
        let kept = put(&store, "a.txt", b"later", 2);
        put(&store, "b.txt", b"bee", 1);
        // An earlier object of the key, which a stop left beside the later one.
        let earlier = Object { file: format!("{}.txt", random_name()), ..object("a.txt", 7, 1) };
        fs::write(folder.join(&earlier.file), "earlier").unwrap();
        describe(&folder, &earlier).unwrap();
        // A write cut short, an object without what a read answers of it, and one whose file is gone.
        fs::write(folder.join(format!(".{}{WRITING}", random_name())), "half").unwrap();
        fs::write(folder.join(random_name()), "orphan").unwrap();
        let gone = Object { file: random_name(), ..object("gone.txt", 1, 1) };
        describe(&folder, &gone).unwrap();
        // What isn't the store's, and what can't be read back.
        fs::write(folder.join("notes.md"), "the developer's").unwrap();
        let unreadable = random_name();
        fs::write(folder.join(&unreadable), "kept").unwrap();
        fs::write(folder.join(format!("{unreadable}{DESCRIBED}")), "{").unwrap();
        fs::create_dir_all(folder.join(UPLOADS).join("an-upload")).unwrap();
        drop(store);

        let store = Store::open(root.path(), &["photos".into(), "exports".into()], &say).unwrap();

        let keys = store.read("photos", |objects| objects.keys().cloned().collect::<Vec<_>>()).unwrap();
        assert_eq!(keys, ["a.txt", "b.txt"]);
        assert_eq!(store.open_object("photos", "a.txt").unwrap().unwrap().0, kept);
        let left = files(&folder);
        assert_eq!(left.len(), 7, "{left:?}");
        assert!(left.contains(&"notes.md".to_owned()) && left.contains(&unreadable));
        assert!(!left.iter().any(|name| name.contains(&earlier.file) || name.starts_with('.')), "{left:?}");
        assert!(root.path().join("exports").is_dir() && store.has("exports") && !store.has("other"));
        let said_lines = said_lines.lock().unwrap();
        assert_eq!(said_lines.len(), 1);
        assert!(said_lines[0].starts_with("ff local couldn't read ") && said_lines[0].contains(&unreadable));
    }

    #[test]
    fn an_uploads_parts_are_files_until_it_ends() {
        let root = tempfile::tempdir().unwrap();
        let (_, say) = said();
        let store = Store::open(root.path(), &["photos".into()], &say).unwrap();
        let id = store.begin_upload("photos", "big.bin", Vec::new(), 1).unwrap();

        for (number, data) in [(2, &b"second"[..]), (1, b"one"), (1, b"first")] {
            let mut writing = store.writing_part("photos", &id, number).unwrap();
            writing.write_all(data).unwrap();
            assert!(store.keep_part(&id, number, writing, data.len() as u64, crate::md5::digest(data), 1));
        }

        let upload = store.upload(&id).unwrap();
        let sizes: Vec<(u32, u64)> = upload.parts.iter().map(|(number, part)| (*number, part.size)).collect();
        assert_eq!(sizes, [(1, 5), (2, 6)]);
        assert_eq!(upload.parts[&1].etag(), format!("\"{}\"", crate::md5::hex(b"first")));
        assert_eq!(files(&root.path().join("photos").join(UPLOADS).join(&id)).len(), 2, "the replaced part removed");
        assert_eq!(store.uploads_of("photos").len(), 1);
        assert!(store.end_upload(&id).is_some() && store.end_upload(&id).is_none());
        let late = store.writing_part("photos", &id, 3).unwrap();
        assert!(!store.keep_part(&id, 3, late, 0, [0; 16], 1), "a part of an ended upload");
        store.remove_parts("photos", &id);
        assert!(files(&root.path().join("photos").join(UPLOADS)).is_empty());
    }
}
