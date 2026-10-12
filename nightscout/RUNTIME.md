# Nightscout runtime profile

The Diabetes pipeline installs upstream Nightscout v15.0.8 at commit
`92d0834219aa771b5837dbcbf1baeb839a200cf6`. Its AGPL-3.0 source remains
available in the managed runtime checkout. `runtime-profile/` contains the
reviewed dependency manifest, integrity lock and upstream patch-target hashes.
`prepare-runtime.mjs` checks the exact commit and original source bytes before
applying the small source replacements in `compat/`.

The date-range API uses bounded brace-expansion instead of vulnerable braces.
APNs uses apns2 token authentication instead of node-forge-backed certificate
parsing; Nightscout's Loop sender already uses token authentication only.
Payloads and production/sandbox routing are preserved. Regression tests run
without sending any actual notification or remote therapy command.
Axios 0.34.0 preserves the legacy cookie-jar interface; nightscout-connect uses
Axios 1.20.0. Existing BRIDGE credentials are migrated by upstream v15.0.8 to
nightscout-connect's Dexcom Share reader. Only one live instance polls Share.

The parent dependency gate audits this separate production dependency graph in
full and staged scans. CI builds and runs the upstream suite on an isolated
Mongo database; the npm release waits for that job. Production audits have no
high/critical exceptions. Lower-severity upstream advisories remain visible;
development-only lint/watch dependencies are pruned from the installed runtime.

`install-runtime.sh` builds a new directory identified by the profile hash,
audits it, prunes development dependencies, and switches the managed symlink
only after success. Existing runtime directories remain for rollback. Restore
the preceding symlink and restart the server if a cutover smoke check fails.
Keep credentials in Keychain and configuration/data owner-only. MongoDB,
tconnectsync, SQLite synchronization and MCP keep their existing data stores
and schedules; this repair does not migrate or delete clinical records.

To change upstream, update the commit, source hashes, dependency profile and
tests together. Never bypass a source mismatch or audit failure, and never
silently reuse an older installed dependency tree.

The v15.0.8 Dexcom connector previously logged validated credential configuration and diagnostic session/request objects. Its exact installed source hashes are checked before a module-local console replacement suppresses verbose dumps and emits only generic warning/error signals. The patch is idempotent and reapplied after production pruning; the application console remains available.
