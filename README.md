# Lexis build orchestration

This public repository contains build and release orchestration only. The
application source remains private in `notzenco/lexis-apple`.

Every workflow is manual. Source-consuming Lexis workflows accept an exact,
lowercase, 40-character source commit; a repository-specific read-only deploy
key checks it out with Git credential persistence and progress output disabled.
Availability recovery takes an existing build number instead and fetches no
private source. Private build, archive, and catalog diagnostics never appear in
public logs; failures produce one-day encrypted artifacts instead.

## Workflows

- **Private source build** runs catalog validation, shared tests, and unsigned
  iPhone, Watch, iPhone-widget, and Watch-widget builds on the Xcode 27 runner.
- **TestFlight** uses the stable Xcode 26.6 release runner, validates signing
  profiles and embedded entitlements, archives an exact source commit, and
  checks the caller-supplied build number against every existing upload, then
  uploads it. It waits for Apple processing, publishes the supplied public test
  notes, and verifies that the existing internal Personal Testing group has
  access and the build is in beta testing. A processing timeout requires
  inspecting the existing upload before retrying; it is not a failed upload.
  App Store Connect API requests use the existing encrypted workflow key and
  never print credentials, tester identities, or raw provider diagnostics.
- **TestFlight availability** resumes processing, test notes, and internal
  group verification for an existing upload without archiving or uploading
  another build. Use it after an uncertain processing or assignment result.
- **Catalog release** signs and publishes the stable public catalog assets
  consumed by Lexis.

| Workflow file | Required inputs | Completion evidence |
| --- | --- | --- |
| `build.yml` | `source_sha` | Exact-source validation, shared tests, four unsigned builds |
| `catalog-release.yml` | `source_sha` | Signed stable catalog assets and downloaded-byte verification |
| `testflight.yml` | `source_sha`, `build_number`, `what_to_test` | Archive/upload plus processing, internal access, beta state, and notes readback |
| `testflight-availability.yml` | `build_number`, `what_to_test` | Existing upload's processing, internal access, beta state, and notes readback |

## Upload recovery

An accepted upload and a fully verified beta are separate results. If upload
succeeds but processing, metadata, or group verification fails, retain the build
number and original upload receipt. Run **TestFlight availability** for that
existing number and public notes; it neither archives nor uploads another build.
Do not rerun the successful upload. Both TestFlight workflows share one
concurrency group and use the existing encrypted App Store Connect API key.

The input `what_to_test` maps to Apple's beta-localization API field `whatsNew`.
The helper waits for processing `VALID`, confirms the existing internal
**Personal Testing** group has access, checks `IN_BETA_TESTING`, and reads back
notes. It does not create groups, invite testers, enable a public link, assign
an external group, or submit an App Store release. A timeout leaves the existing
upload for inspection. Public notes must contain no private diagnostics or data.

Seven Node tests cover the release helper's pagination, internal-group checks,
metadata/readback, processing failures, JWT/origin rules, and sanitized errors:

```bash
node --test tools/testflight-distribution.test.mjs
```

## Latest recorded Lexis beta — 11 October 2026

Version `1.0.0 (33)` is processed and verified for internal Personal Testing.
The [upload run](https://github.com/notzenco/lexis-apple-build/actions/runs/38151384536)
accepted its archive but failed the initial metadata step. The successful
[availability recovery](https://github.com/notzenco/lexis-apple-build/actions/runs/38152345768)
verified the existing upload without a second upload. The
[catalog run](https://github.com/notzenco/lexis-apple-build/actions/runs/38151382099)
published revision 8. These receipts establish release availability, not
installation or physical-device widget acceptance.

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
