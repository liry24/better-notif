# Repository guide

- Use the repository's local tooling and the package manager pinned by `packageManager`; do not change global tools.
- Read package manifests and the lockfile for tool versions, dependencies, runtime requirements, and Better Auth compatibility. Use `package.json` scripts and `.github/workflows` as the sources for check and release commands.
- Keep one server-only `sendNotification` API for all recipient counts. Never give it an HTTP route.
- Use Better Auth's adapter and plugin schema. Database uniqueness, not an in-process lock, owns delivery idempotency.
- Notify hooks only after successful writes. Duplicate sends and no-op state changes do not replay hooks. Hook errors cannot undo persisted state.
- Scope every recipient HTTP read/write to the session user. Do not persist recipient context or expose account/session credentials.
- Keep client runtime imports separate from server code. In-flight responses from a previous user must not restore their data.
- Tests use real SQLite. Consumer tests install a tarball in a fresh project; release tests must exercise `NOTIFICATION_TARBALL` without rebuilding or changing its hash.
- Use public `testUtils` for ordinary fixtures. Retain real signup coverage where relevant and enable Origin/CSRF checks explicitly in test auth configurations.
- Isolate consumer installation caches and verify installed files against the archive so concurrent checkouts cannot substitute another package.
- Run `vp run check` before pushing. `ci-ok` directly requires all blocking jobs and accepts only success.
- Preserve SHA-pinned Actions, minimal permissions, CodeQL, and the release gate that tests the exact archive to be published. Let the release workflow manage versions; tags, releases, merges, and publication require authorization.
- SQLite is the tested database. Do not claim support for other databases or compatibility ranges without corresponding integration and packed-consumer coverage.
- Markdown is excluded from `vp fmt`; maintain code snippets with two-space indentation.
