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
