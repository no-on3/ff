//! A package's zip, as AWS Lambda takes one, and the same zip each time for the same files:
//! entries in the order of their names, dated 1980-01-01, 0644 or 0755 for the files that run,
//! deflated when that makes them smaller, names in UTF-8. No folder entries, no extra fields, no
//! zip64: a package has 20,000 files and 250 MB unpacked at most.

use std::io::{self, Write};
use std::path::PathBuf;

use flate2::Compression;
use flate2::write::DeflateEncoder;

/// A file of the package: its name in the zip, '/'-separated from the root; where its bytes are;
/// whether it runs.
#[derive(Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub source: PathBuf,
    pub executable: bool,
}

/// 1980-01-01 00:00, the earliest date a zip holds.
const DOS_TIME: u16 = 0;
const DOS_DATE: u16 = 1 << 5 | 1;
/// UTF-8 names.
const FLAGS: u16 = 0x0800;
/// Made on Unix (3), to the zip specification 2.0, so that the external attributes hold a mode.
const MADE_BY: u16 = 3 << 8 | 20;
const NEEDS: u16 = 20;

fn u16le(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn u32le(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn too_large(what: &str) -> io::Error {
    io::Error::other(format!("{what} is past what a zip without zip64 holds"))
}

/// The zip of these files, read one at a time, in the order of their names: what is written
/// depends on the names, the bytes and the executable bits alone.
pub fn write(mut entries: Vec<Entry>) -> io::Result<Vec<u8>> {
    entries.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
    let mut out = Vec::new();
    let mut directory = Vec::new();
    for entry in &entries {
        let data = std::fs::read(&entry.source)?;
        let crc = crc32fast::hash(&data);
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&data)?;
        let deflated = encoder.finish()?;
        // Stored when deflate doesn't help, as zip tools do: the same input still gives the same choice.
        let (method, body): (u16, &[u8]) = if deflated.len() < data.len() { (8, &deflated) } else { (0, &data) };
        let name = entry.name.as_bytes();
        let offset = u32::try_from(out.len()).map_err(|_| too_large("the zip"))?;
        let size = u32::try_from(data.len()).map_err(|_| too_large(&entry.name))?;
        let packed = u32::try_from(body.len()).map_err(|_| too_large(&entry.name))?;
        let name_length = u16::try_from(name.len()).map_err(|_| too_large(&entry.name))?;

        u32le(&mut out, 0x0403_4b50);
        u16le(&mut out, NEEDS);
        u16le(&mut out, FLAGS);
        u16le(&mut out, method);
        u16le(&mut out, DOS_TIME);
        u16le(&mut out, DOS_DATE);
        u32le(&mut out, crc);
        u32le(&mut out, packed);
        u32le(&mut out, size);
        u16le(&mut out, name_length);
        u16le(&mut out, 0);
        out.extend_from_slice(name);
        out.extend_from_slice(body);

        let mode: u32 = if entry.executable { 0o100755 } else { 0o100644 };
        u32le(&mut directory, 0x0201_4b50);
        u16le(&mut directory, MADE_BY);
        u16le(&mut directory, NEEDS);
        u16le(&mut directory, FLAGS);
        u16le(&mut directory, method);
        u16le(&mut directory, DOS_TIME);
        u16le(&mut directory, DOS_DATE);
        u32le(&mut directory, crc);
        u32le(&mut directory, packed);
        u32le(&mut directory, size);
        u16le(&mut directory, name_length);
        u16le(&mut directory, 0); // extra field
        u16le(&mut directory, 0); // comment
        u16le(&mut directory, 0); // disk
        u16le(&mut directory, 0); // internal attributes
        u32le(&mut directory, mode << 16);
        u32le(&mut directory, offset);
        directory.extend_from_slice(name);
    }
    let count = u16::try_from(entries.len()).map_err(|_| too_large("the number of files"))?;
    let directory_offset = u32::try_from(out.len()).map_err(|_| too_large("the zip"))?;
    let directory_size = u32::try_from(directory.len()).map_err(|_| too_large("the zip's directory"))?;
    out.extend_from_slice(&directory);
    u32le(&mut out, 0x0605_4b50);
    u16le(&mut out, 0);
    u16le(&mut out, 0);
    u16le(&mut out, count);
    u16le(&mut out, count);
    u32le(&mut out, directory_size);
    u32le(&mut out, directory_offset);
    u16le(&mut out, 0);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use flate2::read::DeflateDecoder;

    use super::*;

    /// An entry as a reader finds it in the zip's central directory, its bytes inflated.
    struct Found {
        name: String,
        mode: u32,
        method: u16,
        /// Its DOS time and date.
        date: (u16, u16),
        data: Vec<u8>,
    }

    /// The entries of a zip as a reader finds them, their bytes checked against their CRC-32.
    fn read(zip: &[u8]) -> Vec<Found> {
        let u16at = |at: usize| u16::from_le_bytes([zip[at], zip[at + 1]]);
        let u32at = |at: usize| u32::from_le_bytes([zip[at], zip[at + 1], zip[at + 2], zip[at + 3]]);
        let end = zip.len() - 22;
        assert_eq!(u32at(end), 0x0605_4b50);
        let (count, mut at) = (u16at(end + 10) as usize, u32at(end + 16) as usize);
        let mut entries = Vec::new();
        for _ in 0..count {
            assert_eq!(u32at(at), 0x0201_4b50);
            let (method, time, date, crc) = (u16at(at + 10), u16at(at + 12), u16at(at + 14), u32at(at + 16));
            let (packed, size, name_length) =
                (u32at(at + 20) as usize, u32at(at + 24) as usize, u16at(at + 28) as usize);
            let (mode, offset) = (u32at(at + 38) >> 16, u32at(at + 42) as usize);
            let name = String::from_utf8(zip[at + 46..at + 46 + name_length].to_vec()).unwrap();
            let start = offset + 30 + u16at(offset + 26) as usize + u16at(offset + 28) as usize;
            let body = &zip[start..start + packed];
            let data = if method == 8 {
                let mut inflated = Vec::new();
                DeflateDecoder::new(body).read_to_end(&mut inflated).unwrap();
                inflated
            } else {
                body.to_vec()
            };
            assert_eq!((data.len(), crc32fast::hash(&data)), (size, crc), "{name}");
            entries.push(Found { name, mode, method, date: (time, date), data });
            at += 46 + name_length;
        }
        entries
    }

    #[test]
    fn holds_the_files_in_the_order_of_their_names_with_their_modes_at_1980_deflated_when_smaller() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = |name: &str, data: &[u8]| {
            let path = dir.path().join(name.replace('/', "_"));
            std::fs::write(&path, data).unwrap();
            path
        };
        let entries = vec![
            Entry { name: "src/app.js".into(), source: file("src/app.js", &[b'x'; 1000]), executable: false },
            Entry { name: "bin/run".into(), source: file("bin/run", b"#!/bin/sh\n"), executable: true },
            Entry { name: "é.txt".into(), source: file("e.txt", b""), executable: false },
        ];

        let zip = write(entries).unwrap();

        let read = read(&zip);
        let summary: Vec<_> = read
            .iter()
            .map(|found| (found.name.as_str(), found.mode, found.method, found.date, found.data.len()))
            .collect();
        assert_eq!(
            summary,
            [
                ("bin/run", 0o100755, 0, (0, 0x21), 10),
                ("src/app.js", 0o100644, 8, (0, 0x21), 1000),
                ("é.txt", 0o100644, 0, (0, 0x21), 0),
            ]
        );
    }

    #[test]
    fn is_the_same_byte_for_byte_from_the_same_files_in_any_order() {
        let dir = tempfile::TempDir::new().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::write(&a, "exports.handler = async () => 1;\n").unwrap();
        std::fs::write(&b, "module.exports = 2;\n").unwrap();
        let entries = vec![
            Entry { name: "index.js".into(), source: a, executable: false },
            Entry { name: "lib/b.js".into(), source: b, executable: false },
        ];
        let mut reversed = entries.clone();
        reversed.reverse();

        assert_eq!(write(entries).unwrap(), write(reversed).unwrap());
    }
}
