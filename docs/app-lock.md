# App Lock (App Password)

Settings → Security → **App Password** (`manage-app-lock.html`, logic in `www/applock.js` + `www/manage-app-lock.js`). Locks the app behind a PIN, pattern, or alphanumeric password shown on every app reopen.

## Threat model — read this before relying on it

This deters **casual snooping** (someone picking up your unlocked phone), not a determined attacker. The lock gates the **UI**. On Android, the main `state.items`/`state.preferences`/watch-history state is separately encrypted with an Android Keystore key; browser-only auxiliary keys remain in `localStorage`, and portable `.tar`/`.json` exports remain readable unless the encrypted backup option is used.

## Methods

Set in **Settings → Security → App Password**, one of:

| Method | Rule | Notes |
|---|---|---|
| `none` (default) | — | No lock; app opens directly |
| `pin` | 4+ digits | Any length ≥ 4, not a fixed 4/6-digit box like typical phone PINs |
| `pattern` | 2+ connected dots on a 3×3 grid | Deliberately **no** minimum-4 requirement like stock Android unlock patterns — 2 dots is enough to count as a pattern |
| `alphanumeric` | 4+ characters, any combination | Plain text password field |

Choosing **None** takes effect immediately (no confirmation step). Choosing any other method requires completing the secret entry *and* the 3 security questions before Save is enabled — see below.

## Hashing

Every secret (the lock password itself, and each of the 3 security-question answers) is hashed with **PBKDF2-SHA256, 100,000 iterations**, each with its own random 16-byte salt (`hashSecret()`/`randomSaltHex()` in `applock.js`). Nothing is ever stored in plain text. A pattern is hashed by first serializing its cell-index sequence into a string (`serializePattern()`, e.g. `"0-4-8"`) and hashing that like any other secret.

Security-question answers are normalized (`.trim().toLowerCase()`) before hashing, so trivial capitalization/whitespace differences between setup and recovery don't cause a false "wrong answer."

This relies on `crypto.subtle`, which requires a secure context. Capacitor's Android WebView serves content over a secure-context scheme by default, so this works on-device; it will **not** work if you open the app's HTML files directly via `file://` in a desktop browser for testing — `crypto.subtle` is `undefined` there and setup/verification will throw.

## Where the lock is enforced

Every page (`www/*.html`) loads `applock.js` before `metadata.js`/`app.js`. In `app.js`'s `DOMContentLoaded` handler, `guardAppLock()` runs immediately after `loadData()` and before anything else:

- If `state.preferences.appLock.method !== "none"` **and** the current session hasn't been unlocked yet (`sessionStorage.cuemark_lock_unlocked !== "true"`), the rest of that page's init is deferred and a full-screen lock overlay (`#app-lock-overlay`, z-index 500 — above every other modal) is shown instead.
- On a correct entry, `markSessionUnlocked()` sets that session flag, the overlay is removed, and a custom `app-unlocked` event fires so the page's deferred init (`runAppInit()`) resumes.

Using `sessionStorage` (not `localStorage`) for the unlocked flag is deliberate: it must reset whenever the app process is actually killed and reopened, not just when navigating between pages within one open session.

## Rate limiting and recovery

Failed attempts are tracked in `localStorage.cuemark_lock_failed_attempts` (survives app restarts, unlike the session-scoped unlock flag). At **5 failed attempts**, a "Forgot password?" button appears on the lock screen.

There is **no hard lockout** — retrying the password itself is never blocked by a timer. On a fully client-side app with no server, a real lockout would just be a self-inflicted denial-of-service for a user who mistyped and has no other device; the failed-attempt count only exists to gate when the recovery option appears.

**Recovery flow**: tapping "Forgot password?" shows the 3 security questions (or a "No Recovery Available" message if none were ever set — this can happen if `securityQuestions` is empty, which shouldn't occur through the normal setup UI since it's required, but is possible via a hand-edited backup). If all 3 answers verify correctly (`verifySecurityAnswers()`), the user is taken straight to a "Set a New Password" screen — no old-password confirmation required — and the failed-attempt counter resets.

## Data shape

See [db-schema.md](db-schema.md) for the full `state.preferences.appLock` structure. Summary: `method`, `passwordHash` + `passwordSalt` (hex), and `securityQuestions: [{question, answerHash, answerSalt}]` (exactly 3 once any method other than `none` is set).

## Backup/export exposure

`buildBackupPayload()` includes the entire `state.preferences` object — including `appLock` — whenever a backup is exported **with preferences included** (the export flow asks "restore settings too?" and the equivalent applies on export). This means a `.tar`/`.json` backup file carries the password/security-answer **hashes and salts**, not plaintext secrets, but a leaked backup could still be brute-forced offline against a weak PIN/pattern. `appLock` is **not** written to the `cuemark-db/settings/metadata-sources.json` mirror — only `metadataSources` goes there (see [file-schema.md](file-schema.md)).

## What's not built

- No encryption of `state.items`/`state.preferences` at rest — see the threat model note above.
- No biometric (fingerprint/face) unlock option — only PIN/pattern/alphanumeric.
- No per-action re-lock (e.g. requiring the password again just to view Backups & Restore) — unlocking once unlocks the whole session until the app is fully killed.
