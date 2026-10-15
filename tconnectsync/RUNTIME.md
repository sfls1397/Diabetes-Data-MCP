# Reviewed Python runtime

The installer prepares a private, immutable environment and switches the `venv`
symlink only after installation, `pip check`, an OSV advisory check of the exact
installed graph, and the combo-bolus self-test pass. Existing data, cached login
state and schedules remain outside that environment. A failed candidate leaves
the preceding symlink untouched. The first migration preserves the original
venv directory under `runtime/legacy-venv-*`; to roll back that first migration,
stop the scheduled job, remove the new symlink and move that directory back to
`venv` so its absolute interpreter paths work again. Later rollback switches the
symlink to the previous immutable environment before restarting the job.

`runtime-profile.json` pins CPython 3.13.16 from the official Astral
python-build-standalone release by URL and SHA-256. It replaces the macOS system
Python 3.9 environment without changing the system interpreter. The alternate
interpreter environment variable is for CI and must report the exact same
Python version. All ordinary dependencies are pinned with PyPI artifact hashes
in `requirements.lock`.

Upstream tconnectsync 3.0.3 is still the latest release and pins PyJWT 2.8.0.
`prepare-wheel.py` verifies its official wheel checksum, changes only that one
dependency requirement to PyJWT 2.15.1 and regenerates wheel RECORD hashes.
Application files are unchanged. `pip check` therefore validates the repaired
metadata rather than ignoring a dependency conflict. The existing combo hook
still targets exactly tconnectsync 3.0.3. Offline tests exercise its actual
Tandem JWT verification with valid tokens and invalid signature/issuer/expiry
cases, without logging in or uploading pump data.

The wrapper suppresses the upstream authentication module's token/claim dumps
and converts its warnings/errors to generic signals. Unhandled sync exceptions
remain nonzero without printing raw authentication response bodies or tracebacks.

Full/staged repository gates and the installer audit this graph against OSV.
Any known advisory, outage, malformed response or partial result blocks the
gate. Only public dependency names and versions are submitted; no credentials,
source, configuration or clinical data are sent. The parent npm release waits
for the reusable Python runtime CI job as well as Nightscout tests.
