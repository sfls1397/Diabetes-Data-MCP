# Application privacy and security review

Reviewed during the October 12, 2026 Path 2 Entrypoint B Codex standardization. Base commit: e3ad222b697d96f2c528688dfcf6511ce7b19a78. Candidate changes are described below; this document alone does not claim they are deployed.

Bearer authentication, read-only SQL, sync credential handling and redaction, Keychain writer, wrapper scripts and private archive creation reviewed. SHA-1 use is the existing Nightscout wire protocol, not password storage; exact reviewed exceptions are retained. Parent npm production audit passes, but the active separate Nightscout 15.0.7 runtime has 27 high and 3 critical dependency entries. Latest upstream and compatible repair probes remain insufficient for clean runtime signoff. No glucose-data or pump mutation probe was run.

Scope: tracked source and scripts, raw Git metadata and full-history patch scans, production dependency manifests, actual package file inventory, local authentication boundaries, credential/logging paths, local data permissions, and separately managed runtime components where present. Scanner PASS is a limited set of checks, not a guarantee against all vulnerabilities. This was not an external penetration test or exhaustive formal verification. Live personal content was not copied into this repository, PRs or Notion.

Evidence: repository dependency/code gates and their negative enforcement tests; local build and relevant application tests; disposable Keychain create/update/escaping/large-session readbacks with cleanup; local HTTP authorization probes; ShellCheck and macOS Clang where applicable. Reviewed historical public automation identities remain exact; prospective commits require GitHub noreply.

## Nightscout runtime repair

The runtime installer now prepares exact upstream v15.0.8 commit 92d0834219aa771b5837dbcbf1baeb839a200cf6 with a checked-in dependency manifest and integrity lock. SHA-256 checks reject changed upstream patch targets. A profile hash selects a separate runtime directory; failed preparation leaves the existing symlink intact. Production dependency audits run on the profile in full/staged gates and on the actual install before activation. Release publication requires the upstream runtime build/test job.

Updated vulnerable compatible dependencies, including Axios 0.34.0 for legacy cookie-jar clients and 1.20.0 for nightscout-connect. Replaced runtime braces with bounded brace-expansion 5.0.12; date/range behavior and malicious depth/size tests pass. Replaced the node-forge-backed APNs package with the token-only apns2 client through a small adapter; the upstream Loop path already uses token auth exclusively. Payloads, production/sandbox routing, masked errors and connection cleanup have offline regression tests. No real remote bolus, remote override or notification was sent for testing. D3's patched color dependency builds and passes upstream report tests.

The candidate production audit has zero high/critical entries, with lower-severity upstream advisories still reported. Development-only braces remains in upstream lint/watch tooling; it is removed from the runtime by production pruning. No new audit or code exception was added. This review covers the Nightscout repair, not an assertion that every separately installed Python or database component is vulnerability-free.

The v15.0.8 Dexcom connector previously logged validated credential configuration and diagnostic session/request objects. Its exact installed source hashes are checked before a module-local console replacement suppresses verbose dumps and emits only generic warning/error signals. The patch is idempotent and reapplied after production pruning; the application console remains available.
