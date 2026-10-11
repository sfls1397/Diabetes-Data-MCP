# Agent Instructions

## Cursor Cloud specific instructions

Follow the always-applied [.cursor/rules/gitleaks.mdc](.cursor/rules/gitleaks.mdc) before changing, committing, or opening/updating a PR. Cloud setup runs `bash .cursor/install-security.sh` via `.cursor/environment.json` to install checksum-verified Gitleaks and pinned Semgrep, enable `.githooks`, and run the production audit/code gates. In each fresh shell, run `export PATH="$HOME/.local/bin:$PATH"` for the fallback install directory, then stage changes and run `.githooks/pre-commit`. Use the GitHub noreply identity and keep secrets and personal data out of code, prompts, and PR text.

## Dependency and Code Security Gates

The shared `.githooks/pre-commit` hook applies to Codex and Claude Code on the Mini and to Cursor agents. It retains Gitleaks, audits staged production package metadata when package files change, and scans the staged source bytes with the offline rules in `.security/semgrep.yml`. Enable `git config core.hooksPath .githooks`; never bypass a failed gate. Run `python3 .security/scan.py all` before opening or updating a PR and before publish, alongside the existing privacy/package checks. Findings, narrowly pinned exceptions, expiration dates, coverage and remediation follow-up are in [.security/FINDINGS.md](.security/FINDINGS.md). Never suppress a new finding or broaden exceptions to make a gate pass.

Cursor Cloud setup now runs `bash .cursor/install-security.sh` (Python 3.10+), installing checksum-verified Gitleaks and pinned Semgrep and running the production audit and full code scan. Include `export PATH="$HOME/.local/bin:$PATH"` in every fresh cloud shell. The Semgrep version pin lives in `.cursor/install-semgrep.sh`. Registry access is required for installation/npm audit; local code rules run offline with metrics disabled. Keep `.security/`, `.semgrepignore`, `.cursor/`, `AGENTS.md`, `.githooks/` and `.gitleaks.toml` out of npm package contents.
