# Agent Instructions

## Cursor Cloud specific instructions

Follow the always-applied [.cursor/rules/gitleaks.mdc](.cursor/rules/gitleaks.mdc) before changing, committing, or opening/updating a PR. Cloud setup runs `bash .cursor/install-gitleaks.sh` via `.cursor/environment.json` to install checksum-verified Gitleaks and enable `.githooks`. In each fresh shell, run `export PATH="$HOME/.local/bin:$PATH"` for the fallback install directory, then stage changes and run `.githooks/pre-commit`. Use the GitHub noreply identity and keep secrets and personal data out of code, prompts, and PR text.
