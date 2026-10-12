# Application privacy and security review

Reviewed during the October 12, 2026 Path 2 Entrypoint B Codex standardization. Base commit: e3ad222b697d96f2c528688dfcf6511ce7b19a78. Candidate changes are described below; this document alone does not claim they are deployed.

Bearer authentication, read-only SQL, sync credential handling and redaction, Keychain writer, wrapper scripts and private archive creation reviewed. SHA-1 use is the existing Nightscout wire protocol, not password storage; exact reviewed exceptions are retained. Parent npm production audit passes, but the active separate Nightscout 15.0.7 runtime has 27 high and 3 critical dependency entries. Latest upstream and compatible repair probes remain insufficient for clean runtime signoff. No glucose-data or pump mutation probe was run.

Scope: tracked source and scripts, raw Git metadata and full-history patch scans, production dependency manifests, actual package file inventory, local authentication boundaries, credential/logging paths, local data permissions, and separately managed runtime components where present. Scanner PASS is a limited set of checks, not a guarantee against all vulnerabilities. This was not an external penetration test or exhaustive formal verification. Live personal content was not copied into this repository, PRs or Notion.

Evidence: repository dependency/code gates and their negative enforcement tests; local build and relevant application tests; disposable Keychain create/update/escaping/large-session readbacks with cleanup; local HTTP authorization probes; ShellCheck and macOS Clang where applicable. Reviewed historical public automation identities remain exact; prospective commits require GitHub noreply.
