# shellcheck shell=bash
# The files of a release of ff, one for each system it is built for, as hack/build-cli.sh names them: read by
# hack/release.sh, which signs them, and by the tests that make a release of their own.
# shellcheck disable=SC2034 # used by the scripts that source it
FF_BUILDS=(ff-linux-x86_64 ff-linux-arm64 ff-windows-x86_64.exe ff-macos-arm64 ff-macos-x86_64)
