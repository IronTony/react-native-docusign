# Changelog

## 2.0.0

Upgrading from 1.x: every rejection code is now the lowercase code the README documents, on both platforms. iOS previously emitted `ERR_`-prefixed variants and Android rejected most failures as `signing_failed`. If you branch on `error.code`, check those branches. Nothing else requires a change, and the new Android `launchStrategy` is opt-in.

### Breaking changes

- **Android**: rejection codes now reflect the failure. `presentCaptiveSigning` and `presentCaptiveSigningWithUrl` previously rejected every error as `signing_failed`; they now surface `not_initialized`, `not_logged_in`, `login_failed` or `signing_failed`, matching the codes the error table has always documented. Callers matching on `error.code === 'signing_failed'` to detect a missing `initialize()` or `loginWithAccessToken()` need to match the specific code instead.
- **iOS**: rejection codes now match the documented table and the Android module. Expo derives a code from the exception class name when none is set, so `not_initialized` reached JS as `ERR_NOT_INITIALIZED`, `signing_failed` as `ERR_SIGNING_FAILED`, and so on for every code the README has always listed. Callers matching on the `ERR_`-prefixed variants need to match the documented code instead.
- **iOS**: `presentCaptiveSigning` and `presentCaptiveSigningWithUrl` forward the failure's own code rather than rejecting everything as `signing_failed`. A failure to find a presenting view controller now rejects and emits `presentation_failed`. The rejection message is the underlying error text on its own, where it previously carried a `DocuSign signing failed:` prefix.
- **Android**: one `onSigningError` event per failure instead of two. The module emitted an event alongside the manager's own, which also flattened `recipient_signing_failed` into `signing_failed`. Listeners that deduplicated by hand can drop that workaround; listeners that counted events will see the count halve.

### New features

- **Android**: Add `presentCaptiveSigningWithUrl` support. The URL flow now has iOS/Android parity and does not require `loginWithAccessToken`.
- **Android**: Add an opt-in `launchStrategy` on `presentCaptiveSigning`. `signingUrl` mints a recipient view and launches the SDK's URL overload, skipping the envelope download that runs on a size-derived read timeout floored at 15s and can leave the ceremony unopened on large envelopes. Falls back to `fetch` if the mint fails. Defaults to `fetch`, so upgrading changes nothing unless you opt in.

### Fixes

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
