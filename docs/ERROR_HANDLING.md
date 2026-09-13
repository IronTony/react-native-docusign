# Error handling guide for `react-native-docusign`

Every failure from `initialize`, `loginWithAccessToken`, `presentCaptiveSigning` and `presentCaptiveSigningWithUrl` rejects with a `DocuSignError`. This guide covers what that error contains, how to turn it into a message your users understand, and how to send it to Amplitude, New Relic, Sentry or any other tool so you can tell what failed in production.

The package does two things and nothing else: it builds a structured error, and it hands that error to your code. It shows no UI, ships no user-facing strings, logs nothing in production and depends on no analytics SDK. Your app decides what users see and where errors are recorded.

Every code sample under [Working examples](#working-examples) is a real file in [`examples/error-handling/`](../examples/error-handling), type-checked in CI against the real Amplitude, New Relic, Sentry and i18next packages.

## The error model

```ts
class DocuSignError extends Error {
  code: DocuSignErrorCode; // what failed
  reason: DocuSignErrorReason; // why it failed, when the package can tell
  message: string; // English, for developers, never for users
  envelopeId?: string;
  native?: {
    domain?: string; // iOS NSError domain, or the Android exception class
    code?: string; // iOS NSError code, or the Android SDK error code
    message?: string;
    underlying?: { domain?: string; code?: string; message?: string };
  };
  http?: {
    status: number;
    docusignErrorCode?: string; // DocuSign's own code from the response body
    docusignMessage?: string;
  };
  toAttributes(): DocuSignErrorAttributes; // flat attributes for analytics tools
}
```

`code` says what failed and `reason` says why. `native` and `http` carry the raw facts behind both, for developers. `underlying` is the lower-level error when one is known: `NSUnderlyingErrorKey` on iOS, the exception cause on Android, or the transport error of a request the package made itself.

### Codes

A usage code means your app called the package wrongly. Every other code is a failure at runtime.

| `code` | Kind | When | Typical cause |
| --- | --- | --- | --- |
| `not_initialized` | usage | a call before `initialize()` resolved | a missing `await`, or a call after `reset()` without initializing again |
| `not_logged_in` | usage | `presentCaptiveSigning` before `loginWithAccessToken()` resolved | presenting too early, or after `logout()` or `endSigningSession()` |
| `signing_in_progress` | usage | a present call while a ceremony is already open | a double tap, an effect firing twice, a retry while the first ceremony is still open |
| `invalid_signing_url` | usage | `signingUrl` is empty or not `https` | the backend did not return the URL, or the field was not passed |
| `presentation_failed` | usage | no screen to present from | presenting while the app is in the background or mid navigation transition |
| `initialize_failed` | runtime | the SDK could not be configured | an invalid environment or integrator key |
| `login_failed` | runtime | the SDK rejected the login | see `reason` |
| `signing_failed` | runtime | the ceremony could not open, or ended with an error | see `reason` |
| `unexpected` | runtime | anything the package did not anticipate | the original code is kept in `native.code` |

### Reasons

`reason` is set only from facts the package can verify. When no fact identifies the cause it is `unknown`, and `native` still carries everything the SDK reported. A later minor release can make an `unknown` more specific, so always handle `unknown`.

| `reason` | Set when | Who fixes it |
| --- | --- | --- |
| `usage` | the code is a usage code | the app developer |
| `network` | the error, or its underlying error, is `NSURLErrorDomain` on iOS, or `UnknownHostException`, `SocketTimeoutException` or `ConnectException` on Android | nobody, the connection was lost |
| `auth` | a DocuSign request returned HTTP 401 or 403 | the backend: the access token is expired or wrongly scoped |
| `configuration` | login failed although `/oauth/userinfo` accepted the same token | DocuSign admin (Mobile SDK enabled, app ID allowed), or on iOS the app's `AppIdentifierPrefix` |
| `recipient` | DocuSign answered `UNKNOWN_ENVELOPE_RECIPIENT` | the backend: the envelope's recipient does not match the `clientUserId`, name or email the app sends |
| `unknown` | none of the above | investigate with `native` and `http` |

The rules apply in the order of the table. A lost connection outranks an HTTP status seen earlier in the same flow, because the connection is what stopped the call.

## What the user sees

Show copy chosen by `reason`, never `error.message`. The message is developer text, like a log line. It is English, it can name SDK internals, and it can change between releases.

The package ships no user-facing strings, because it cannot know your languages, your tone, or what the user was doing. A `reason` is a stable value that does not depend on language, and your app turns it into its own translated text.

| `reason` | Suggested copy | Retry automatically |
| --- | --- | --- |
| `network` | "Your connection dropped. Check your internet and try again." | yes |
| `auth` | "Your signing session expired. Please try again." | only after fetching a fresh session |
| `configuration` | "Document signing isn't available right now. Please try again later." | no |
| `recipient` | "We couldn't open this document for you. Please contact the sender." | no |
| `usage` | "Something went wrong while opening the document. Please try again." | no, it is a bug |
| `unknown` | "Something went wrong while opening the document. Please try again." | yes |

A cancelled ceremony is not an error. The promise resolves with `status: 'cancelled'`, so show nothing.

In a component, one line picks the copy:

```ts
showToast({ title: t(DOCUSIGN_ERROR_COPY_KEY[error.reason]) });
```

`DOCUSIGN_ERROR_COPY_KEY` is typed as `Record<DocuSignErrorReason, string>`, so TypeScript flags the missing entry if a release adds a reason. See [`copy.ts`](#copyts), [`locales`](#localesenjson-and-localesitjson) and [`i18n.ts`](#i18nts) below.

## Retrying

Retry only what a retry can fix. A lost connection or an unknown SDK error may succeed on a second attempt. An expired token, an account that is not set up, a mismatched recipient or a bug in the calling code will fail again the same way, and retrying them only doubles the wait before the user sees the message.

For `auth`, fetch a new session from your backend and start over rather than retrying the same session.

Between attempts, await `endSigningSession()` so the next attempt does not race the teardown of the one that failed. See [`retry.ts`](#retryts) and [`useSigningWithErrors.ts`](#usesigningwitherrorsts).

## Sending errors to your tools

There are two places to plug in. Either catch at the call site, or register one listener at startup with `addSigningErrorListener`. The listener receives every `DocuSignError`, usage errors included, exactly once each, before the call rejects. Registering once is usually the better choice, because no call site can forget to report.

`toAttributes()` flattens the error into primitive values that every tool accepts:

```ts
{
  docusign_code: 'signing_failed',
  docusign_reason: 'network',
  docusign_envelope_id: '9f3c…',
  docusign_native_domain: 'NSURLErrorDomain',
  docusign_native_code: '-1009',
  docusign_http_status: 401, // only when an HTTP response was involved
  docusign_api_error_code: 'UNKNOWN_ENVELOPE_RECIPIENT', // only when DocuSign returned one
}
```

Keys with no value are omitted. There are no messages on purpose: every key is low-cardinality, so a dashboard can group on any of them. When you also want the message, send `error.message` yourself.

See [`report.ts`](#reportts) for Amplitude, New Relic and Sentry.

- **Amplitude:** one `docusign_failed` event per failure, with the attributes as event properties.
- **New Relic:** `recordError(error, false, attributes)` records a handled, non-fatal error. React Native agent 1.9.0 and later store it as a `MobileJSError` event with the attributes attached. Agents before 1.9.0 used `MobileHandledException`. Version 1.9.x of the agent reaches its native module at import time, so importing it in a build where the native module is not linked (Expo Go, for example) throws at startup.
- **Sentry:** `captureException` with the attributes as tags, so every issue can be filtered by reason and code.

### What is safe to send

The package redacts before an error reaches your code. JWTs, `Bearer` credentials, URL query strings and token-like URL path segments are removed from `message`, `native` and `http`. The access token and the signing URL never appear in any field. The attributes contain identifiers only.

Your app still owns redaction of its own context. If you add a user's email or name next to the error, scrub it the way you scrub the rest of your analytics.

## Reading it in production

**Amplitude.** Chart the `docusign_failed` event grouped by `docusign_reason` to see the split between connection loss, backend problems, configuration and bugs. Then filter to `docusign_reason = unknown` and group by `docusign_native_domain` and `docusign_native_code` to see which SDK errors actually happen.

**New Relic (agent 1.9.0 and later).**

```sql
SELECT count(*) FROM MobileJSError
WHERE docusign_reason IS NOT NULL
FACET docusign_reason, docusign_code
SINCE 7 days ago
```

To drill into unclassified SDK errors:

```sql
SELECT count(*) FROM MobileJSError
WHERE docusign_reason = 'unknown'
FACET docusign_native_domain, docusign_native_code
SINCE 7 days ago
```

**Reading a spike.** A rise in `auth` or `recipient` points at the backend: token minting, token lifetime, or envelope creation. A rise in `configuration` points at DocuSign admin or a recent change to the app's native configuration. A rise in `network` is usually the users' connections. A rise in `usage` after a release is a bug in that release.

## Locating a `usage` bug

`code` names the mistake, and `message` names the fix. In development, a usage error also prints one console warning, such as `[react-native-docusign] not_initialized: Call initialize() first.`. A catch that turns every error into a generic toast therefore cannot hide the bug. Production builds print nothing.

In production the stack trace ends inside the package, because the error is built after an `await`. The context your app logs next to the error is what locates the call site: the screen, the step of the flow, the attempt number.

## Worked examples

Values such as SDK codes and messages are illustrative. Field names, codes and reasons are exact.

### Forgotten `initialize()`

```ts
{ code: 'not_initialized', reason: 'usage', message: 'DocuSign SDK has not been initialized. Call initialize() first.' }
```

User reads the generic copy. The development warning points at the fix. Attributes: `{ docusign_code: 'not_initialized', docusign_reason: 'usage' }`.

### Expired access token

```ts
{
  code: 'login_failed',
  reason: 'auth',
  message: 'DocuSign rejected the access token. Mint a new token with the signature and impersonation scopes. (…)',
  http: { status: 401 },
}
```

User reads "Your signing session expired. Please try again.", and the app fetches a fresh session before trying again. Attributes include `docusign_http_status: 401`.

### Valid token, account not set up for mobile

```ts
{
  code: 'login_failed',
  reason: 'configuration',
  message: 'DocuSign rejected a valid access token. Check that AppIdentifierPrefix is set in Info.plist, that the Mobile SDK is enabled for integration key …',
  http: { status: 200 },
}
```

User reads "Document signing isn't available right now." with no retry. The fix is in DocuSign admin, or in the app's `Info.plist` on iOS.

### Recipient does not match the envelope

```ts
{
  code: 'signing_failed',
  reason: 'recipient',
  envelopeId: '9f3c…',
  http: {
    status: 400,
    docusignErrorCode: 'UNKNOWN_ENVELOPE_RECIPIENT',
    docusignMessage: 'The recipient you have identified is not a valid recipient of the specified envelope.',
  },
}
```

User reads "We couldn't open this document for you. Please contact the sender." with no retry. The backend created the envelope with a different `clientUserId`, name or email than the session sends. On Android this arrives through the `signingUrl` launch strategy, which mints the recipient view itself.

### Connection lost

```ts
{
  code: 'signing_failed',
  reason: 'network',
  envelopeId: '9f3c…',
  native: { domain: 'NSURLErrorDomain', code: '-1009', message: 'The Internet connection appears to be offline.' },
}
```

User reads "Your connection dropped. Check your internet and try again." and a retry makes sense.

### An SDK error the package cannot classify

```ts
{
  code: 'signing_failed',
  reason: 'unknown',
  envelopeId: '9f3c…',
  native: { domain: 'com.docusign.androidsdk.exceptions.DSSigningException', code: '…', message: '…' },
}
```

User reads the generic copy, and the app retries once. Group by `docusign_native_domain` and `docusign_native_code` to learn which of these occur. Once one is understood, a minor release can give it a specific reason.

## Working examples

### copy.ts

<!-- example: examples/error-handling/copy.ts -->
```ts
import type { TFunction } from 'i18next';
import type { DocuSignError, DocuSignErrorReason } from 'react-native-docusign';

/**
 * One translation key per reason. Typed as a Record so TypeScript flags the
 * gap if a later release adds a reason. Show this to users, never
 * `error.message`, which is developer text.
 */
export const DOCUSIGN_ERROR_COPY_KEY: Record<DocuSignErrorReason, string> = {
  network: 'docusign.errors.network',
  auth: 'docusign.errors.sessionExpired',
  configuration: 'docusign.errors.unavailable',
  recipient: 'docusign.errors.contactSender',
  usage: 'docusign.errors.generic',
  unknown: 'docusign.errors.generic',
};

export function docuSignErrorCopy(t: TFunction, error: DocuSignError): string {
  return t(DOCUSIGN_ERROR_COPY_KEY[error.reason]);
}

/** The same mapping for an app that ships a single language and no i18n library. */
export const DOCUSIGN_ERROR_COPY_EN: Record<DocuSignErrorReason, string> = {
  network: 'Your connection dropped. Check your internet and try again.',
  auth: 'Your signing session expired. Please try again.',
  configuration:
    "Document signing isn't available right now. Please try again later.",
  recipient:
    "We couldn't open this document for you. Please contact the sender.",
  usage: 'Something went wrong while opening the document. Please try again.',
  unknown: 'Something went wrong while opening the document. Please try again.',
};
```

### locales/en.json and locales/it.json

<!-- example: examples/error-handling/locales/en.json -->
```json
{
  "docusign": {
    "errors": {
      "network": "Your connection dropped. Check your internet and try again.",
      "sessionExpired": "Your signing session expired. Please try again.",
      "unavailable": "Document signing isn't available right now. Please try again later.",
      "contactSender": "We couldn't open this document for you. Please contact the sender.",
      "generic": "Something went wrong while opening the document. Please try again."
    }
  }
}
```

<!-- example: examples/error-handling/locales/it.json -->
```json
{
  "docusign": {
    "errors": {
      "network": "La connessione si è interrotta. Controlla la rete e riprova.",
      "sessionExpired": "La sessione di firma è scaduta. Riprova.",
      "unavailable": "La firma dei documenti non è disponibile al momento. Riprova più tardi.",
      "contactSender": "Non riusciamo ad aprire questo documento. Contatta il mittente.",
      "generic": "Si è verificato un errore durante l'apertura del documento. Riprova."
    }
  }
}
```

### i18n.ts

<!-- example: examples/error-handling/i18n.ts -->
```ts
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import it from './locales/it.json';

export const i18n = createInstance();

export async function initI18n(language: string): Promise<void> {
  await i18n.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    resources: {
      en: { translation: en },
      it: { translation: it },
    },
    interpolation: { escapeValue: false },
  });
}
```

### report.ts

<!-- example: examples/error-handling/report.ts -->
```ts
import { track } from '@amplitude/analytics-react-native';
import * as Sentry from '@sentry/react-native';
import NewRelic from 'newrelic-react-native-agent';
import {
  addSigningErrorListener,
  DocuSignError,
  DocuSignSubscription,
} from 'react-native-docusign';

/** One event per failure, grouped by `docusign_reason` in charts. */
export function reportToAmplitude(error: DocuSignError): void {
  track('docusign_failed', error.toAttributes());
}

/**
 * A handled, non-fatal error. Agent 1.9.0 and later store it as a
 * `MobileJSError` event with the attributes attached.
 */
export function reportToNewRelic(error: DocuSignError): void {
  NewRelic.recordError(error, false, error.toAttributes()).catch(
    () => undefined,
  );
}

export function reportToSentry(error: DocuSignError): void {
  Sentry.captureException(error, { tags: error.toAttributes() });
}

/**
 * Registers one listener that forwards every DocuSign failure, caller mistakes
 * included, to each tool. Call it once at startup. Each retry attempt that
 * fails is reported, because each is a real failure.
 */
export function installDocuSignErrorReporting(): DocuSignSubscription {
  return addSigningErrorListener((error) => {
    reportToAmplitude(error);
    reportToNewRelic(error);
    reportToSentry(error);
  });
}
```

Keep the adapters for the tools you use and delete the rest.

### retry.ts

<!-- example: examples/error-handling/retry.ts -->
```ts
import type { DocuSignError, DocuSignErrorReason } from 'react-native-docusign';

/**
 * Whether trying the same session again can succeed. An expired token (`auth`)
 * needs a fresh session from your backend first, so it does not retry as is.
 */
const RETRYABLE: Record<DocuSignErrorReason, boolean> = {
  network: true,
  unknown: true,
  auth: false,
  configuration: false,
  recipient: false,
  usage: false,
};

export function shouldRetry(error: DocuSignError): boolean {
  return RETRYABLE[error.reason];
}
```

### useSigningWithErrors.ts

<!-- example: examples/error-handling/useSigningWithErrors.ts -->
```ts
import {
  DocuSignConfig,
  DocuSignError,
  DocuSignSigningState,
  endSigningSession,
  SigningResult,
  SigningSession,
  useDocuSignSigning,
} from 'react-native-docusign';

import { shouldRetry } from './retry';

const MAX_ATTEMPTS = 2;

export type UseSigningWithErrorsOptions = {
  config: DocuSignConfig;
  /** Receives the final failure. Map `error.reason` to translated copy here, for example in a toast. */
  onFailure: (error: DocuSignError) => void;
};

export type UseSigningWithErrorsReturn = {
  state: DocuSignSigningState;
  sign: (session: SigningSession) => Promise<SigningResult | null>;
};

/**
 * Wraps `useDocuSignSigning` with a retry policy driven by `reason`. Logging is
 * not done here: `installDocuSignErrorReporting` already sees every failure.
 */
export function useSigningWithErrors({
  config,
  onFailure,
}: UseSigningWithErrorsOptions): UseSigningWithErrorsReturn {
  const signing = useDocuSignSigning({ config });

  const sign = async (session: SigningSession) => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await signing.startSigning(session);
      } catch (error) {
        if (!(error instanceof DocuSignError)) throw error;
        if (attempt === MAX_ATTEMPTS || !shouldRetry(error)) {
          onFailure(error);
          return null;
        }
        // Awaited, unlike the hook's reset(), so the next attempt does not race
        // the teardown of the one that failed.
        await endSigningSession();
      }
    }
    return null;
  };

  return { state: signing.state, sign };
}
```

Wiring it into a screen, with `installDocuSignErrorReporting()` already called once at startup:

```tsx
const { t } = useTranslation();
const { state, sign } = useSigningWithErrors({
  config,
  onFailure: (error) => showToast({ title: docuSignErrorCopy(t, error) }),
});
```
