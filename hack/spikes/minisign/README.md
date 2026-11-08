# minisign spike

How `ff` will check minisign's signatures itself: on its update notice's manifest (`latest.json`), and on the images' archives it loads. The measurements behind ADR 0018 (`ff`'s releases); the [developer tools plan](../../../docs/dev-tools-plan.md)'s D2, its task list's M-01, part 5.

```bash
hack/spikes/minisign/run.sh              # about a minute the first time: the crate's builds, minisign's release
FIXTURES=1 hack/spikes/minisign/run.sh   # the fixtures made again, with new keys
```

It needs Rust (the toolchain `cli/` pins), openssl and curl. It installs minisign through `hack/install-tools.sh minisign`. Its build, the keys' secret halves, minisign's release files and the results go to `hack/.spikes/minisign/` (`results.md`). The crate stands apart from `cli/`, so `ff` takes on no dependency before the spike chooses one.

## What it does

- **The verifier** (`src/lib.rs`) reads minisign's two formats. It checks a file as `minisign -V` does:
  1. The signature must name the key's ID.
  2. Ed25519, by `ring`, must hold over the file's BLAKE2b-512.
  3. Ed25519 must hold again over that signature and the trusted comment, so the comment (the file's name, the signing time) can't be changed either.

  It gives back the trusted comment. The file is read in 64 KB pieces, never whole in memory, since an image's archive weighs hundreds of MB.
- **BLAKE2b-512 two ways:** written from RFC 7693 (`src/blake2b.rs`), or the `blake2` crate (the `blake2-crate` feature, on by default). Built without the feature, the crate is the hand-written one alone, so the two builds measure what the crate adds.
- **The fixtures,** made once by the pinned minisign and committed: two public keys, a manifest shaped as `latest.json` will be, its signature, and the same file signed in the legacy format (`-l`).
- **The checks,** 15:
  - minisign verifies its own fixture;
  - the crate's tests pass with the `blake2` crate (12) and with the hand-written BLAKE2b alone (11, without the cross-check against the crate);
  - minisign 0.12's four release files verified against its author's key, as its README gives it, by each BLAKE2b (8);
  - one of them with a byte added, refused by the spike and by minisign;
  - each BLAKE2b gives openssl's digest of 256 MB of random bytes.

  The tests refuse:
  - a changed file, longer by one byte or with one bit flipped;
  - another key, by its ID;
  - a forged key that claims the right ID, by the signature itself;
  - a changed trusted comment;
  - a signature cut short, on either line, or missing a line;
  - the legacy format, saying so;
  - a key that isn't minisign's.

  They read a signature and a key with Windows line ends as Unix's.

## What it found

On 2026-11-08, with minisign 0.12, `ring` 0.17, the `blake2` crate 0.11.0 and Rust 1.91.0, in release builds:

| | The hand-written BLAKE2b (RFC 7693) | The `blake2` crate |
|---|---|---|
| The tests | 11 passed | 12 passed |
| The crates it adds to `ff` | None | 8: blake2, block-buffer, cmov, crypto-common, ctutils, digest, hybrid-array, typenum. `ff` has none of them today. |
| The spike's command | 602,272 bytes | 615,064 bytes (+12.5 KB) |
| 256 MB hashed (one run) | 371 ms | 298 ms (openssl: 324 ms) |
| Its code | 148 lines, tests included | None |

1. **Verifying minisign's signatures needs nothing `ff` lacks.** `ring`'s Ed25519 and `base64` are both in `ff` already (`ring` 0.17.14, `base64` 0.23.1). The verifier takes 228 lines, its tests included. It verifies real signatures made by the real minisign, its author's release among them, and refuses what minisign refuses.
2. **The hash is the only choice left.** Both ways give the same digests: RFC 7693's vectors, openssl's over 256 MB, and the crate's over 605 lengths from 0 to 2,000 bytes, the blocks' edges among them. Both verify the author's release. The crate is 20% faster, which comes to 0.07 s on an image's archive of 256 MB, beside the seconds it takes to load. It weighs 8 crates and 12.5 KB.
3. **Recommendation: the hand-written BLAKE2b,** its tests being RFC 7693's vectors and the author's real release.
   - It adds no crate to `ff`. Each crate is one more to pin at a release two weeks old and one more for the nightly's advisories. Three of the eight (hybrid-array, ctutils, cmov) belong to RustCrypto's newest generation, which is still changing.
   - The code is BLAKE2b, which never changes.
   - It hashes public files, so there is no secret whose timing could leak.
   - A mistake in it would make a genuine file fail to verify, which the tests would show. For a changed file to pass, the code would have to ignore part of its input, and the tests refuse a file changed by one byte or one bit.

   The other way, the plan's, is the crate. It costs 8 crates in return for no cryptographic code of our own.
4. **The trusted comment holds the signing time.** `ff` gets the comment back once it verifies. It can refuse a `latest.json` older than the last one it saw, so a replayed old manifest can't hide a new release. ADR 0018 says whether it does.
5. **Windows line ends must be read as Unix's.** A signature or a key saved through PowerShell, or checked out with `core.autocrlf`, has them. The verifier takes both, and the tests check it.
6. **The legacy format** (minisign `-l`, which signs the file itself rather than its hash) is refused, saying so. minisign makes hashed signatures by default, and the release job will too.
7. **minisign's release publishes no checksum file,** only each file's signature by its author's key. `hack/install-tools.sh`'s SHA-256s for it were copied from files whose signatures were checked first, by openssl then and by this verifier since: the files it downloads have the same SHA-256s.

Not measured: the `minisign-verify` crate, minisign's author's verifier with no dependencies. It carries its own Ed25519 beside `ring`'s, which `ff` already has.
