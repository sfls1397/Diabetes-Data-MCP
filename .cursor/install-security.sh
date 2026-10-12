#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/bin:$PATH"
bash .cursor/install-gitleaks.sh
bash .cursor/install-semgrep.sh
bash .cursor/install-shellcheck.sh
# CI has no committer identity by default; do not inherit a runner hostname.
if ! git config user.email >/dev/null; then git config user.email '241515594+sfls1397@users.noreply.github.com'; fi
if ! git config user.name >/dev/null; then git config user.name 'Repository Agent'; fi
chmod +x .githooks/pre-commit .githooks/commit-msg .githooks/pre-push
python3 .security/scan.py all
echo 'In this and future shells: export PATH="$HOME/.local/bin:$PATH"'
