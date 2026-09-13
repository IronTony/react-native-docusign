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
                "status" to "success",
                "account" to mapOf(
                  "accountId" to info.accountId,
                  "userId" to info.userId,
                  "userName" to info.userName,
                  "email" to info.email
                )
              )
            )
          },
          onFailure = { error -> settleFailure(error, null, promise) }
        )
      }
    }

    AsyncFunction("presentCaptiveSigning") { params: CaptiveSigningRecord, promise: Promise ->
      val activity: Activity = appContext.activityProvider?.currentActivity
        ?: throw PresentationException("no foreground Activity to present from")

      DocuSignManager.presentCaptiveSigning(
        activity = activity,
        envelopeId = params.envelopeId,
        recipientUserName = params.recipientUserName,
        recipientEmail = params.recipientEmail,
        recipientClientUserId = params.recipientClientUserId,
        launchStrategy = CaptiveSigningLaunchStrategy.fromString(params.launchStrategy)
      ) { result ->
        result.fold(
          onSuccess = { outcome -> promise.resolve(outcome.toPayload()) },
          onFailure = { error -> settleFailure(error, params.envelopeId, promise) }
        )
      }
    }

    AsyncFunction("presentCaptiveSigningWithUrl") { params: CaptiveSigningUrlRecord, promise: Promise ->
      val activity: Activity = appContext.activityProvider?.currentActivity
        ?: throw PresentationException("no foreground Activity to present from")

      DocuSignManager.presentCaptiveSigningWithUrl(
        activity = activity,
        signingUrl = params.signingUrl,
        envelopeId = params.envelopeId,
        recipientId = params.recipientId.takeIf { it.isNotEmpty() }
      ) { result ->
        result.fold(
          onSuccess = { outcome -> promise.resolve(outcome.toPayload()) },
          onFailure = { error -> settleFailure(error, params.envelopeId, promise) }
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
   * The one place a failure is settled.
   *
   * A runtime failure resolves with its details, because a rejection reaches JS with only a code
   * and a message and would drop them. A caller mistake rejects with its own code.
   */
  private fun settleFailure(error: Throwable, envelopeId: String?, promise: Promise) {
    when (error) {
      is DocuSignFailure -> {
        val payload = error.toPayload(envelopeId)
        sendEvent("onSigningError", payload)
        promise.resolve(payload + ("status" to "error"))
      }
      is CodedException -> promise.reject(error.code, error.message ?: "Unknown error", error)
      else -> promise.reject("unexpected", error.message ?: "Unknown error", error)
    }
  }

  internal fun emitSigningComplete(envelopeId: String) {
    sendEvent("onSigningComplete", mapOf("envelopeId" to envelopeId))
  }

  internal fun emitSigningCancelled(envelopeId: String, reason: String?) {
    sendEvent("onSigningCancelled", mapOf("envelopeId" to envelopeId, "reason" to reason))
  }
}
