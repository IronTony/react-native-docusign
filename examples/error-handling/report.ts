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
