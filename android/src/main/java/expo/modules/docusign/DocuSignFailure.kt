package expo.modules.docusign

import com.docusign.androidsdk.exceptions.DSException
import com.docusign.androidsdk.exceptions.DSRestException
import java.io.IOException
import org.json.JSONObject

/**
 * Facts about a runtime failure, sent to JS as flat keys.
 *
 * JS derives the failure's `reason` from these, so native code reports what it observed and never
 * guesses. Every field is optional because each failure knows a different subset.
 */
internal data class FailureDetails(
  val nativeDomain: String? = null,
  val nativeCode: String? = null,
  val nativeMessage: String? = null,
  val underlyingDomain: String? = null,
  val underlyingCode: String? = null,
  val underlyingMessage: String? = null,
  val httpStatus: Int? = null,
  val docusignErrorCode: String? = null,
  val docusignMessage: String? = null
) {
  /** Records a lower-level error without overwriting one the SDK already reported. */
  fun withUnderlyingIfAbsent(error: Throwable): FailureDetails {
    if (underlyingDomain != null) return this
    val root = rootCause(error) ?: error
    return copy(
      underlyingDomain = root.javaClass.name,
      underlyingCode = sdkErrorCode(root),
      underlyingMessage = root.message
    )
  }

  fun withHttp(error: DocuSignHttpException): FailureDetails =
    copy(
      httpStatus = error.status,
      docusignErrorCode = error.docusignErrorCode,
      docusignMessage = error.docusignMessage
    )

  fun toMap(): Map<String, Any> =
    listOfNotNull<Pair<String, Any>>(
      nativeDomain?.let { "nativeDomain" to it },
      nativeCode?.let { "nativeCode" to it },
      nativeMessage?.let { "nativeMessage" to it },
      underlyingDomain?.let { "underlyingDomain" to it },
      underlyingCode?.let { "underlyingCode" to it },
      underlyingMessage?.let { "underlyingMessage" to it },
      httpStatus?.let { "httpStatus" to it },
      docusignErrorCode?.let { "docusignErrorCode" to it },
      docusignMessage?.let { "docusignMessage" to it }
    ).toMap()

  companion object {
    /**
     * Reads the SDK's own error code and message where it provides them. The exception message
     * alone was all this module forwarded before, and it rarely says what failed.
     */
    fun from(error: Throwable): FailureDetails {
      val cause = rootCause(error)
      return FailureDetails(
        nativeDomain = error.javaClass.name,
        nativeCode = sdkErrorCode(error),
        nativeMessage = (error as? DSException)?.errorMsg?.takeIf { it.isNotBlank() } ?: error.message,
        underlyingDomain = cause?.javaClass?.name,
        underlyingCode = cause?.let { sdkErrorCode(it) },
        underlyingMessage = cause?.message,
        httpStatus = (error as? DSRestException)?.responseCode?.takeIf { it > 0 }
      )
    }

    private fun sdkErrorCode(error: Throwable): String? =
      (error as? DSException)?.errorCode?.takeIf { it.isNotBlank() }

    private const val MAX_CAUSE_DEPTH = 8

    /**
     * The deepest cause, bounded and safe against cycles. Java wraps transport failures, so the
     * SocketTimeoutException or UnknownHostException that explains a failure sits at the root of
     * the chain, often more than one level below the exception the SDK hands over. iOS keeps the
     * immediate underlying error instead, because the deepest error under an NSURLErrorDomain
     * failure is a CFNetwork error that the reason rules do not classify as a network failure.
     */
    private fun rootCause(error: Throwable): Throwable? {
      val seen = mutableSetOf(error)
      var current = error.cause ?: return null
      repeat(MAX_CAUSE_DEPTH) {
        seen.add(current)
        val next = current.cause
        if (next == null || next in seen) return current
        current = next
      }
      return current
    }
  }
}

/**
 * A non-2xx response to a request this package makes itself. DocuSign's error body names the real
 * problem, such as `UNKNOWN_ENVELOPE_RECIPIENT` for a recipient that does not match the envelope,
 * so it is kept rather than reduced to the status line.
 */
internal class DocuSignHttpException(
  val status: Int,
  val docusignErrorCode: String?,
  val docusignMessage: String?
) : IOException("DocuSign request failed with HTTP $status") {
  companion object {
    fun from(status: Int, body: String): DocuSignHttpException {
      val json = runCatching { JSONObject(body) }.getOrNull()
      return DocuSignHttpException(
        status = status,
        docusignErrorCode = json?.nonEmpty("errorCode") ?: json?.nonEmpty("error"),
        docusignMessage = json?.nonEmpty("message") ?: json?.nonEmpty("error_description")
      )
    }

    private fun JSONObject.nonEmpty(key: String): String? =
      if (isNull(key)) null else optString(key).takeIf { it.isNotBlank() }
  }
}

/**
 * A runtime failure, as opposed to a caller mistake.
 *
 * Caller mistakes are coded exceptions and reject. A rejection crosses the Expo bridge with only a
 * code and a message, so runtime failures resolve with this payload instead and JS turns it into a
 * thrown `DocuSignError` with every detail intact.
 */
internal class DocuSignFailure(
  val code: String,
  override val message: String,
  val details: FailureDetails,
  val envelopeId: String? = null
) : Exception(message) {
  fun toPayload(fallbackEnvelopeId: String?): Map<String, Any> {
    val payload = details.toMap().toMutableMap()
    payload["errorCode"] = code
    payload["errorMessage"] = message
    (envelopeId ?: fallbackEnvelopeId)?.takeIf { it.isNotEmpty() }?.let { payload["envelopeId"] = it }
    return payload
  }
}
