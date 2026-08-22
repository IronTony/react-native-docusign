<p align="center">
  <img src="https://raw.githubusercontent.com/IronTony/react-native-docusign/main/docs/img/banner-dark.svg" alt="react-native-docusign" />
</p>

# react-native-docusign

[![npm version](https://img.shields.io/npm/v/react-native-docusign.svg?style=flat-square)](https://www.npmjs.com/package/react-native-docusign)
[![npm downloads](https://img.shields.io/npm/dm/react-native-docusign.svg?style=flat-square)](https://www.npmjs.com/package/react-native-docusign)
[![license](https://img.shields.io/npm/l/react-native-docusign.svg?style=flat-square)](LICENSE)
[![platforms](https://img.shields.io/badge/platform-ios%20%7C%20android-blue?style=flat-square)](#)
[![types](https://img.shields.io/badge/types-TypeScript-blue?style=flat-square)](#)
[![Expo SDK](https://img.shields.io/badge/Expo%20SDK-55%2B-000020?style=flat-square&logo=expo)](https://docs.expo.dev/)

React Native / Expo native module that wraps the official DocuSign iOS and Android SDKs, allowing apps to present the native DocuSign signing UI directly in-app (captive signing).

Built on the Expo Modules API. Works with Expo SDK 55+ (managed or bare with `expo prebuild`) and Expo Dev Client. Also usable in non-Expo React Native projects after running [`npx install-expo-modules`](https://docs.expo.dev/bare/installing-expo-modules/) to install `expo-modules-core`; in that case, run `expo prebuild` so the Config Plugin can fetch the DocuSign sdk-pdf AAR and inject the iOS / Android build settings, otherwise you must replicate those steps by hand.

> **Unofficial package.** This is a community wrapper. It is not affiliated with, endorsed by, or sponsored by DocuSign, Inc. or any other organization. "DocuSign" is a trademark of DocuSign, Inc. The MIT license covers this wrapper's source code only. Consumers are responsible for accepting DocuSign's Mobile SDK License Agreement separately when integrating with DocuSign's services.

## iOS ↔ Android parity

| Flow                                                                    | iOS | Android |
|-------------------------------------------------------------------------|:---:|:-------:|
| Session flow: `initialize` → `loginWithAccessToken` → `presentCaptiveSigning` | ✅  |   ✅    |
| URL flow: `initialize` → `presentCaptiveSigningWithUrl`                 | ✅  |   ✅    |

## One backend response, both platforms

Both iOS and Android consume the **same 13-field session payload** from your backend. There is no platform-specific branching on the client. Mint it once on your BFF, hand it to the module, and the same code path runs on both OSes.

The mobile module expects exactly these fields:

`integratorKey`, `environment`, `accessToken`, `expiresIn`, `host`, `accountId`, `userId`, `userName`, `email`, `envelopeId`, `clientUserId`, `recipientName`, `recipientEmail`.

Full schema and BFF reference implementation: [`docs/BACKEND_GUIDE.md` → Session Payload Contract](docs/BACKEND_GUIDE.md#session-payload-contract).

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Platform requirements](#platform-requirements)
- [SDK bundling policy](#sdk-bundling-policy)
- [Installation](#installation)
- [Config plugin](#config-plugin)
- [Quick start](#quick-start)
- [API reference](#api-reference)
  - [initialize](#initializeconfig-docusignconfig-promisevoid)
  - [loginWithAccessToken](#loginwithaccesstokenparams-docusignauthparams-promisevoid)
  - [presentCaptiveSigning](#presentcaptivesigningparams-captivesigningparams-promisesigningresult)
  - [presentCaptiveSigningWithUrl](#presentcaptivesigningwithurlparams-captivesigningurlparams-promisesigningresult)
  - [logout](#logout-promisevoid)
  - [isLoggedIn](#isloggedin-promiseboolean)
  - [endSigningSession](#endsigningsession-promisevoid)
  - [reset](#reset-promisevoid)
  - [Event listeners](#event-listeners)
- [Types](#types)
- [Authentication flow](#authentication-flow)
- [Prefilling document fields](#prefilling-document-fields)
- [Multi-document / multi-envelope chaining](#multi-document--multi-envelope-chaining)
- [Error handling](#error-handling)
- [Security considerations](#security-considerations)
- [Permissions](#permissions)
- [Troubleshooting](#troubleshooting)
- [Compatibility matrix](#compatibility-matrix)
- [Limitations](#limitations)
- [FAQ](#faq)
- [License](#license)

## Features

- Native in-app captive (embedded) signing on iOS and Android
- Full native DocuSign signing UI, including document viewer, form fields, signature pad, initials, date picker, attachments, and dropdowns
- OAuth access token authentication (JWT Grant handled on your backend)
- Promise-based API plus event listeners for completion, cancellation, and errors
- Config plugin that automatically configures iOS Info.plist, Android permissions, and Android Maven repo
- TypeScript-first public API with strict types
- No WebView dependency, no HTML bridges, no hybrid UI

## How it works

At a high level, a signing flow looks like this:

1. Your backend creates a DocuSign envelope from a template (prefilling any known fields) and returns a short-lived access token plus envelope metadata to the mobile app.
2. The mobile app calls `initialize()` once (on app start or on-demand) to configure the DocuSign SDK.
3. The app calls `loginWithAccessToken()` with the session data from your backend.
4. The app calls `presentCaptiveSigning()`. The DocuSign SDK takes over the screen and presents its own native signing UI.
5. The user reviews the document, fills any remaining fields, and signs.
6. The SDK dismisses itself. The promise resolves (or an event fires) with the final signing status.
7. Your backend confirms the signing status via a DocuSign Connect webhook (server-side source of truth).

The React Native layer never renders any of the signing UI. It only triggers the flow, passes credentials to the SDK, and listens for completion events.

## Platform requirements

| Platform | Minimum OS           | SDK version                | Language    |
| -------- | -------------------- | -------------------------- | ----------- |
| iOS      | 15.1                 | DocuSign iOS SDK 4.1.1     | Swift 5.9   |
| Android  | API 24 (Android 7.0) | DocuSign Android SDK 2.1.4 | Kotlin 1.8+ |

**Runtime requirements:**

- Expo SDK 55 or newer, OR bare React Native 0.74+
- React Native New Architecture (Fabric + Hermes): supported, no additional configuration
- Expo Go: NOT supported (custom native modules require a development build)

## SDK bundling policy

The DocuSign native SDKs are **NOT bundled** inside this npm package. They are declared as external dependencies and resolved at consumer build time:

- **iOS**: `pod 'DocuSign-iOS-SDK', '~> 4.1.1'` from the public CocoaPods trunk
- **Android**: `com.docusign:androidsdk:2.1.4` from DocuSign's Maven repository (the config plugin adds the repo automatically)

### Android Glide collision workaround

DocuSign's `com.docusign:sdk-pdf:2.1.4` AAR ships a pre-generated `com.bumptech.glide.GeneratedAppGlideModuleImpl.class` that collides at dex time with any other Glide-based library in the host app (notably `expo-image`, `react-native-fast-image`, and similar). To avoid this without redistributing DocuSign's binary, the Expo Config Plugin downloads `sdk-pdf-2.1.4.aar` directly from DocuSign's public Maven during `expo prebuild`, verifies its SHA-256 against a pinned hash, removes the offending class from the AAR's `classes.jar` in-memory, and writes the stripped artifact to `node_modules/react-native-docusign/android/libs/`. The existing flatDir injection picks it up at consumer build time. The download is cached after the first run; corrupted or partial caches are detected and regenerated. SHA mismatch or fetch failure aborts `expo prebuild` with an actionable error rather than silently letting the Android build fail later at the dex step.

### What ships inside this package

- TypeScript source + type definitions
- Swift + Kotlin bridge source files
- Podspec and gradle config
- Config plugin compiled output
- README, CHANGELOG, LICENSE

Estimated package size: under 1 MB.

### What does NOT ship inside this package

- DocuSign iOS xcframework binaries
- DocuSign Android AAR binaries
- Any DocuSign proprietary code

### Why not bundle the SDKs

1. **Distribution model**: DocuSign publishes the SDKs via CocoaPods and their own Maven repository. Consumers' builds resolve them directly and accept DocuSign's terms at install time, the standard native dependency pattern.
2. **Size**: Keeps this npm package tiny.
3. **Updates**: Consumers can bump DocuSign SDK versions via CocoaPods / Gradle independently of this wrapper.
4. **Legal clarity**: Referencing SDK coordinates rather than shipping binaries keeps this wrapper cleanly MIT and avoids ambiguity about DocuSign's proprietary artifacts.

## Installation

### 1. Install the package

```bash
npm install react-native-docusign
# or
yarn add react-native-docusign
# or
pnpm add react-native-docusign
```

### 2. Add the config plugin

In `app.config.ts` (or `app.json`):

```ts
export default {
  expo: {
    // ...
    plugins: [
      [
        'react-native-docusign',
        {
          cameraPermission: 'Allows you to sign DocuSign documents using your camera.',
          photoPermission: 'Allows you to attach photos to DocuSign documents.',
        },
      ],
    ],
  },
};
```

### 3. Rebuild the development client

```bash
npx expo prebuild --clean
npx expo run:ios
npx expo run:android
```

### Bare React Native (without Expo prebuild)

If you are not using Expo prebuild, you must manually:

- **iOS**: add `pod 'DocuSign-iOS-SDK', '~> 4.1.1'` to your Podfile and run `pod install`
- **Android**: add the Maven repo and the DocuSign dependency to your `android/build.gradle` + `android/app/build.gradle`
- **iOS**: add the `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` keys to your `Info.plist`
- **Android**: add the required permissions to your `AndroidManifest.xml`

See the [Permissions](#permissions) section for exact values.

## Config plugin

The config plugin accepts the following props:

```ts
type DocuSignPluginProps = {
  /**
   * Value written to NSCameraUsageDescription in Info.plist.
   * Defaults to a generic DocuSign-appropriate message.
   */
  cameraPermission?: string;

  /**
   * Value written to NSPhotoLibraryUsageDescription in Info.plist.
   * Defaults to a generic DocuSign-appropriate message.
   */
  photoPermission?: string;

  /**
   * URL of the Android Maven repository that serves the DocuSign Android SDK.
   * Defaults to 'https://maven.docusign.com/'.
   * Override only if DocuSign moves their repo.
   */
  androidMavenRepo?: string;
};
```

What the plugin does during `expo prebuild`:

- **iOS**: writes `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` to `Info.plist`
- **Android**: adds `INTERNET`, `ACCESS_NETWORK_STATE`, and `CAMERA` permissions to `AndroidManifest.xml`
- **Android**: injects the DocuSign Maven repository into the project-level `build.gradle` under `allprojects { repositories { ... } }`

## Quick start

```ts
import * as DocuSign from 'react-native-docusign';

async function signAgreement() {
  // Step 1: configure the SDK (call once per app lifetime)
  await DocuSign.initialize({
    integratorKey: 'YOUR_INTEGRATOR_KEY',
    environment: 'demo', // or 'production'
  });

  // Step 2: fetch a signing session from your backend
  const session = await fetch('/api/envelopes/signing-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId: 'doc_123', requestType: 'standard' }),
  }).then((r) => r.json());

  // Step 3: authenticate the SDK
  await DocuSign.loginWithAccessToken({
    accessToken: session.accessToken,
    accountId: session.accountId,
    userId: session.userId,
    userName: session.userName,
    email: session.email,
    host: session.host, // 'https://demo.docusign.net/restapi'
  });

  // Step 4: present the native signing UI
  const result = await DocuSign.presentCaptiveSigning({
    envelopeId: session.envelopeId,
    recipientUserName: session.userName,
    recipientEmail: session.email,
    recipientClientUserId: session.recipientClientUserId,
  });

  switch (result.status) {
    case 'completed':
      console.log('Signed:', result.envelopeId);
      break;
    case 'cancelled':
      console.log('User cancelled signing');
      break;
    case 'error':
      console.error('Signing error:', result.errorMessage);
      break;
  }
}
```

## API reference

### `initialize(config: DocuSignConfig): Promise<void>`

Configures the underlying DocuSign SDK. Must be called once before any other function. Safe to call multiple times (subsequent calls are no-ops).

```ts
type DocuSignConfig = {
  integratorKey: string;
  environment: 'demo' | 'production';
};
```

**Parameters:**

- `integratorKey`: your DocuSign Integrator Key (Client ID). Can be fetched from your backend at runtime to avoid shipping it in the app bundle.
- `environment`: `'demo'` targets `demo.docusign.net` (DocuSign developer sandbox). `'production'` targets `docusign.net`.

**Throws:** rejects if the SDK cannot be initialized.

### `loginWithAccessToken(params: DocuSignAuthParams): Promise<void>`

Authenticates the SDK with a short-lived access token obtained from your backend (via DocuSign JWT Grant).

```ts
type DocuSignAuthParams = {
  accessToken: string;
  accountId: string;
  userId: string;
  userName: string;
  email: string;
  host: string;
};
```

**Parameters:**

- `accessToken`: OAuth 2.0 access token from DocuSign
- `accountId`: DocuSign account ID (GUID)
- `userId`: DocuSign user ID (GUID)
- `userName`: display name for the signer
- `email`: email address for the signer
- `host`: DocuSign API host URL (e.g. `'https://demo.docusign.net/restapi'`)

**Throws:** rejects with `login_failed` if the token is invalid, expired, or rejected by DocuSign.

**Notes:** access tokens from DocuSign are typically valid for 1 hour. Do not cache them client-side. Fetch a fresh token for each signing session.

### `presentCaptiveSigning(params: CaptiveSigningParams): Promise<SigningResult>`

Presents the native DocuSign signing UI on top of your React Native app. The returned promise resolves when the user completes or cancels signing.

```ts
type CaptiveSigningParams = {
  envelopeId: string;
  recipientUserName: string;
  recipientEmail: string;
  recipientClientUserId: string;
  launchStrategy?: 'fetch' | 'signingUrl'; // Android only, default 'fetch'
};

type SigningResult = {
  status: 'completed' | 'cancelled' | 'error';
  envelopeId: string;
  errorCode?: string;
  errorMessage?: string;
};
```

**Parameters:**

- `envelopeId`: the DocuSign envelope ID created by your backend
- `recipientUserName`, `recipientEmail`: must match the recipient registered on the envelope
- `recipientClientUserId`: the `clientUserId` of the embedded recipient, used by DocuSign to identify captive signers
- `launchStrategy`: how the Android SDK opens the ceremony, see [Android launch strategies](#android-launch-strategies). Ignored on iOS.

**Throws:** rejects with `signing_failed` if the SDK fails to present the signing UI (e.g. not initialized, not logged in, invalid envelope).

**Returns:** resolves with a `SigningResult` once the user completes or cancels. `status === 'completed'` means the user finished the signing ceremony. `status === 'cancelled'` means the user explicitly cancelled or closed the signing UI.

#### Android launch strategies

The Android SDK can open a captive signing ceremony two ways, and `launchStrategy` picks between them. It has no effect on iOS.

`'fetch'` is the default and matches every release before this option existed. The SDK downloads the envelope with `include=documents` and then opens the ceremony. That download runs on a read timeout derived from the envelope size, which floors at 15 seconds when nothing is cached, so a large envelope on a slow connection can exhaust it and the ceremony never opens.

`'signingUrl'` skips the download. The module mints a recipient view with the session access token (`POST /accounts/{accountId}/envelopes/{envelopeId}/views/recipient`) and points the SDK straight at the returned URL, so the call that times out never runs.

```ts
await presentCaptiveSigning({
  envelopeId,
  recipientUserName,
  recipientEmail,
  recipientClientUserId,
  launchStrategy: 'signingUrl',
});
```

Before opting in, check that the access token you pass to `loginWithAccessToken` is scoped to create recipient views on the envelope. If the mint fails the module falls back to `'fetch'`, so the worst case is a wasted round trip per ceremony rather than a failure, but there is no point paying for it if the token cannot mint.

If your backend already mints recipient view URLs, prefer `presentCaptiveSigningWithUrl` instead. It keeps the DocuSign access token off the device entirely, which is the better shape. `'signingUrl'` exists for teams who cannot change their backend.

### `presentCaptiveSigningWithUrl(params: CaptiveSigningUrlParams): Promise<SigningResult>`

Presents the DocuSign signing UI using a pre-minted recipient view URL (obtained server-side from `POST /envelopes/{id}/views/recipient`). Bypasses SDK authentication; `initialize` is required, but `loginWithAccessToken` is not.

```ts
type CaptiveSigningUrlParams = {
  signingUrl: string;
  envelopeId: string;
  recipientId?: string;
};
```

**Parameters:**

- `signingUrl`: short-lived recipient view URL from your backend (~5 min TTL, single use)
- `envelopeId`: the DocuSign envelope ID
- `recipientId` (optional): identifier used for event correlation

**Throws:**

- rejects if `initialize` has not been called
- `signing_failed` if the URL is expired, malformed, or rejected by DocuSign

**Returns:** same `SigningResult` shape as `presentCaptiveSigning`.

**Why this flow:** keeps the DocuSign access token out of the mobile app entirely; your backend mints the signing URL and hands that single-use credential to the client. Recommended for production iOS and Android flows.

### `logout(): Promise<void>`

Logs out of the DocuSign SDK and clears any cached credentials. Call this when the user signs out of your app.

### `isLoggedIn(): Promise<boolean>`

Returns the current login state. Useful for deciding whether to skip the login step on a subsequent signing attempt.

### `endSigningSession(): Promise<void>`

Tears down any in-flight signing session and the underlying SDK auth state so the next `loginWithAccessToken` + `presentCaptiveSigning` pair starts from a clean slate. Safe to call when no session is active.

Call this between captive signing flows (e.g. inside the `finally` block of your orchestrator) when running multiple envelopes in the same app session. Without it, the package falls back to an implicit teardown inside `performLogin` which has historically (≤ 1.0.1) raced on iOS and caused the captive signing UI to hang on a spinner on the second consecutive open. The 1.0.2 fix sequences that teardown correctly, but calling `endSigningSession` explicitly remains the cleanest pattern.

The `useDocuSignSigning` hook's `reset()` calls this automatically when the SDK has been initialized.

### `reset(): Promise<void>`

Full SDK teardown. Heavier counterpart to `endSigningSession`: resolves any in-flight signing promise as cancelled, wipes WebKit data on iOS (cookies, service workers, fetch cache, IndexedDB, etc.), calls `logout()`, removes notification observers (iOS), and flips the internal `isInitialized` flag to `false` so the next `initialize()` call re-runs the underlying SDK setup against a fresh state.

Use this when you want a hard reset between flows (error recovery, switching DocuSign accounts, after an app-level logout). For routine teardown between consecutive captive signing flows on the same auth, prefer `endSigningSession`, which keeps the SDK initialized and skips the observer churn.

Safe to call when the SDK was never initialized: returns immediately without touching the underlying SDK.

| Use case | Recommended call |
| --- | --- |
| Between captive signing flows in the same app session | `endSigningSession` |
| After an error you want to recover from | `reset` |
| Switching DocuSign accounts / integrator keys | `reset` |
| App-level logout | `reset` |

### Event listeners

In addition to the promise-based API, you can subscribe to events. Events fire for every signing result, including those triggered from other parts of your app.

```ts
const completeSub = DocuSign.addSigningCompleteListener((event) => {
  console.log('Signed envelope:', event.envelopeId);
});

const cancelSub = DocuSign.addSigningCancelledListener((event) => {
  console.log('Cancelled:', event.envelopeId, event.reason);
});

const errorSub = DocuSign.addSigningErrorListener((event) => {
  console.error('Error:', event.errorCode, event.errorMessage);
});

// Later, clean up:
completeSub.remove();
cancelSub.remove();
errorSub.remove();
```

In React hooks:

```ts
import { useEffect } from 'react';

import * as DocuSign from 'react-native-docusign';

useEffect(() => {
  const sub = DocuSign.addSigningCompleteListener((event) => {
    refetchEnvelopeStatus(event.envelopeId);
  });
  return () => sub.remove();
}, []);
```

## Hook API

For React consumers, the package exports a `useDocuSignSigning` hook that wraps the SDK lifecycle, the state machine, and event subscription so you do not have to implement them yourself.

### Usage

```tsx
import { useDocuSignSigning } from 'react-native-docusign';

function SigningScreen() {
  const { state, error, result, startSigning } = useDocuSignSigning({
    config: {
      integratorKey: 'YOUR_INTEGRATOR_KEY',
      environment: 'demo',
    },
  });

  async function handleSign() {
    // Fetch the signing session from your backend
    const session = await fetchSigningSessionFromYourBackend();

    // Hook handles loginWithAccessToken + presentCaptiveSigning + state transitions
    const result = await startSigning(session);

    if (result.status === 'completed') {
      // Navigate to confirmation
    }
  }

  return (
    <View>
      {state === 'initializing' && <Text>Setting up DocuSign...</Text>}
      {state === 'ready' && <Button title="Sign document" onPress={handleSign} />}
      {state === 'preparing' && <ActivityIndicator />}
      {state === 'signing' && <Text>Opening signing UI...</Text>}
      {state === 'completed' && <Text>Signed envelope {result?.envelopeId}</Text>}
      {state === 'cancelled' && <Text>Signing cancelled</Text>}
      {state === 'error' && <Text>Error: {error?.message}</Text>}
    </View>
  );
}
```

### What the hook does for you

- Calls `initialize()` automatically on mount (toggle with `autoInitialize: false` if you want to defer)
- Accepts both signing flows via a discriminated union on `startSigning(session)`:
  - `{ type: 'session', ... }`: runs `loginWithAccessToken` + `presentCaptiveSigning` (iOS + Android)
  - `{ type: 'url', ... }`: runs `presentCaptiveSigningWithUrl` (iOS + Android, no SDK login)
- Tracks SDK state in a finite state machine
- Subscribes to error events and surfaces them in the `error` field
- Cleans up event listeners on unmount

### URL-flow example (iOS + Android)

```tsx
const result = await startSigning({
  type: 'url',
  signingUrl: sessionFromBackend.signingUrl,
  envelopeId: sessionFromBackend.envelopeId,
});
```

### Session-flow example (iOS + Android)

```tsx
const result = await startSigning({
  type: 'session',
  accessToken: sessionFromBackend.accessToken,
  accountId: sessionFromBackend.accountId,
  userId: sessionFromBackend.userId,
  userName: sessionFromBackend.userName,
  email: sessionFromBackend.email,
  host: sessionFromBackend.host,
  envelopeId: sessionFromBackend.envelopeId,
  recipientUserName: sessionFromBackend.userName,
  recipientEmail: sessionFromBackend.email,
  recipientClientUserId: sessionFromBackend.recipientClientUserId,
});
```

### What stays YOUR responsibility

- Fetching the signing session from your backend (every consumer has a different backend)
- Form state collection (request details, addresses, dates) BEFORE calling `startSigning`
- Multi-envelope chaining UX (call `startSigning` again with a fresh session)
- Navigation between screens

### State machine

```
idle ──auto-init──> initializing ──> ready ──startSigning──> preparing ──> signing ──> completed
                                       │                                                  │
                                       │                                                  └─> cancelled
                                       │                                                  │
                                       └────────────── error <───── any failure ────────  └─> error
```

### Reference

```ts
type DocuSignSigningState =
  | 'idle' // hook just mounted, initialization not started
  | 'initializing' // initialize() in progress
  | 'ready' // SDK ready, can call startSigning
  | 'preparing' // loginWithAccessToken in progress
  | 'signing' // native signing UI is presented
  | 'completed' // user finished signing successfully
  | 'cancelled' // user cancelled signing
  | 'error'; // any failure

type SigningSessionWithAuth = DocuSignAuthParams & CaptiveSigningParams & { type: 'session' };
type SigningSessionWithUrl = CaptiveSigningUrlParams & { type: 'url' };
type SigningSession = SigningSessionWithAuth | SigningSessionWithUrl;

type UseDocuSignSigningOptions = {
  config: DocuSignConfig;
  autoInitialize?: boolean; // default true
};

type UseDocuSignSigningReturn = {
  state: DocuSignSigningState;
  error: Error | null;
  result: SigningResult | null;
  initialize: () => Promise<void>; // manual init if autoInitialize=false
  startSigning: (session: SigningSession) => Promise<SigningResult>;
  reset: () => void; // back to idle/ready, clears error and result
};
```

### When NOT to use the hook

If you need fine-grained control over the SDK lifecycle (e.g., re-using login across multiple screens, or custom error recovery flows), use the lower-level functions directly: `initialize`, `loginWithAccessToken`, `presentCaptiveSigning`. The hook is opinionated and may not fit every flow.

## Types

```ts
export type DocuSignEnvironment = 'demo' | 'production';

export type DocuSignConfig = {
  integratorKey: string;
  environment: DocuSignEnvironment;
};

export type DocuSignAuthParams = {
  accessToken: string;
  accountId: string;
  userId: string;
  userName: string;
  email: string;
  host: string;
};

export type CaptiveSigningParams = {
  envelopeId: string;
  recipientUserName: string;
  recipientEmail: string;
  recipientClientUserId: string;
};

export type SigningStatus = 'completed' | 'cancelled' | 'error';

export type SigningResult = {
  status: SigningStatus;
  envelopeId: string;
  errorCode?: string;
  errorMessage?: string;
};

export type SigningCompleteEvent = {
  envelopeId: string;
};

export type SigningCancelledEvent = {
  envelopeId: string;
  reason?: string;
};

export type SigningErrorEvent = {
  envelopeId?: string;
  errorCode: string;
  errorMessage: string;
};
```

## Authentication flow

This package does NOT implement DocuSign JWT Grant authentication. JWT Grant must happen on your backend because it requires access to an RSA private key that should never ship on mobile devices.

Recommended flow:

```
Mobile app               Your backend                 DocuSign
----------               ------------                 --------
1. Request signing --->
                         2. JWT Grant ------------->
                         3. Access token  <----------
                         4. Create envelope -------->
                         5. Envelope ID   <----------
<-- Signing session data

6. initialize()
7. loginWithAccessToken()
8. presentCaptiveSigning()
    [Native SDK UI]
9. Complete/cancel event

10. Confirm status  --->
                         11. Verify via webhook ---->
                         12. Confirmed     <---------
```

The mobile app **never stores DocuSign tokens**. Access tokens are fetched per signing session, used immediately, and discarded. Your backend must perform authorization checks before issuing a signing session for a given envelope.

For information on DocuSign JWT Grant auth on the backend, see https://developers.docusign.com/platform/auth/jwt/.

## Prefilling document fields

The SDK itself does not provide an API to prefill document fields. Prefilling happens **server-side** when the envelope is created.

When your backend calls DocuSign's REST API `POST /accounts/{accountId}/envelopes`, it should set tab values on the envelope:

- `textTabs`: text fields
- `checkboxTabs`: checkboxes
- `dateTabs`: date pickers
- `dropdownTabs` (alias `listTabs`): dropdown selections
- `signHereTabs`: signature placement (leave empty for user to sign)
- `initialHereTabs`: initial placement

When the mobile app then calls `presentCaptiveSigning()`, the user will see the document with all server-prefilled fields already populated. They only need to fill remaining fields and sign.

Example (backend, pseudo-code):

```ts
const envelope = await docusign.envelopes.create({
  templateId: 'template_agreement_v1',
  templateRoles: [
    {
      email: 'user@example.com',
      name: 'Jane Doe',
      roleName: 'signer',
      clientUserId: 'user_123',
      tabs: {
        textTabs: [
          { tabLabel: 'request_type', value: 'standard' },
          { tabLabel: 'counterparty', value: 'Acme Corp.' },
          { tabLabel: 'mailing_address', value: '123 Main St, Anytown, USA' },
        ],
        dateTabs: [{ tabLabel: 'effective_date', value: '2026-05-01' }],
      },
    },
  ],
  status: 'sent',
});
```

## Multi-document / multi-envelope chaining

Because the DocuSign SDK returns control to your app after each signing ceremony, you can chain multiple signings in sequence.

### Minimal example

```ts
async function signMultipleDocuments(documents: Document[]) {
  const results: SigningResult[] = [];

  for (const document of documents) {
    const session = await fetchSigningSession(document.id);
    await DocuSign.loginWithAccessToken(session);
    const result = await DocuSign.presentCaptiveSigning({
      envelopeId: session.envelopeId,
      recipientUserName: session.userName,
      recipientEmail: session.email,
      recipientClientUserId: session.recipientClientUserId,
    });
    results.push(result);

    if (result.status !== 'completed') break;
  }

  return results;
}
```

### Production-grade example with `endSigningSession`

Between signing ceremonies on the same app session, call [`endSigningSession`](#endsigningsession-promisevoid) so the next `loginWithAccessToken` + `presentCaptiveSigning` pair starts from a clean SDK state. This avoids the iOS WebKit race that caused captive signing to hang on the second consecutive open in versions ≤ 1.0.1. Always run it in a `finally` block so it executes on cancel and error paths too.

```ts
async function signMultipleDocumentsSafe(documents: Document[]) {
  const results: SigningResult[] = [];

  for (const document of documents) {
    const session = await fetchSigningSession(document.id);

    try {
      await DocuSign.loginWithAccessToken(session);
      const result = await DocuSign.presentCaptiveSigning({
        envelopeId: session.envelopeId,
        recipientUserName: session.userName,
        recipientEmail: session.email,
        recipientClientUserId: session.recipientClientUserId,
      });
      results.push(result);

      if (result.status !== 'completed') break;
    } finally {
      await DocuSign.endSigningSession();
    }
  }

  return results;
}
```

Between signings, you can also show a confirmation prompt ("sign another document?") and only continue if the user agrees.

## Error handling

The module rejects promises with coded exceptions you can inspect at the call site:

| Error code          | When                                          | Mitigation                                                     |
| ------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| `initialize_failed` | SDK failed to configure                       | Check integrator key and network connectivity                  |
| `login_failed`      | Access token rejected, or Keychain misconfigured (iOS) | Fetch a fresh token from your backend; on iOS also verify `AppIdentifierPrefix` is set in `Info.plist` (see [Permissions](#permissions)) |
| `signing_failed`    | SDK failed to present or complete signing     | Check envelope ID, recipient info, SDK login state             |
| `not_initialized`   | `initialize()` was not called first           | Call `initialize()` before any other method                    |
| `not_logged_in`     | `loginWithAccessToken()` was not called first | Call `loginWithAccessToken()` before `presentCaptiveSigning()` |

Example:

```ts
try {
  await DocuSign.presentCaptiveSigning(params);
} catch (error) {
  if (error.code === 'not_logged_in') {
    const session = await refreshSession();
    await DocuSign.loginWithAccessToken(session);
    // retry
  } else {
    reportError(error);
  }
}
```

## Security considerations

1. **Never log access tokens.** If you use LogRocket, Sentry, Datadog, or any other session recording tool, add the signing session endpoint and any DocuSign token fields to your network scrub list.
2. **Never store DocuSign tokens on the device.** Fetch per session, use immediately, discard.
3. **Backend authorization.** Your backend MUST verify that the requesting user has permission to sign the envelope before returning a signing session.
4. **Integrator key exposure.** The integrator key is technically a public client ID (not a secret), but you may prefer to fetch it from your backend at runtime instead of hardcoding it in the app bundle, to make revocation easier.
5. **Token scope.** When minting access tokens via JWT Grant, request only the `signature` scope. Do not request broader scopes (`impersonation`, etc.) unless strictly necessary.
6. **HTTPS only.** The DocuSign SDK uses HTTPS with SSL pinning. Do not disable SSL pinning in production.

## Permissions

### iOS `Info.plist`

The config plugin writes these keys automatically, or you can configure them manually:

| Key                              | Purpose                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `NSCameraUsageDescription`       | Required when users capture signatures or attach photos via camera                           |
| `NSPhotoLibraryUsageDescription` | Required when users attach photos from the photo library                                     |
| `AppIdentifierPrefix`            | **Required.** Enables the DocuSign iOS SDK to store auth tokens in the Apple Keychain. Without this key, `loginWithAccessToken` fails with `login_failed / unauthorized` even when the token is valid. Set to `$(AppIdentifierPrefix)`; Xcode resolves this to your team ID prefix at build time. |

### Android `AndroidManifest.xml`

| Permission                                | Purpose                         |
| ----------------------------------------- | ------------------------------- |
| `android.permission.INTERNET`             | DocuSign API calls              |
| `android.permission.ACCESS_NETWORK_STATE` | DocuSign SDK network monitoring |
| `android.permission.CAMERA`               | Signature and photo capture     |

## Troubleshooting

### iOS build fails with "No such module 'DocuSignSDK'"

Ensure `pod install` completed successfully inside `ios/`. The podspec declares a dependency on `DocuSign-iOS-SDK`; if CocoaPods trunk is unreachable, the pod cannot be installed. Check your network, proxy, and CocoaPods version (`pod --version` should be 1.14+).

### iOS build fails with "Undefined symbols" for DSMManager

The DocuSign SDK must be set to `use_frameworks!` mode. Most Expo projects use frameworks by default. If you recently switched to static libraries, add `use_frameworks! :linkage => :static` to your Podfile and rebuild.

### Android build fails with "Could not find com.docusign:androidsdk:2.1.4"

The DocuSign Android SDK is not on Maven Central; it is hosted on DocuSign's own Maven repository. Ensure the config plugin has added the repo to your project-level `build.gradle`. If running a bare project, manually add:

```groovy
allprojects {
  repositories {
    maven { url "https://maven.docusign.com/" }
  }
}
```

### "not_logged_in" error when calling `presentCaptiveSigning`

The SDK login state is in-memory and does not survive app restarts. Always call `loginWithAccessToken()` before `presentCaptiveSigning()` within the same app session.

### Access token expired mid-signing

DocuSign access tokens are valid for about 1 hour. If a token expires while the signing UI is open, the SDK emits an error event and the promise rejects. Catch the error, fetch a fresh session from your backend, and retry.

### `login_failed` on iOS even with a valid token

If `loginWithAccessToken` rejects with `login_failed` (or the SDK logs "unauthorized") but the same token works on Android, the most likely cause is a missing `AppIdentifierPrefix` entry in your `Info.plist`.

The DocuSign iOS SDK uses the Apple Keychain to store auth state. Without `AppIdentifierPrefix`, it cannot access the Keychain group and rejects the login at the SDK level, regardless of token validity.

**Fix:** add this entry to your `Info.plist` (or to `ios.infoPlist` in `app.config.ts` for Expo projects):

```xml
<key>AppIdentifierPrefix</key>
<string>$(AppIdentifierPrefix)</string>
```

Xcode resolves `$(AppIdentifierPrefix)` to your Apple Developer team ID prefix at build time. A native rebuild (`expo prebuild` + `expo run:ios`) is required after adding the key.

### Signing UI does not appear on iOS

The SDK presents its UI on the topmost view controller. If you are presenting from within a modal, the module walks the presented view controller chain. If signing still does not appear, call `presentCaptiveSigning()` after any existing modals have been dismissed.

### Signing UI does not appear on Android

The module uses `appContext.activityProvider.currentActivity` to get the current activity. Ensure `presentCaptiveSigning()` is called while the app is in the foreground.

## Compatibility matrix

| This package version | Expo SDK | React Native | iOS SDK            | Android SDK            |
| -------------------- | -------- | ------------ | ------------------ | ---------------------- |
| 1.0.x                | 55.x     | 0.82.x       | DocuSign iOS 4.1.1 | DocuSign Android 2.1.4 |

## Limitations

- **Offline signing not exposed.** DocuSign's Android SDK supports offline signing via `com.docusign:sdk-offline-signing`. This package does not currently expose offline APIs. If you need offline signing, open an issue or send a pull request.
- **Template management not exposed.** The SDK's template caching and download APIs are not wrapped. Template creation should happen server-side via the DocuSign REST API.
- **Custom UI not supported.** The signing UI is provided by the DocuSign SDK and cannot be customized from this package. DocuSign owns the look and feel of the signing ceremony (this is intentional for legal compliance consistency).
- **No partial save.** If the user fills some fields and then cancels, those values are NOT persisted. DocuSign signing is all-or-nothing: the document is either signed completely or not at all.
- **No web support.** This package is iOS and Android only. For web, use DocuSign's JavaScript SDK directly.

## FAQ

### Can I use this with Expo Go?

No. Expo Go does not support custom native modules. You must use a development build (`expo-dev-client`) or bare React Native.

### Does this support SSO / SAML authentication?

Not directly. SSO should be handled on your backend. Exchange the SSO session for a DocuSign access token via JWT Grant, then pass the access token to `loginWithAccessToken()`.

### Can I call `presentCaptiveSigning()` without logging in first?

No. You must call `initialize()` then `loginWithAccessToken()` before `presentCaptiveSigning()`. This is a DocuSign SDK constraint, not a limitation of this wrapper.

### Can I retrieve the signed PDF from the SDK?

Not directly. After signing completes, use the DocuSign REST API from your backend to download the completed envelope PDF (`GET /accounts/{accountId}/envelopes/{envelopeId}/documents/combined`).

### How do I test signing without a real DocuSign account?

Create a free DocuSign developer account at https://developers.docusign.com. It gives you access to the `demo.docusign.net` sandbox, which you can target by setting `environment: 'demo'` in `initialize()`.

### How do I handle signing completion server-side?

Configure a DocuSign Connect webhook that points to your backend. DocuSign will push envelope status updates (sent, delivered, completed, declined, voided) as they happen. Use the webhook as your source of truth and treat the mobile-side `SigningResult` as a UX signal only.

### How much does the DocuSign SDK add to my app bundle?

This npm package itself is under 1 MB (TypeScript + native bridge sources only, see [SDK bundling policy](#sdk-bundling-policy)). The size impact comes from the upstream DocuSign native SDKs that consumers pull from CocoaPods (iOS) and DocuSign's Maven repo (Android) at consumer build time. They add tens of MB per platform: full PDF viewer, signature pad, form renderer, and offline sync engine. Measure your own delta by running `du -sh` on your release IPA / APK before and after adding the dependency.

### Can I ship this alongside `react-native-pdf` or another PDF viewer?

Yes. The DocuSign SDK's internal PDF viewer only renders inside the signing ceremony. It does not conflict with other PDF viewers.

### Is this package maintained?

Yes, actively. See [CHANGELOG.md](./CHANGELOG.md) for release history.

## License

MIT. See [LICENSE](./LICENSE).

This package is not affiliated with or endorsed by DocuSign, Inc. "DocuSign" is a trademark of DocuSign, Inc. The DocuSign native SDKs are distributed separately under their own license terms.
