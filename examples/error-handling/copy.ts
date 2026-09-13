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
