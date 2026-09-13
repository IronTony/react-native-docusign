import Foundation

/// Facts about a runtime failure, sent to JS as flat keys.
///
/// JS derives the failure's `reason` from these, so native code reports what it observed and never
/// guesses. Every field is optional because each failure knows a different subset.
internal struct FailureDetails {
  var nativeDomain: String?
  var nativeCode: String?
  var nativeMessage: String?
  var underlyingDomain: String?
  var underlyingCode: String?
  var underlyingMessage: String?
  var httpStatus: Int?
  var docusignErrorCode: String?
  var docusignMessage: String?

  init() {}

  /// Reads the error's own domain and code plus `NSUnderlyingErrorKey`. The domain is kept because
  /// the SDK raises errors from several domains, so a code on its own is ambiguous.
  init(error: Error) {
    let nsError = error as NSError
    nativeDomain = nsError.domain
    nativeCode = String(nsError.code)
    nativeMessage = nsError.localizedDescription
    if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError {
      setUnderlying(underlying)
    }
  }

  /// Records a lower-level error without overwriting one the SDK already reported.
  mutating func setUnderlyingIfAbsent(_ error: Error) {
    guard underlyingDomain == nil else { return }
    setUnderlying(error as NSError)
  }

  private mutating func setUnderlying(_ error: NSError) {
    underlyingDomain = error.domain
    underlyingCode = String(error.code)
    underlyingMessage = error.localizedDescription
  }

  /// Keeps DocuSign's own error code and message from a REST or OAuth error body, which is the
  /// only place a backend problem such as a mismatched recipient is named.
  mutating func setResponse(status: Int, body: Data?) {
    httpStatus = status
    guard
      let body = body,
      let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    else { return }
    docusignErrorCode = Self.nonEmpty(json["errorCode"]) ?? Self.nonEmpty(json["error"])
    docusignMessage = Self.nonEmpty(json["message"]) ?? Self.nonEmpty(json["error_description"])
  }

  private static func nonEmpty(_ value: Any?) -> String? {
    guard let text = value as? String, !text.isEmpty else { return nil }
    return text
  }

  var payload: [String: Any] {
    let values: [String: Any?] = [
      "nativeDomain": nativeDomain,
      "nativeCode": nativeCode,
      "nativeMessage": nativeMessage,
      "underlyingDomain": underlyingDomain,
      "underlyingCode": underlyingCode,
      "underlyingMessage": underlyingMessage,
      "httpStatus": httpStatus,
      "docusignErrorCode": docusignErrorCode,
      "docusignMessage": docusignMessage
    ]
    return values.compactMapValues { $0 }
  }
}

/// A runtime failure, as opposed to a caller mistake.
///
/// Caller mistakes are thrown as coded exceptions and reject. A rejection crosses the Expo bridge
/// with only a code and a message, so runtime failures resolve with this payload instead and JS
/// turns it into a thrown `DocuSignError` with every detail intact.
internal struct DocuSignFailure: Error {
  let code: String
  let message: String
  let details: FailureDetails
  let envelopeId: String?

  init(code: String, message: String, details: FailureDetails, envelopeId: String? = nil) {
    self.code = code
    self.message = message
    self.details = details
    self.envelopeId = envelopeId
  }

  func payload(fallbackEnvelopeId: String?) -> [String: Any] {
    var payload = details.payload
    payload["errorCode"] = code
    payload["errorMessage"] = message
    if let envelopeId = envelopeId ?? fallbackEnvelopeId, !envelopeId.isEmpty {
      payload["envelopeId"] = envelopeId
    }
    return payload
  }
}
