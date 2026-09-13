import {
  CaptiveSigningParams,
  CaptiveSigningUrlParams,
  DocuSignAccountInfo,
  DocuSignAuthParams,
  DocuSignConfig,
  LoginAttemptEvent,
  SigningCancelledEvent,
  SigningCompleteEvent,
  SigningResult,
} from './DocuSign.types';
import {
  DocuSignError,
  fromFailurePayload,
  toDocuSignError,
} from './DocuSignError';
import DocuSignModule, { NativeSigningOutcome } from './DocuSignModule';

export type DocuSignSubscription = {
  remove(): void;
};

export type DocuSignErrorListener = (error: DocuSignError) => void;

const errorListeners = new Set<DocuSignErrorListener>();

/**
 * Every failure passes through here exactly once before it is thrown, so a
 * listener sees the same errors a `catch` does, caller mistakes included.
 */
function report(error: DocuSignError): DocuSignError {
  if (__DEV__ && error.reason === 'usage') {
    console.warn(`[react-native-docusign] ${error.code}: ${error.message}`);
  }
  errorListeners.forEach((listener) => {
    try {
      listener(error);
    } catch (listenerError) {
      // A broken logging callback must not replace the signing failure the
      // caller is about to receive.
      if (__DEV__) {
        console.error(
          '[react-native-docusign] error listener threw',
          listenerError,
        );
      }
    }
  });
  return error;
}

async function callNative<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (nativeRejection) {
    throw report(toDocuSignError(nativeRejection));
  }
}

function settleSigningOutcome(outcome: NativeSigningOutcome): SigningResult {
  if (outcome.status === 'error') {
    throw report(fromFailurePayload(outcome));
  }
  return {
    status: outcome.status,
    envelopeId: outcome.envelopeId,
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
  };
}

/**
 * Configures the underlying DocuSign SDK. Rejects with a `DocuSignError`.
 */
export function initialize(config: DocuSignConfig): Promise<void> {
  return callNative(() => DocuSignModule.initialize(config));
}

/**
 * Logs the SDK in with an access token. Rejects with a `DocuSignError` whose
 * `reason` tells an expired token (`auth`) from a DocuSign account that is not
 * set up for the mobile SDK (`configuration`).
 */
export async function loginWithAccessToken(
  params: DocuSignAuthParams,
): Promise<DocuSignAccountInfo> {
  const outcome = await callNative(() =>
    DocuSignModule.loginWithAccessToken(params),
  );
  if (outcome.status === 'error') {
    throw report(fromFailurePayload(outcome));
  }
  return outcome.account;
}

/**
 * Presents captive signing. Resolves with `completed` or `cancelled`, and
 * rejects with a `DocuSignError` for every failure.
 */
export async function presentCaptiveSigning(
  params: CaptiveSigningParams,
): Promise<SigningResult> {
  return settleSigningOutcome(
    await callNative(() => DocuSignModule.presentCaptiveSigning(params)),
  );
}

/**
 * Present captive signing from a pre-minted DocuSign recipient-view URL.
 *
 * Does NOT require a prior {@link loginWithAccessToken} call. The URL itself
 * encodes recipient identity via a short-lived token. {@link initialize} is
 * still required.
 *
 * Supported on iOS and Android. Resolves with `completed` or `cancelled`, and
 * rejects with a `DocuSignError` for every failure.
 */
export async function presentCaptiveSigningWithUrl(
  params: CaptiveSigningUrlParams,
): Promise<SigningResult> {
  return settleSigningOutcome(
    await callNative(() => DocuSignModule.presentCaptiveSigningWithUrl(params)),
  );
}

export function logout(): Promise<void> {
  return DocuSignModule.logout();
}

export function isLoggedIn(): Promise<boolean> {
  return DocuSignModule.isLoggedIn();
}

/**
 * Tears down any in-flight signing session and the underlying DocuSign SDK
 * auth state. Call this between captive signing flows so the next
 * `loginWithAccessToken` + `presentCaptiveSigning` pair starts from a clean
 * slate. Safe to call when no session is active.
 *
 * Fixes an iOS captive signing hang that occurred on the second open within
 * a session: the SDK's implicit teardown raced with `DSMManager.login`,
 * leaving the WebView stuck on a spinner. The `useDocuSignSigning` hook
 * calls this from `reset()` automatically.
 */
export function endSigningSession(): Promise<void> {
  return DocuSignModule.endSigningSession();
}

/**
 * Full SDK teardown. Resolves any in-flight signing promise as cancelled,
 * wipes WebKit data (iOS), calls `logout()`, removes notification observers
 * (iOS), and flips the internal `isInitialized` flag to `false` so the next
 * `initialize()` call re-runs the underlying SDK setup against a fresh state.
 *
 * Use this when you want a hard reset between flows (error recovery,
 * switching DocuSign accounts, after an app-level logout). For routine
 * teardown between consecutive captive signing flows on the same auth,
 * prefer {@link endSigningSession} which keeps the SDK initialized and
 * skips the observer churn.
 *
 * Safe to call when the SDK was never initialized: returns immediately.
 */
export function reset(): Promise<void> {
  return DocuSignModule.reset();
}

export function addSigningCompleteListener(
  listener: (event: SigningCompleteEvent) => void,
): DocuSignSubscription {
  return DocuSignModule.addListener('onSigningComplete', listener);
}

export function addSigningCancelledListener(
  listener: (event: SigningCancelledEvent) => void,
): DocuSignSubscription {
  return DocuSignModule.addListener('onSigningCancelled', listener);
}

/**
 * Receives every `DocuSignError` raised by `initialize`, `loginWithAccessToken`,
 * `presentCaptiveSigning` and `presentCaptiveSigningWithUrl`, caller mistakes
 * included, once each and before the call rejects. Register it once at startup
 * to send failures to your analytics or error reporting tool.
 */
export function addSigningErrorListener(
  listener: DocuSignErrorListener,
): DocuSignSubscription {
  errorListeners.add(listener);
  return {
    remove: () => {
      errorListeners.delete(listener);
    },
  };
}

export function addLoginAttemptListener(
  listener: (event: LoginAttemptEvent) => void,
): DocuSignSubscription {
  return DocuSignModule.addListener('onLoginAttempt', listener);
}
