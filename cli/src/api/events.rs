//! Server-Sent Events, as the API's live tail sends them: `event:`, `id:` and `data:` lines, an
//! empty line ending each event, and data over several lines joined with newlines.

use std::io::BufRead;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    /// `message` unless the event names another, as `ping`, `end` or `unavailable`.
    pub kind: String,
    pub data: String,
}

/// The events of a stream, as they come; none more once it ends or fails.
pub struct Events<R> {
    reader: R,
}

impl<R: BufRead> Events<R> {
    pub fn new(reader: R) -> Self {
        Events { reader }
    }
}

impl<R: BufRead> Iterator for Events<R> {
    type Item = std::io::Result<Event>;

    fn next(&mut self) -> Option<Self::Item> {
        let mut kind = None;
        let mut data: Option<String> = None;
        loop {
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Err(error) => return Some(Err(error)),
                // The stream ended: an event cut short is dropped, as the standard says.
                Ok(0) => return None,
                Ok(_) => {}
            }
            let line = line.strip_suffix('\n').unwrap_or(&line);
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.is_empty() {
                if kind.is_none() && data.is_none() {
                    continue;
                }
                return Some(Ok(Event {
                    kind: kind.unwrap_or_else(|| "message".to_owned()),
                    data: data.unwrap_or_default(),
                }));
            }
            if line.starts_with(':') {
                continue; // a comment
            }
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "event" => kind = Some(value.to_owned()),
                "data" => match &mut data {
                    Some(data) => {
                        data.push('\n');
                        data.push_str(value);
                    }
                    None => data = Some(value.to_owned()),
                },
                _ => {} // id and retry: nothing ff needs
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(text: &str) -> Vec<Event> {
        Events::new(text.as_bytes()).map(Result::unwrap).collect()
    }

    fn event(kind: &str, data: &str) -> Event {
        Event { kind: kind.into(), data: data.into() }
    }

    #[test]
    fn reads_the_events_the_api_sends() {
        let stream = "id: 1\ndata: {\"message\":\"hi\"}\n\nevent: ping\nid: 2\ndata: \n\nevent: end\nid: 3\ndata: {\"message\":\"The live tail lasts 30 minutes\"}\n\n";

        assert_eq!(
            events(stream),
            [
                event("message", "{\"message\":\"hi\"}"),
                event("ping", ""),
                event("end", "{\"message\":\"The live tail lasts 30 minutes\"}")
            ]
        );
    }

    #[test]
    fn joins_data_over_lines_takes_crlf_skips_comments_and_drops_an_event_cut_short() {
        let stream = ": keep-alive\r\n\r\ndata: one\r\ndata: two\r\n\r\ndata: cut";

        assert_eq!(events(stream), [event("message", "one\ntwo")]);
    }

    #[test]
    fn reads_events_split_across_reads() {
        // A reader that hands one byte at a time, as a slow network may.
        struct Trickle<'a>(&'a [u8]);
        impl std::io::Read for Trickle<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if self.0.is_empty() || buffer.is_empty() {
                    return Ok(0);
                }
                buffer[0] = self.0[0];
                self.0 = &self.0[1..];
                Ok(1)
            }
        }
        let reader = std::io::BufReader::with_capacity(1, Trickle(b"data: a\n\nevent: ping\ndata: \n\n"));

        assert_eq!(
            Events::new(reader).map(Result::unwrap).collect::<Vec<_>>(),
            [event("message", "a"), event("ping", "")]
        );
    }
}
