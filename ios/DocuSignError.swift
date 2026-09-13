import ExpoModulesCore

// Caller mistakes only. Runtime failures travel as DocuSignFailure so their details survive the
// bridge. Codes are given explicitly rather than inferred: Expo derives a code from the class name
// when none is set, which would surface NotInitializedException to JS as ERR_NOT_INITIALIZED, not
// the not_initialized documented in the README error table and emitted by the Android module.

internal class InitializeFailedException: GenericException<String> {
  override var code: String {
    "initialize_failed"
  }

  override var reason: String {
    "DocuSign SDK could not be initialized: \(param)"
  }
}

internal class SigningInProgressException: Exception {
  override var code: String {
    "signing_in_progress"
  }

  override var reason: String {
    "A signing session is already in progress. Wait for it to finish or call endSigningSession() first."
  }
}

internal class InvalidSigningUrlException: Exception {
  override var code: String {
    "invalid_signing_url"
  }

  override var reason: String {
    "signingUrl must be a non-empty https URL."
  }
}

internal class NotInitializedException: Exception {
  override var code: String {
    "not_initialized"
  }

  override var reason: String {
    "DocuSign SDK has not been initialized. Call initialize() first."
  }
}

internal class NotLoggedInException: Exception {
  override var code: String {
    "not_logged_in"
  }

  override var reason: String {
    "DocuSign SDK is not logged in. Call loginWithAccessToken() first."
  }
}

internal class PresentationException: GenericException<String> {
  override var code: String {
    "presentation_failed"
  }

  override var reason: String {
    "Failed to present DocuSign signing UI: \(param)"
  }
}
