//! MD5 (RFC 1321), for three uses: a file's digest as S3 gives it in the ETag of an object uploaded
//! in one piece, so that `ff sites deploy` sends only the files that changed; the ETag `ff local`'s
//! buckets give an object as it streams in; and the sums SQS answers of a message's body and
//! attributes, which AWS's SDKs check. Never for security.

const SHIFTS: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
    21,
];

/// The sines' table, K[i] = floor(2^32 × |sin(i + 1)|).
const K: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8,
    0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
    0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87,
    0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039,
    0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
    0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
    0xeb86d391,
];

/// The digest of `data`, in lower-case hexadecimal, as an ETag holds it.
pub fn hex(data: &[u8]) -> String {
    hex_of(&digest(data))
}

/// A digest in lower-case hexadecimal.
pub fn hex_of(digest: &[u8; 16]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn digest(data: &[u8]) -> [u8; 16] {
    let mut md5 = Md5::default();
    md5.update(data);
    md5.finish()
}

/// A running MD5, fed piece by piece as a body streams, so that an object's ETag needs no copy of it whole.
#[derive(Clone)]
pub struct Md5 {
    state: [u32; 4],
    /// The bytes of a block not yet whole.
    block: [u8; 64],
    buffered: usize,
    length: u64,
}

impl Default for Md5 {
    fn default() -> Self {
        Self { state: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476], block: [0; 64], buffered: 0, length: 0 }
    }
}

impl Md5 {
    pub fn update(&mut self, mut data: &[u8]) {
        self.length = self.length.wrapping_add(data.len() as u64);
        while !data.is_empty() {
            let take = (64 - self.buffered).min(data.len());
            self.block[self.buffered..self.buffered + take].copy_from_slice(&data[..take]);
            self.buffered += take;
            data = &data[take..];
            if self.buffered == 64 {
                let block = self.block;
                self.compress(&block);
                self.buffered = 0;
            }
        }
    }

    pub fn finish(mut self) -> [u8; 16] {
        // A 1 bit, zeros to 56 bytes of 64, then the message's length in bits, little-endian.
        let bits = self.length.wrapping_mul(8);
        self.update(&[0x80]);
        while self.buffered != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_le_bytes());
        let mut out = [0; 16];
        for (word, bytes) in self.state.iter().zip(out.as_chunks_mut::<4>().0) {
            *bytes = word.to_le_bytes();
        }
        out
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let words: Vec<u32> = block.as_chunks::<4>().0.iter().map(|word| u32::from_le_bytes(*word)).collect();
        let [mut a, mut b, mut c, mut d] = self.state;
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let rotated = a.wrapping_add(f).wrapping_add(K[i]).wrapping_add(words[g]).rotate_left(SHIFTS[i]);
            (a, b, c, d) = (d, b.wrapping_add(rotated), b, c);
        }
        for (state, value) in self.state.iter_mut().zip([a, b, c, d]) {
            *state = state.wrapping_add(value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digests_rfc_1321s_test_suite() {
        for (input, expected) in [
            ("", "d41d8cd98f00b204e9800998ecf8427e"),
            ("a", "0cc175b9c0f1b6a831c399e269772661"),
            ("abc", "900150983cd24fb0d6963f7d28e17f72"),
            ("message digest", "f96b697d7cb7938d525a2f31aaf161d0"),
            ("abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"),
            ("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"),
            (
                "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
                "57edf4a22be3c955ac49da2e2107b67a",
            ),
        ] {
            assert_eq!(hex(input.as_bytes()), expected, "{input:?}");
        }
    }

    #[test]
    fn digests_messages_at_a_block_s_edges_and_of_many_blocks() {
        for (length, expected) in [
            (55, "04364420e25c512fd958a70738aa8f72"),
            (56, "668a72d5ba17f08e62dabcafad6db14b"),
            (63, "7dc2ca208106a2f703567bdff99d8981"),
            (64, "c1bb4f81d892b2d57947682aeb252456"),
            (65, "1bc932052302d074bdec39795fe00cf6"),
        ] {
            assert_eq!(hex(&vec![b'x'; length]), expected, "{length} bytes");
        }
        assert_eq!(hex(&vec![b'a'; 1_000_000]), "7707d6ae4e027c70eea2a935c2296f21");
    }

    #[test]
    fn digests_a_message_fed_in_pieces_as_it_does_whole() {
        let message: Vec<u8> = (0..1_000u32).map(|i| (i * 7 % 251) as u8).collect();
        for piece in [1, 3, 63, 64, 65, 200, 1_000] {
            let mut md5 = Md5::default();
            for part in message.chunks(piece) {
                md5.update(part);
            }
            assert_eq!(hex_of(&md5.finish()), hex(&message), "in pieces of {piece}");
        }
    }
}
