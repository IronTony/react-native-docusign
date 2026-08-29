import ExpoModulesCore

// Codes are given explicitly rather than inferred. Expo derives a code from the class name when
// none is set, which would surface NotInitializedException to JS as ERR_NOT_INITIALIZED, not the
// not_initialized documented in the README error table and emitted by the Android module.

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

internal class SigningFailedException: GenericException<String> {
  override var code: String {
    "signing_failed"
  }

  override var reason: String {
    "DocuSign signing failed: \(param)"
  }
}

internal class LoginFailedException: GenericException<String> {
  override var code: String {
    "login_failed"
  }

  override var reason: String {
    "DocuSign login failed: \(param)"
  }
}
