#!/usr/bin/env bash
# Cursor Cloud runs on Linux. Install only the checksum-verified pinned release.
set -euo pipefail

version='8.30.1'
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Gitleaks cloud setup requires Linux.' >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo 'Unsupported Linux architecture for Gitleaks cloud setup.' >&2; exit 1 ;;
esac

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
[[ -f .gitleaks.toml && -f .githooks/pre-commit ]] || {
  echo 'Gitleaks config and pre-commit hook are required.' >&2
  exit 1
}

archive="gitleaks_${version}_linux_${arch}.tar.gz"
checksums="gitleaks_${version}_checksums.txt"
release="https://github.com/gitleaks/gitleaks/releases/download/v${version}"
temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
curl --fail --silent --show-error --location --retry 3 "$release/$archive" -o "$temporary/$archive"
curl --fail --silent --show-error --location --retry 3 "$release/$checksums" -o "$temporary/$checksums"
awk -v archive="$archive" '$2 == archive && NF == 2 { print }' "$temporary/$checksums" > "$temporary/selected-checksum"
[[ "$(wc -l < "$temporary/selected-checksum")" -eq 1 ]] || {
  echo 'Expected exactly one release checksum for the Gitleaks archive.' >&2
  exit 1
}
(cd "$temporary" && sha256sum --check --status selected-checksum) || {
  echo 'Gitleaks release checksum verification failed.' >&2
  exit 1
}
tar -xzf "$temporary/$archive" -C "$temporary" gitleaks

if [[ -d /usr/local/bin && -w /usr/local/bin ]]; then
  install_dir=/usr/local/bin
else
  install_dir="$HOME/.local/bin"
  mkdir -p -- "$install_dir"
fi
if ! cmp -s "$temporary/gitleaks" "$install_dir/gitleaks"; then
  install -m 0755 "$temporary/gitleaks" "$install_dir/gitleaks"
fi
chmod +x "$install_dir/gitleaks"
# Exports last for this script only. The always-applied rule sets PATH in new shells.
export PATH="$install_dir:$PATH"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
[[ "$(gitleaks version)" == "$version" ]] || {
  echo 'Installed Gitleaks version does not match the pinned release.' >&2
  exit 1
}
gitleaks version
