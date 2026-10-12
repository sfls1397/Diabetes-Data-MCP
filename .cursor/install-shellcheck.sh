#!/usr/bin/env bash
set -euo pipefail
version=0.11.0
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64|Darwin/aarch64) target=darwin.aarch64; checksum=339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f ;;
  Darwin/x86_64) target=darwin.x86_64; checksum=c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51 ;;
  Linux/aarch64|Linux/arm64) target=linux.aarch64; checksum=68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc ;;
  Linux/x86_64) target=linux.x86_64; checksum=b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6 ;;
  *) echo 'Unsupported ShellCheck platform' >&2; exit 1 ;;
esac
export PATH="$HOME/.local/bin:$PATH"
if command -v shellcheck >/dev/null 2>&1 && shellcheck --version | awk '/version:/ {print $2}' | grep -qx "$version"; then exit 0; fi
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
archive="shellcheck-v$version.$target.tar.gz"
curl -fsSL "https://github.com/koalaman/shellcheck/releases/download/v$version/$archive" -o "$temporary/tool.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$temporary/tool.tar.gz" | awk '{print $1}'); else actual=$(shasum -a 256 "$temporary/tool.tar.gz" | awk '{print $1}'); fi
test "$actual" = "$checksum" || { echo 'ShellCheck checksum mismatch' >&2; exit 1; }
tar -xzf "$temporary/tool.tar.gz" -C "$temporary"
mkdir -p "$HOME/.local/bin"
install -m 755 "$temporary/shellcheck-v$version/shellcheck" "$HOME/.local/bin/shellcheck"
test "$(shellcheck --version | awk '/version:/ {print $2}')" = "$version"
