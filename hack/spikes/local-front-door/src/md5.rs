//! MD5 (RFC 1321): an object's ETag, as S3 gives one, and the sums of a message SQS answers, which AWS's SDKs check.
//! `ring` has no MD5, being no longer a secure hash; here it is a checksum alone, so it is written from the RFC.

/// Each step's left rotation.
const SHIFTS: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
    21,
];

/// Each step's constant, the integer part of 2³² times |sin(i + 1)|, as the RFC's table gives them.
const CONSTANTS: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8,
    0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
    0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87,
    0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039,
    0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
    0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
    0xeb86d391,
];

/// A running MD5, fed piece by piece, as a body streams.
#[derive(Clone)]
pub struct Md5 {
    state: [u32; 4],
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
        let bits = self.length.wrapping_mul(8);
        self.update(&[0x80]);
        while self.buffered != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_le_bytes());
        let mut digest = [0; 16];
        for (word, out) in self.state.iter().zip(digest.chunks_exact_mut(4)) {
            out.copy_from_slice(&word.to_le_bytes());
        }
        digest
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let words: Vec<u32> =
            block.chunks_exact(4).map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap())).collect();
        let [mut a, mut b, mut c, mut d] = self.state;
        for step in 0..64 {
            let (mixed, word) = match step / 16 {
                0 => ((b & c) | (!b & d), step),
                1 => ((d & b) | (!d & c), (5 * step + 1) % 16),
                2 => (b ^ c ^ d, (3 * step + 5) % 16),
                _ => (c ^ (b | !d), (7 * step) % 16),
            };
            let rotated =
                a.wrapping_add(mixed).wrapping_add(CONSTANTS[step]).wrapping_add(words[word]).rotate_left(SHIFTS[step]);
            (a, d, c, b) = (d, c, b, b.wrapping_add(rotated));
        }
        for (state, value) in self.state.iter_mut().zip([a, b, c, d]) {
            *state = state.wrapping_add(value);
        }
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The MD5 of the bytes, in hex, as S3's ETags and SQS's sums are.
pub fn md5_hex(data: &[u8]) -> String {
    let mut md5 = Md5::default();
    md5.update(data);
    hex(&md5.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gives_the_rfcs_test_suite_values() {
        let suite = [
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
        ];
        for (input, expected) in suite {
            assert_eq!(md5_hex(input.as_bytes()), expected, "{input:?}");
        }
    }

    #[test]
    fn gives_the_same_value_the_bytes_in_any_pieces() {
        let data: Vec<u8> = (0..1000u32).map(|n| (n * 7) as u8).collect();
        for size in [1, 3, 63, 64, 65, 999] {
            let mut md5 = Md5::default();
            data.chunks(size).for_each(|piece| md5.update(piece));
            assert_eq!(hex(&md5.finish()), md5_hex(&data), "pieces of {size}");
        }
    }
}
