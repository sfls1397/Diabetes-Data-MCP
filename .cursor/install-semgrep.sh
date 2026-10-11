#!/usr/bin/env bash
# Shared pinned scanner installation for Cursor Linux and host Python 3.10+.
set -euo pipefail
version='1.180.0'
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
install_root="$HOME/.local/share/repo-security/semgrep-$version"
export SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' || {
  echo 'Semgrep setup requires Python 3.10 or newer with venv.' >&2; exit 1;
}
if [[ ! -x "$install_root/bin/semgrep" ]] || [[ "$("$install_root/bin/semgrep" --version 2>/dev/null)" != "$version" ]]; then
  mkdir -p -- "$(dirname -- "$install_root")"
  # Default cloud images omit ensurepip; keep the same pin via system pip.
  if python3 -c 'import ensurepip' >/dev/null 2>&1; then
    python3 -m venv --clear "$install_root"
  else
    python3 -m venv --clear --without-pip --system-site-packages "$install_root"
  fi
  if ! "$install_root/bin/python" -m pip install --disable-pip-version-check --quiet "semgrep==$version" >/dev/null 2>&1; then
    echo 'Pinned Semgrep installation failed; check PyPI access.' >&2; exit 1
  fi
fi
mkdir -p -- "$HOME/.local/bin"
ln -sfn -- "$install_root/bin/semgrep" "$HOME/.local/bin/semgrep"
export PATH="$HOME/.local/bin:$PATH"
[[ "$(semgrep --version 2>/dev/null)" == "$version" ]] || {
  echo 'Pinned Semgrep version verification failed.' >&2; exit 1;
}
cd "$repo_root"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
semgrep --version
