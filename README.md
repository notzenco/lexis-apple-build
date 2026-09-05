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

## One-off Capture notarization

The manual Capture workflow accepts an exact private transfer commit and a
public RSA PEM for encrypted result return. It verifies a fixed signed archive
hash before Apple submission, uses existing App Store Connect credentials only
inside the runner, and requires Accepted before stapling and Gatekeeper checks.
It does not publish a release or updater feed. The standard public macos-26 job
is capped at 25 minutes, including a 15-minute notary wait; an uncertain timeout
must be inspected using its submission ID, never automatically resubmitted.

Results and diagnostics use AES-256-CBC with PBKDF2 and encrypt-then-HMAC-SHA256
with independent random keys. Both keys are RSA-OAEP-SHA256 wrapped. Verify the
HMAC over the ciphertext before decrypting. Preserve the corresponding private
RSA key outside Git until retrieval completes. Artifacts expire after one day.
Plaintext cleanup runs only after encrypted artifact upload succeeds; a hosted
runner is still ephemeral on failure, so early recipient validation is essential.
Stapled updater archives require a new updater signature before any publication.
