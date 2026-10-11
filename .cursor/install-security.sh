#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/bin:$PATH"
bash .cursor/install-gitleaks.sh
bash .cursor/install-semgrep.sh
python3 .security/scan.py all
echo 'In this and future shells: export PATH="$HOME/.local/bin:$PATH"'
