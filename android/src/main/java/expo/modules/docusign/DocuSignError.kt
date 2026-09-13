package expo.modules.docusign

import expo.modules.kotlin.exception.CodedException

// Caller mistakes only. Runtime failures travel as DocuSignFailure so their details survive the
// bridge. Codes are given explicitly rather than inferred: CodedException derives a code from the
// class name when none is provided, which would surface NotInitializedException to JS as
// ERR_NOT_INITIALIZED, not the not_initialized documented in the README error table.

class NotInitializedException : CodedException(
  "not_initialized",
  "DocuSign SDK has not been initialized. Call initialize() first.",
  null
)

class NotLoggedInException : CodedException(
  "not_logged_in",
  "DocuSign SDK is not logged in. Call loginWithAccessToken() first.",
  null
)

class SigningInProgressException : CodedException(
  "signing_in_progress",
  "A signing session is already in progress. Wait for it to finish or call endSigningSession() first.",
  null
)

class InvalidSigningUrlException : CodedException(
  "invalid_signing_url",
  "signingUrl must be a non-empty https URL.",
  null
)

class PresentationException(message: String) : CodedException(
  "presentation_failed",
  "Failed to present DocuSign signing UI: $message",
  null
)
