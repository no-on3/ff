//! BLAKE2b-512, written from RFC 7693 (its section 3 and appendix C): no key, a 64-byte digest, fed in pieces of any
//! size, as a file is read. The other way to minisign's prehash, beside the blake2 crate.

const IV: [u64; 8] = [
    0x6a09e667f3bcc908,
    0xbb67ae8584caa73b,
    0x3c6ef372fe94f82b,
    0xa54ff53a5f1d36f1,
    0x510e527fade682d1,
    0x9b05688c2b3e6c1f,
    0x1f83d9abfb41bd6b,
    0x5be0cd19137e2179,
];

// The message words' order in each of the twelve rounds (the last two repeat the first two).
const SIGMA: [[usize; 16]; 12] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

const BLOCK: usize = 128;

#[inline(always)]
fn mix(v: &mut [u64; 16], a: usize, b: usize, c: usize, d: usize, x: u64, y: u64) {
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(x);
    v[d] = (v[d] ^ v[a]).rotate_right(32);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(24);
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(y);
    v[d] = (v[d] ^ v[a]).rotate_right(16);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(63);
}

fn compress(h: &mut [u64; 8], block: &[u8; BLOCK], bytes: u128, last: bool) {
    let mut m = [0u64; 16];
    for (word, chunk) in m.iter_mut().zip(block.chunks_exact(8)) {
        *word = u64::from_le_bytes(chunk.try_into().expect("8 bytes"));
    }
    let mut v = [0u64; 16];
    v[..8].copy_from_slice(h);
    v[8..].copy_from_slice(&IV);
    v[12] ^= bytes as u64;
    v[13] ^= (bytes >> 64) as u64;
    if last {
        v[14] = !v[14];
    }
    for s in &SIGMA {
        mix(&mut v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
        mix(&mut v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
        mix(&mut v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
        mix(&mut v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
        mix(&mut v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
        mix(&mut v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
        mix(&mut v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
        mix(&mut v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for i in 0..8 {
        h[i] ^= v[i] ^ v[i + 8];
    }
}

pub struct Blake2b512 {
    h: [u64; 8],
    block: [u8; BLOCK],
    filled: usize,
    bytes: u128,
}

impl Default for Blake2b512 {
    fn default() -> Self {
        let mut h = IV;
        // The parameter block's first word: a 64-byte digest, no key, fanout and depth 1.
        h[0] ^= 0x0101_0000 ^ 64;
        Blake2b512 { h, block: [0; BLOCK], filled: 0, bytes: 0 }
    }
}

impl Blake2b512 {
    pub fn update(&mut self, mut data: &[u8]) {
        while !data.is_empty() {
            // A full block is compressed only once more data comes: the last block, full or not, is compressed apart.
            if self.filled == BLOCK {
                self.bytes += BLOCK as u128;
                compress(&mut self.h, &self.block, self.bytes, false);
                self.filled = 0;
            }
            let take = (BLOCK - self.filled).min(data.len());
            self.block[self.filled..self.filled + take].copy_from_slice(&data[..take]);
            self.filled += take;
            data = &data[take..];
        }
    }

    pub fn finalize(mut self) -> [u8; 64] {
        self.bytes += self.filled as u128;
        self.block[self.filled..].fill(0);
        compress(&mut self.h, &self.block, self.bytes, true);
        let mut out = [0u8; 64];
        for (chunk, word) in out.chunks_exact_mut(8).zip(self.h) {
            chunk.copy_from_slice(&word.to_le_bytes());
        }
        out
    }
}

pub fn digest(data: &[u8]) -> [u8; 64] {
    let mut hasher = Blake2b512::default();
    hasher.update(data);
    hasher.finalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn rfc_7693s_example_and_the_empty_message() {
        // RFC 7693, appendix A: BLAKE2b-512("abc").
        assert_eq!(
            hex(&digest(b"abc")),
            "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1\
             7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"
        );
        assert_eq!(
            hex(&digest(b"")),
            "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419\
             d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce"
        );
    }

    #[test]
    fn pieces_of_any_size_give_the_whole_messages_digest() {
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 7 + 3) as u8).collect();
        for len in [0, 1, 127, 128, 129, 255, 256, 257, 1000] {
            let whole = digest(&data[..len]);
            for piece in [1, 3, 64, 128, 200] {
                let mut hasher = Blake2b512::default();
                data[..len].chunks(piece).for_each(|chunk| hasher.update(chunk));
                assert_eq!(hasher.finalize(), whole, "{len} bytes in pieces of {piece}");
            }
        }
    }

    #[cfg(feature = "blake2-crate")]
    #[test]
    fn the_same_digests_as_the_blake2_crate() {
        use blake2::Digest;
        let data: Vec<u8> = (0..2000u32).map(|i| (i * 31 + 11) as u8).collect();
        for len in (0..=600).chain([1023, 1024, 1025, 2000]) {
            let theirs: [u8; 64] = blake2::Blake2b512::digest(&data[..len]).as_slice().try_into().unwrap();
            assert_eq!(digest(&data[..len]), theirs, "{len} bytes");
        }
    }
}
