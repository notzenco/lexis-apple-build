# Lexis build orchestration

This public repository contains build and release orchestration only. The
application source remains private in `notzenco/lexis-apple`.

Every workflow is manual and accepts an exact, lowercase, 40-character source
commit. A repository-specific read-only deploy key checks out that commit with
Git credential persistence and progress output disabled. Private build,
archive, and catalog diagnostics never appear in public logs; failures produce
one-day encrypted artifacts instead.

## Workflows

- **Private source build** runs catalog validation, shared tests, and unsigned
  iPhone, Watch, iPhone-widget, and Watch-widget builds.
- **TestFlight** uses the stable Xcode 26.6 release runner, validates signing
  profiles and embedded entitlements, archives an exact source commit, and
  uploads a caller-supplied build number.
- **Catalog release** signs and publishes the stable public catalog assets
  consumed by Lexis.

Operational setup and migration order are documented in the private source
repository at `docs/private-repository-delivery.md`. Never add application
source, signing assets, decrypted diagnostics, tester data, or secret values to
this repository.
