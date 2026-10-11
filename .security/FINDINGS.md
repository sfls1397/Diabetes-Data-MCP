# Dependency and Code Security Findings

These gates extend Gitleaks without weakening its config. Tooling-only rollout: no runtime source, product version or dependency version changes. Existing findings below are explicitly documented rather than represented as fixed. The gate accepts only their exact fingerprints; new/changed findings, expired exceptions and scanner/registry failures block commits/PRs/publishing. No broad baseline, directory waiver or inline nosemgrep suppression.

## Coverage

Offline ruleset v1 has 12 reviewed JavaScript/TypeScript and Python rules for dynamic code execution, shell-mode subprocesses, request-to-shell injection, disabled TLS, insecure hashes and unsafe deserialization/YAML. It is a high-signal starter set, not exhaustive security review or Semgrep Pro analysis. Tests and scripts are scanned; `.semgrepignore` excludes only generated output, caches and dependencies. Scan output contains rule/file/line, never source snippets.

## Dependency Findings

No production dependency advisories at rollout.


## Code Findings

- `sync/sync_from_nightscout.py:96`, `python-weak-password-hash`: Nightscout requires SHA-1(api-secret) on the API wire. This exact call implements that protocol, masks its digest in logs, or tests that behavior; it is not password storage. Keep TLS enabled and secrets outside git. Exact call fingerprint reviewed through 2027-10-11; unrelated hash calls still block.

- `sync/sync_from_nightscout.py:192`, `python-weak-password-hash`: Nightscout requires SHA-1(api-secret) on the API wire. This exact call implements that protocol, masks its digest in logs, or tests that behavior; it is not password storage. Keep TLS enabled and secrets outside git. Exact call fingerprint reviewed through 2027-10-11; unrelated hash calls still block.

- `tconnectsync/enrich_combos.py:36`, `python-weak-password-hash`: Nightscout requires SHA-1(api-secret) on the API wire. This exact call implements that protocol, masks its digest in logs, or tests that behavior; it is not password storage. Keep TLS enabled and secrets outside git. Exact call fingerprint reviewed through 2027-10-11; unrelated hash calls still block.

- `tests/sync.test.ts:22`, `javascript-weak-password-hash`: Nightscout requires SHA-1(api-secret) on the API wire. This exact call implements that protocol, masks its digest in logs, or tests that behavior; it is not password storage. Keep TLS enabled and secrets outside git. Exact call fingerprint reviewed through 2027-10-11; unrelated hash calls still block.


## Running and Reviewing

Enable `.githooks` for every clone. Install Semgrep using the pin in `.cursor/install-semgrep.sh` and Python 3.10+; Mini Codex/Claude Code share the installed hook/scanner. `python3 .security/scan.py all` runs `npm audit --omit=dev --audit-level=high --json` and `semgrep scan --config .security/semgrep.yml --error --strict --metrics off --disable-version-check --disable-nosem --json`. npm registry/network errors fail closed. Pre-commit scans index bytes and audits staged package files when those files or policy change. CI and npm prepublishOnly run the full gate. Cursor installation uses `.cursor/install-security.sh`, which also runs the full gate.

Raw npm audit may exit 1 for the documented high findings above. The wrapper prints each finding and accepts only exact, unexpired fingerprints with a reason and remediation tracking. Never extend expiry or change a fingerprint without reviewing the finding; remove entries when remediated. GitHub CI includes negative tests for new/changed high findings, outages, unsafe staged code hidden by unstaged edits, invalid rules and expired policy. Keep all scanner/agent setup files excluded from npm packages.
