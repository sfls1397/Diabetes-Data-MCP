#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
bash .cursor/install-gitleaks.sh
bash .cursor/install-semgrep.sh
export PATH="$HOME/.local/bin:$PATH"
python3 .security/scan.py all
