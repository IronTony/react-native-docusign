package expo.modules.docusign

import android.app.Activity
import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

internal class DocuSignInitConfig : Record {
  @Field
  var integratorKey: String = ""

  @Field
  var environment: String = "demo"
}

internal class DocuSignAuthRecord : Record {
  @Field
  var accessToken: String = ""

  @Field
  var accountId: String = ""

  @Field
  var userId: String = ""

  @Field
  var userName: String = ""

  @Field
  var email: String = ""

  @Field
  var host: String = ""

  @Field
  var expiresIn: Int = 3600
}

internal class CaptiveSigningRecord : Record {
  @Field
  var envelopeId: String = ""

  @Field
  var recipientUserName: String = ""

  @Field
  var recipientEmail: String = ""

  @Field
  var recipientClientUserId: String = ""

  @Field
  var launchStrategy: String = "fetch"
}

internal class CaptiveSigningUrlRecord : Record {
  @Field
  var signingUrl: String = ""

  @Field
  var envelopeId: String = ""

  @Field
  var recipientId: String = ""
}

class DocuSignModule : Module() {
  override fun definition() = ModuleDefinition {
    val context: Context = appContext.reactContext ?: throw Exceptions.ReactContextLost()

    Name("DocuSign")

    Events("onSigningComplete", "onSigningCancelled", "onSigningError")

    OnCreate {
      DocuSignManager.setModule(this@DocuSignModule)
    }

    AsyncFunction("initialize") { config: DocuSignInitConfig, promise: Promise ->
      try {
        val environment = DocuSignEnvironment.fromString(config.environment)
        DocuSignManager.initialize(context, config.integratorKey, environment)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("initialize_failed", e.message ?: "Unknown error", e)
      }
    }

    AsyncFunction("loginWithAccessToken") { params: DocuSignAuthRecord, promise: Promise ->
      DocuSignManager.loginWithAccessToken(
        accessToken = params.accessToken,
        accountId = params.accountId,
        userId = params.userId,
        userName = params.userName,
        email = params.email,
        host = params.host,
        expiresIn = params.expiresIn
      ) { result ->
        result.fold(
          onSuccess = { info ->
            promise.resolve(
              mapOf(
                "accountId" to info.accountId,
                "userId" to info.userId,
                "userName" to info.userName,
                "email" to info.email
              )
            )
          },
          onFailure = { error ->
            emitSigningError(null, "login_failed", error.message ?: "Unknown error")
            promise.reject("login_failed", error.message ?: "Unknown error", error as? Exception)
          }
        )
      }
    }

    AsyncFunction("presentCaptiveSigning") { params: CaptiveSigningRecord, promise: Promise ->
      val activity: Activity = appContext.activityProvider?.currentActivity
        ?: throw Exceptions.MissingActivity()

      DocuSignManager.presentCaptiveSigning(
        activity = activity,
        envelopeId = params.envelopeId,
        recipientUserName = params.recipientUserName,
        recipientEmail = params.recipientEmail,
        recipientClientUserId = params.recipientClientUserId,
        launchStrategy = CaptiveSigningLaunchStrategy.fromString(params.launchStrategy)
      ) { result ->
        result.fold(
          onSuccess = { outcome ->
            promise.resolve(
              mapOf(
                "status" to outcome.status,
                "envelopeId" to outcome.envelopeId,
                "errorCode" to outcome.errorCode,
                "errorMessage" to outcome.errorMessage
              )
            )
          },
          onFailure = { error ->
            // No emitSigningError here. handleSigningError already emits, so emitting again
            // delivered two events per failure and flattened recipient_signing_failed into
            // signing_failed. Failures that never reach the manager (not initialized, not logged
            // in) are programming errors and reject without an event, matching iOS.
            promise.reject(codeOf(error), error.message ?: "Unknown error", error as? Exception)
          }
        )
      }
    }

    AsyncFunction("presentCaptiveSigningWithUrl") { params: CaptiveSigningUrlRecord, promise: Promise ->
      val activity: Activity = appContext.activityProvider?.currentActivity
        ?: throw Exceptions.MissingActivity()

      DocuSignManager.presentCaptiveSigningWithUrl(
        activity = activity,
        signingUrl = params.signingUrl,
        envelopeId = params.envelopeId,
        recipientId = params.recipientId.takeIf { it.isNotEmpty() }
      ) { result ->
        result.fold(
          onSuccess = { outcome ->
            promise.resolve(
              mapOf(
                "status" to outcome.status,
                "envelopeId" to outcome.envelopeId,
                "errorCode" to outcome.errorCode,
                "errorMessage" to outcome.errorMessage
              )
            )
          },
          onFailure = { error ->
            promise.reject(codeOf(error), error.message ?: "Unknown error", error as? Exception)
          }
        )
      }
    }

    AsyncFunction("logout") { promise: Promise ->
      DocuSignManager.logout()
      promise.resolve(null)
    }

    AsyncFunction("isLoggedIn") { promise: Promise ->
      promise.resolve(DocuSignManager.isLoggedIn())
    }

    AsyncFunction("endSigningSession") { promise: Promise ->
      DocuSignManager.endSigningSession()
      promise.resolve(null)
    }

    AsyncFunction("reset") { promise: Promise ->
      DocuSignManager.reset()
      promise.resolve(null)
    }
  }

  /**
   * The rejection code for a manager failure. Every exception this module raises is a
   * CodedException carrying an explicit code, so callers can tell not_initialized from
   * not_logged_in from signing_failed instead of receiving signing_failed for all three.
   */
  private fun codeOf(error: Throwable): String =
    (error as? CodedException)?.code ?: "signing_failed"

  internal fun emitSigningComplete(envelopeId: String) {
    sendEvent("onSigningComplete", mapOf("envelopeId" to envelopeId))
  }

  internal fun emitSigningCancelled(envelopeId: String, reason: String?) {
    sendEvent("onSigningCancelled", mapOf("envelopeId" to envelopeId, "reason" to reason))
  }

  internal fun emitSigningError(envelopeId: String?, errorCode: String, errorMessage: String) {
    sendEvent(
      "onSigningError",
      mapOf(
        "envelopeId" to envelopeId,
        "errorCode" to errorCode,
        "errorMessage" to errorMessage
      )
    )
  }
}
