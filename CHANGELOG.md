# Changelog

## Next

### Breaking changes

- Every failure from `initialize`, `loginWithAccessToken`, `presentCaptiveSigning` and `presentCaptiveSigningWithUrl` rejects with a `DocuSignError` on both platforms. It carries `code` (what failed), `reason` (why, set only from verifiable facts), `native` and `http` (the raw SDK error and any DocuSign response), and `toAttributes()`. Branch on `code` and `reason`, never on message text, which was rewritten to say what failed and what to check. See [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md).
- `presentCaptiveSigning` and `presentCaptiveSigningWithUrl` never resolve with `status: 'error'`. iOS used it for SDK errors reported after the signing UI was on screen, while Android rejected the same failures. Both platforms now reject, so a resolve always means completed or cancelled. `'error'` stays in `SigningStatus` so existing `switch` statements compile.
- Rejection codes are the documented lowercase codes on both platforms. iOS emitted `ERR_`-prefixed codes that Expo derived from exception class names, and Android rejected most failures as `signing_failed`. Two caller mistakes that hid inside `signing_failed` now have their own codes: `signing_in_progress` and `invalid_signing_url`. A missing presenter on iOS, or a missing foreground Activity on Android, rejects with `presentation_failed`, and an iOS initialization failure rejects with `initialize_failed`.
- `addSigningErrorListener` receives a `DocuSignError` instead of `{ errorCode, errorMessage }`, and now receives every failure from those four functions exactly once, caller mistakes included. It no longer wraps the native `onSigningError` event, which stays available on `DocuSignModule`.
- `useDocuSignSigning` types `error` as `DocuSignError | null`.
- **Android**: one native `onSigningError` event per failure instead of two.

### New features

- `DocuSignError.reason` classifies a failure as `usage`, `network`, `auth`, `configuration`, `recipient` or `unknown`, so an app can show a message that fits and skip retries that cannot succeed. A login failure is checked against `/oauth/userinfo` with the same token, which separates an expired token (`auth`) from a valid token DocuSign still refuses (`configuration`).
- `DocuSignError.toAttributes()` returns flat, primitive attributes ready for Amplitude, New Relic, Sentry or any other tool.
- Messages and details are redacted before they reach app code: JWTs, `Bearer` credentials, URL query strings and token-like URL path segments are removed. The redaction is pattern-based, so `toAttributes()`, which carries no message text, is the safest thing to forward to third-party tools.
- **Android**: `initialize` failures carry the SDK exception's details instead of a message alone, and the underlying error is the root of the exception's cause chain, where the transport failure that explains a timeout actually sits.
- In development, a caller mistake also prints one console warning naming the fix, so a catch that shows a generic toast cannot hide it.
- **Android**: the SDK's own error code, the HTTP status of an SDK REST failure, and DocuSign's error body from the recipient-view request are kept. The module previously forwarded only the exception message, and the `signingUrl` strategy discarded the error body entirely when it fell back to `fetch`.
- New [error handling guide](docs/ERROR_HANDLING.md) covering translated copy, retries, reporting to Amplitude, New Relic and Sentry, and reading the results in production. Its examples live in `examples/error-handling` and are type-checked in CI.

- **Android**: Add `presentCaptiveSigningWithUrl` support. The URL flow now has iOS/Android parity and does not require `loginWithAccessToken`.
- **Android**: Add an opt-in `launchStrategy` on `presentCaptiveSigning`. `signingUrl` mints a recipient view and launches the SDK's URL overload, skipping the envelope download that runs on a size-derived read timeout floored at 15s and can leave the ceremony unopened on large envelopes. Falls back to `fetch` if the mint fails. Defaults to `fetch`, so upgrading changes nothing unless you opt in.

### Fixes

- **iOS**: the view controller to present from is looked up on the main thread. The lookup read `UIApplication.shared` on the background queue the JS call arrived on.
- **iOS**: a missing view controller settles the promise once. It previously completed the pending signing slot with a failure and also threw, rejecting the same call twice.
- **iOS**: `endSigningSession` no longer calls `DSMManager` off the main thread. Expo dispatches a synchronous `AsyncFunction` body on a serial background queue, so `clearAllWebCookies()` and `logout()` were reached off-main on every call, including the one `useDocuSignSigning`'s `reset()` makes between flows. The guard now lives in `clearWebCookiesAsync`, the only method touching `DSMManager` and `WKWebsiteDataStore` directly, so it covers every caller. Thanks to @virajpsimformsolutions for finding and fixing this.
- **iOS**: `reset()` no longer re-enters itself to reach the main thread. The hop sat below the block that cancels an in-flight signing promise, so the re-entrant pass ran that block twice and could cancel a session that claimed the slot in between.
- **iOS**: reject a blank or non-`https` `signingUrl` before presenting. `DSMEnvelopesManager.presentCaptiveSigning` validates nothing and presents unconditionally, so a malformed URL rendered an empty signing controller whose completion never fired and left the promise unsettled. `signingUrl` defaults to `""` when JS omits it, so this was reachable without a malformed URL at all. Brings iOS to parity with the Android guard below.
- **Android**: reject a blank or non-`https` `signingUrl` before launching. The SDK's URL overload validates nothing and calls `startActivity` unconditionally, so a malformed URL opened an empty signing activity and left the promise unsettled.
- **Android**: `presentCaptiveSigning` now clears `currentEnvelopeId` when the launch itself throws, matching the URL path.

## 1.0.5

### New features

- New `reset()` API on iOS and Android. Heavier counterpart to `endSigningSession`: resolves any in-flight signing promise as cancelled, wipes WebKit data on iOS (cookies, service workers, fetch cache, IndexedDB, etc.), calls `logout()`, removes notification observers, and flips the internal `isInitialized` flag to `false` so the next `initialize()` call re-runs the underlying SDK setup against a fresh state. Use it for hard resets (error recovery, switching DocuSign accounts, app-level logout). For routine per-flow teardown on the same auth, prefer `endSigningSession`, which keeps the SDK initialized and avoids the observer churn.

## 1.0.4

### Bug fixes

- **iOS**: Fix endless "we encountered an error, retrying..." loop in the captive signing UI on the second consecutive attempt within the same install. The signing UI registers a service worker on first visit, and `WKWebsiteDataStore.removeData` was being called with an explicit type set that did not include `WKWebsiteDataTypeServiceWorkerRegistrations` or the fetch cache. The stale service worker survived cookie clearing, app force-close, and even SDK-level logout, then intercepted the next signing WebView's fetch calls with stale cached responses. `clearWebCookiesAsync` now passes `WKWebsiteDataStore.allWebsiteDataTypes()`, which wipes service workers, fetch cache, disk cache, and every other WebKit-persisted data type.
- **iOS**: Always run the WebKit teardown before `DSMManager.login`, including on the first login of a process. The previous "skip teardown when `hasLoggedIn = false`" optimization assumed a fresh process implies fresh WebKit data; that assumption is wrong because `WKWebsiteDataStore` persists across iOS process kills while the in-memory `hasLoggedIn` flag does not. After a force-close, the next login is treated as "first" by the SDK and would skip the wipe, leaving the previous session's service worker behind.

### Build / packaging

- **Android**: Switch `sdk-pdf-2.1.4-stripped` import from `flatDir`-based `implementation(name: ..., ext: 'aar')` to a direct `implementation files("$projectDir/libs/sdk-pdf-2.1.4-stripped.aar")`. Gradle 9.0 no longer honors subproject-scoped `flatDir` when resolving across project boundaries, so the stripped AAR (placed by the Config Plugin) was not being found and the build failed with `Could not find :sdk-pdf-2.1.4-stripped:`.

## 1.0.3

### Build / packaging

- **No third-party binaries shipped.** The DocuSign `sdk-pdf-2.1.4.aar` is no longer committed to the repo or included in the npm tarball. The Expo Config Plugin now downloads it directly from DocuSign's public Maven (`docucdn-a.akamaihd.net`) at `expo prebuild` time, strips the pre-generated `com.bumptech.glide.GeneratedAppGlideModuleImpl` class to prevent duplicate-class collisions with `expo-image` and other Glide-based libraries, and writes the stripped result into `node_modules/react-native-docusign/android/libs/`. The existing flatDir injection picks it up unchanged. Result: zero DocuSign IP redistributed; consumers fetch the SDK directly from DocuSign on first prebuild.
- New `dependencies` entry: `adm-zip` (used by the Config Plugin to strip the upstream AAR in-memory).
- Added `LICENSE` (MIT). Previously declared in `package.json` but the file was missing.
- `package.json` adds a `prepublishOnly` hook that runs `npm run build && npm test` so stale builds can never ship.

### Notes for consumers

- After `npm install`, run `npx expo prebuild` (or `expo prebuild --clean`) so the plugin can fetch and place the stripped sdk-pdf AAR. Required network access: `https://docucdn-a.akamaihd.net`.
- If the host machine cannot reach DocuSign's CDN, the plugin emits a warning and the Android build will fail at the dex step. CI environments must allow outbound HTTPS to that host.

## 1.0.2

### Bug fixes

- **iOS**: Fix captive signing hang on second consecutive open. The implicit teardown inside `performLogin` (logout + `clearAllWebCookies`) raced with `DSMManager.login`, leaving the WebView session bootstrapped against half-cleaned SDK state. The captive signing UI would render but the underlying `DSMEnvelopesManager` never fired its expected `settings` / `consumer_disclosure` / `recipient` requests, leaving the JS promise hanging on a spinner with no completion notification. The teardown is now sequenced via `WKWebsiteDataStore.removeData` completion before `DSMManager.login` is invoked, and skipped entirely on the first login.

### New features

- New `endSigningSession()` API on both iOS and Android. Tears down any in-flight signing session and the underlying SDK auth state so the next `loginWithAccessToken` + `presentCaptiveSigning` pair starts from a clean slate. Wired into `useDocuSignSigning`'s `reset()` automatically, so React consumers get clean teardown between captive signing flows for free.

### Tests

- Add Jest setup with `jest-expo` preset.
- Cover `useDocuSignSigning` state machine end-to-end: auto-init, session and url signing flows, completed / cancelled / error transitions, error listener subscription, error listener cleanup on unmount, and the `reset()` -> `endSigningSession` wiring.

## 1.0.1

### Documentation

- Surface the unified iOS/Android session payload contract in the README. New "One backend response, both platforms" callout names the 13 expected fields and links to the full schema in `docs/BACKEND_GUIDE.md`.

## 1.0.0

### New features

- Initial release.
- iOS native module wrapping DocuSign iOS SDK 4.1.1.
- Android native module wrapping DocuSign Android SDK 2.1.4.
- TypeScript public API: `initialize`, `loginWithAccessToken`, `presentCaptiveSigning`, `logout`, `isLoggedIn`.
- Event listeners: `onSigningComplete`, `onSigningCancelled`, `onSigningError`.
- React hook `useDocuSignSigning` wrapping the SDK lifecycle, state machine, and event subscription.
- Config plugin for automatic iOS Info.plist, Android permissions, and Maven repo setup.
