package expo.modules.docusign

import expo.modules.kotlin.exception.CodedException

// Codes are given explicitly rather than inferred. CodedException derives a code from the class
// name when none is provided, which would surface NotInitializedException to JS as
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

class LoginFailedException(message: String) : CodedException(
  "login_failed",
  "DocuSign login failed: $message",
  null
)

class SigningFailedException(message: String) : CodedException(
  "signing_failed",
  "DocuSign signing failed: $message",
  null
)

class PresentationException(message: String) : CodedException(
  "presentation_failed",
  "Failed to present DocuSign signing UI: $message",
  null
)
