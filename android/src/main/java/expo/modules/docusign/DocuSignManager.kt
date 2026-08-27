package expo.modules.docusign

import android.app.Activity
import android.content.Context
import com.docusign.androidsdk.DSEnvironment
import com.docusign.androidsdk.DocuSign
import com.docusign.androidsdk.dsmodels.DSUser
import com.docusign.androidsdk.exceptions.DSAuthenticationException
import com.docusign.androidsdk.exceptions.DSSigningException
import com.docusign.androidsdk.listeners.DSAuthenticationListener
import com.docusign.androidsdk.listeners.DSCaptiveSigningListener
import com.docusign.androidsdk.listeners.DSLogoutListener
import com.docusign.androidsdk.util.DSMode
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.json.JSONObject

internal enum class DocuSignEnvironment(val value: String) {
  DEMO("demo"),
  PRODUCTION("production");

  companion object {
    fun fromString(value: String): DocuSignEnvironment =
      values().firstOrNull { it.value == value } ?: DEMO
  }
}

internal enum class CaptiveSigningLaunchStrategy(val value: String) {
  FETCH("fetch"),
  SIGNING_URL("signingUrl");

  companion object {
    fun fromString(value: String): CaptiveSigningLaunchStrategy =
      values().firstOrNull { it.value == value }
        ?: FETCH.also {
          if (value.isNotEmpty()) {
            android.util.Log.w("DocuSign", "unknown launchStrategy '$value', falling back to fetch")
          }
        }
  }
}

/** Credentials the signing-URL strategy needs to mint a recipient view. */
internal data class DocuSignSession(
  val accessToken: String,
  val accountId: String,
  val host: String
)

/**
 * Normalises a DocuSign `host` into a REST API root.
 *
 * Consumers pass whatever their backend hands them, and the three shapes seen in the wild all have
 * to reach the same place:
 *
 *   https://demo.docusign.net                 -> https://demo.docusign.net/restapi/v2.1
 *   https://demo.docusign.net/restapi         -> https://demo.docusign.net/restapi/v2.1
 *   https://demo.docusign.net/restapi/v2.1    -> unchanged, an explicit version wins
 *
 * Pulled out of the request builder so the branching is readable and can be exercised on its own.
 * Ordering is load-bearing: the versioned check has to come first, or an already-versioned host
 * would fall through and get a second `/restapi/v2.1` appended.
 */
internal fun restApiRoot(host: String): String {
  val base = host.trimEnd('/')
  return when {
    Regex("/restapi/v[0-9.]+$", RegexOption.IGNORE_CASE).containsMatchIn(base) -> base
    base.endsWith("/restapi", ignoreCase = true) -> "$base/v2.1"
    else -> "$base/restapi/v2.1"
  }
}

internal data class SigningOutcome(
  val status: String,
  val envelopeId: String,
  val errorCode: String? = null,
  val errorMessage: String? = null
)

internal data class DocuSignAccountInfo(
  val accountId: String,
  val userId: String,
  val userName: String,
  val email: String
)

internal object DocuSignManager {
  @Volatile private var isInitialized = false
  @Volatile private var hasLoggedIn = false
  @Volatile private var module: DocuSignModule? = null
  @Volatile private var appContext: Context? = null
  @Volatile private var integratorKey: String = ""
  @Volatile private var environment: DocuSignEnvironment = DocuSignEnvironment.DEMO
  @Volatile private var currentEnvelopeId: String? = null
  // One reference, not three fields: a login racing an in-flight mint would otherwise tear the
  // triple and build a request with one session's token and another's account id.
  @Volatile private var session: DocuSignSession? = null
  private val pendingCompletion = AtomicReference<((Result<SigningOutcome>) -> Unit)?>(null)

  private enum class UserInfoProbe { OK, UNAUTHORIZED, NETWORK }

  fun setModule(module: DocuSignModule) {
    this.module = module
  }

  fun initialize(
    context: Context,
    integratorKey: String,
    environment: DocuSignEnvironment
  ) {
    if (isInitialized) {
      return
    }

    val dsEnvironment = when (environment) {
      DocuSignEnvironment.DEMO -> DSEnvironment.DEMO_ENVIRONMENT
      DocuSignEnvironment.PRODUCTION -> DSEnvironment.PRODUCTION_ENVIRONMENT
    }

    val mode = if (BuildConfig.DEBUG) DSMode.DEBUG else DSMode.PRODUCTION
    DocuSign.init(context.applicationContext, integratorKey, "", "", mode)
      .setEnvironment(dsEnvironment)

    appContext = context.applicationContext
    this.integratorKey = integratorKey
    this.environment = environment
    isInitialized = true
  }

  fun loginWithAccessToken(
    accessToken: String,
    accountId: String,
    userId: String,
    userName: String,
    email: String,
    host: String,
    expiresIn: Int,
    completion: (Result<DocuSignAccountInfo>) -> Unit
  ) {
    val ctx = appContext
    if (!isInitialized || ctx == null) {
      completion(Result.failure(NotInitializedException()))
      return
    }

    session = DocuSignSession(accessToken = accessToken, accountId = accountId, host = host)

    try {
      DocuSign.getInstance().getAuthenticationDelegate().login(
        accessToken,
        null,
        expiresIn,
        ctx,
        object : DSAuthenticationListener {
          override fun onSuccess(user: DSUser) {
            hasLoggedIn = true
            val info = DocuSignAccountInfo(
              accountId = user.accountId.ifEmpty { accountId },
              userId = user.userId.ifEmpty { userId },
              userName = (user.name ?: "").ifEmpty { userName },
              email = user.email.ifEmpty { email }
            )
            completion(Result.success(info))
          }

          override fun onError(exception: DSAuthenticationException) {
            val sdkMsg = exception.message ?: "Unknown error"
            classifyLoginFailure(accessToken, sdkMsg) { enrichedMsg ->
              completion(Result.failure(LoginFailedException(enrichedMsg)))
            }
          }
        }
      )
    } catch (e: Exception) {
      completion(Result.failure(LoginFailedException(e.message ?: "Unknown error")))
    }
  }

  private fun classifyLoginFailure(
    accessToken: String,
    sdkMsg: String,
    completion: (String) -> Unit
  ) {
    probeUserInfoStatus(accessToken) { probe ->
      val diagnostic = "integratorKey=$integratorKey environment=${environment.value}"
      val enriched = when (probe) {
        UserInfoProbe.OK ->
          "SDK rejected a valid token. Likely causes: Mobile SDK not enabled for integration key $integratorKey, or Android package name not whitelisted in DocuSign admin. Contact DocuSign support. (SDK: $sdkMsg) | $diagnostic"
        UserInfoProbe.UNAUTHORIZED ->
          "Access token rejected by DocuSign /oauth/userinfo. Re-mint via JWT Bearer Grant with scope=signature impersonation. (SDK: $sdkMsg) | $diagnostic"
        UserInfoProbe.NETWORK ->
          "$sdkMsg | $diagnostic"
      }
      completion(enriched)
    }
  }

  private fun probeUserInfoStatus(accessToken: String, completion: (UserInfoProbe) -> Unit) {
    val base = when (environment) {
      DocuSignEnvironment.DEMO -> "https://account-d.docusign.com"
      DocuSignEnvironment.PRODUCTION -> "https://account.docusign.com"
    }
    thread(start = true, isDaemon = true) {
      var connection: HttpURLConnection? = null
      val result = try {
        connection = (URL("$base/oauth/userinfo").openConnection() as HttpURLConnection).apply {
          requestMethod = "GET"
          connectTimeout = 10_000
          readTimeout = 10_000
          setRequestProperty("Authorization", "Bearer $accessToken")
          setRequestProperty("Accept", "application/json")
        }
        when (val code = connection.responseCode) {
          in 200..299 -> UserInfoProbe.OK
          401, 403 -> UserInfoProbe.UNAUTHORIZED
          else -> {
            android.util.Log.w("DocuSign", "userinfo probe HTTP $code")
            UserInfoProbe.NETWORK
          }
        }
      } catch (e: Exception) {
        android.util.Log.w("DocuSign", "userinfo probe error: ${e.message}")
        UserInfoProbe.NETWORK
      } finally {
        connection?.disconnect()
      }
      completion(result)
    }
  }

  fun logout() {
    val ctx = appContext
    if (!isInitialized || ctx == null) return
    hasLoggedIn = false
    // The signing-URL strategy holds these between login and present, which is longer than this
    // object retained a token for before. Drop them on the way out so a signed-out process is not
    // sitting on a bearer token; the next login repopulates them.
    session = null
    try {
      DocuSign.getInstance().getAuthenticationDelegate().logout(
        ctx,
        true,
        object : DSLogoutListener {
          override fun onSuccess() {}
          override fun onError(exception: DSAuthenticationException) {}
        }
      )
    } catch (_: Exception) {
    }
  }

  fun isLoggedIn(): Boolean = hasLoggedIn

  /**
   * Tears down any in-flight signing session and the underlying SDK auth
   * state so the next `loginWithAccessToken` + `presentCaptiveSigning` pair
   * starts from a clean slate. Safe to call when no session is active.
   *
   * iOS parity: see `DocuSignManager.endSigningSession` in
   * ios/DocuSignManager.swift. The hang this guards against is iOS-only,
   * but exposing the method on both platforms keeps the JS surface
   * symmetric.
   */
  fun endSigningSession() {
    val envelopeId = currentEnvelopeId ?: ""
    currentEnvelopeId = null
    pendingCompletion.getAndSet(null)?.invoke(
      Result.success(
        SigningOutcome(
          status = "cancelled",
          envelopeId = envelopeId,
          errorMessage = "session_ended"
        )
      )
    )
    logout()
  }

  /**
   * Full SDK teardown. Resolves any in-flight signing promise as cancelled,
   * calls `logout()`, and flips `isInitialized` back to `false` so the next
   * `initialize()` call runs `DocuSign.init(...)` against a fresh state.
   *
   * Use this when you want a hard reset between flows (error recovery,
   * switching DocuSign accounts, app-level logout). For routine teardown
   * between consecutive captive signing flows on the same auth, prefer
   * `endSigningSession`.
   *
   * Safe to call when the SDK was never initialized.
   */
  fun reset() {
    val envelopeId = currentEnvelopeId ?: ""
    currentEnvelopeId = null
    pendingCompletion.getAndSet(null)?.invoke(
      Result.success(
        SigningOutcome(
          status = "cancelled",
          envelopeId = envelopeId,
          errorMessage = "reset"
        )
      )
    )
    logout()
    isInitialized = false
  }

  fun presentCaptiveSigning(
    activity: Activity,
    envelopeId: String,
    recipientUserName: String,
    recipientEmail: String,
    recipientClientUserId: String,
    launchStrategy: CaptiveSigningLaunchStrategy,
    completion: (Result<SigningOutcome>) -> Unit
  ) {
    if (!isInitialized) {
      completion(Result.failure(NotInitializedException()))
      return
    }

    if (!isLoggedIn()) {
      completion(Result.failure(NotLoggedInException()))
      return
    }

    if (!pendingCompletion.compareAndSet(null, completion)) {
      completion(Result.failure(SigningFailedException("A signing session is already in progress")))
      return
    }
    currentEnvelopeId = envelopeId

    val listener = captiveSigningListener()

    when (launchStrategy) {
      CaptiveSigningLaunchStrategy.FETCH ->
        launchViaEnvelopeFetch(activity, envelopeId, recipientClientUserId, listener)
      CaptiveSigningLaunchStrategy.SIGNING_URL ->
        launchViaSigningUrl(
          activity,
          envelopeId,
          recipientUserName,
          recipientEmail,
          recipientClientUserId,
          listener,
          completion
        )
    }
  }

  /**
   * One listener for every launch path. Both entrypoints previously built their own copy, so a fix
   * to any callback had to be made twice and the copies could drift.
   */
  private fun captiveSigningListener() = object : DSCaptiveSigningListener {
    override fun onStart(envelopeId: String) {}

    override fun onSuccess(envelopeId: String) {
      handleSigningCompleted(envelopeId)
    }

    override fun onCancel(envelopeId: String, recipientId: String) {
      handleSigningCancelled(envelopeId, null)
    }

    override fun onError(envelopeId: String?, exception: DSSigningException) {
      handleSigningError(envelopeId, "signing_failed", exception.message ?: "Unknown error")
    }

    override fun onRecipientSigningSuccess(envelopeId: String, recipientId: String) {}

    override fun onRecipientSigningError(
      envelopeId: String,
      recipientId: String,
      exception: DSSigningException
    ) {
      handleSigningError(
        envelopeId,
        "recipient_signing_failed",
        exception.message ?: "Unknown error"
      )
    }
  }

  /**
   * Guards every URL this object hands to the SDK or sends credentials to.
   *
   * The SDK's URL overload validates nothing and calls `startActivity` unconditionally, so a blank
   * or non-https signing URL would open an empty signing activity that never calls the listener
   * back, leaving the promise unsettled. The recipient-view request needs the same check for a
   * different reason: it carries the session bearer token, and `host` arrives unvalidated from JS.
   */
  private fun isHttpsUrl(url: String): Boolean {
    val uri = android.net.Uri.parse(url)
    return uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank()
  }

  private fun launchViaEnvelopeFetch(
    activity: Activity,
    envelopeId: String,
    recipientClientUserId: String,
    listener: DSCaptiveSigningListener
  ) {
    try {
      DocuSign.getInstance().getCustomSettingsDelegate()
        .disableNativeComponentsInOnlineSigning(activity, true)
      DocuSign.getInstance().getSigningDelegate().launchCaptiveSigning(
        activity,
        envelopeId,
        recipientClientUserId,
        listener
      )
    } catch (e: Exception) {
      currentEnvelopeId = null
      val pending = pendingCompletion.getAndSet(null)
      pending?.invoke(Result.failure(SigningFailedException(e.message ?: "Unknown error")))
    }
  }

  /**
   * Presents captive signing from a pre-minted DocuSign recipient-view URL.
   * The URL is the signing credential, so SDK initialization is required but
   * a prior `loginWithAccessToken` call is not.
   */
  fun presentCaptiveSigningWithUrl(
    activity: Activity,
    signingUrl: String,
    envelopeId: String,
    recipientId: String?,
    completion: (Result<SigningOutcome>) -> Unit
  ) {
    if (!isInitialized) {
      completion(Result.failure(NotInitializedException()))
      return
    }

    // Ahead of the compareAndSet on purpose: a rejected URL must not claim the pending slot, or a
    // later valid call would be refused as "already in progress".
    if (!isHttpsUrl(signingUrl)) {
      completion(Result.failure(SigningFailedException("Signing URL must be a valid HTTPS URL")))
      return
    }

    if (!pendingCompletion.compareAndSet(null, completion)) {
      completion(Result.failure(SigningFailedException("A signing session is already in progress")))
      return
    }
    currentEnvelopeId = envelopeId

    launchWithSigningUrl(activity, signingUrl, envelopeId, recipientId, captiveSigningListener())
  }

  /**
   * Mints a recipient view and launches the SDK's signing-URL overload.
   *
   * The fetch-based overload downloads the envelope with `include=documents` on a size-derived
   * read timeout that floors at 15s when nothing is cached, and that download is what times out
   * on large envelopes. The signing-URL overload skips it and points the WebView straight at a
   * recipient-view URL, which needs nothing beyond the recipient details passed here and the
   * session credentials already held, so the timing-out call never runs.
   */
  private fun launchViaSigningUrl(
    activity: Activity,
    envelopeId: String,
    recipientUserName: String,
    recipientEmail: String,
    recipientClientUserId: String,
    listener: DSCaptiveSigningListener,
    completion: (Result<SigningOutcome>) -> Unit
  ) {
    thread(start = true, isDaemon = true) {
      val url = try {
        mintRecipientViewUrl(envelopeId, recipientUserName, recipientEmail, recipientClientUserId)
          .also {
            // Same guard the public URL entrypoint applies. A malformed mint response would
            // otherwise open an empty signing activity that never calls the listener back.
            if (!isHttpsUrl(it)) throw IOException("recipient view returned an invalid URL")
          }
      } catch (e: Exception) {
        // A mint failure must not be worse than not offering the strategy at all. Falling back to
        // the fetch path restores the default behaviour exactly, so this can only add a way to
        // succeed.
        activity.runOnUiThread {
          if (!canLaunchOn(activity, envelopeId, completion)) return@runOnUiThread
          launchViaEnvelopeFetch(activity, envelopeId, recipientClientUserId, listener)
        }
        return@thread
      }
      activity.runOnUiThread {
        if (!canLaunchOn(activity, envelopeId, completion)) return@runOnUiThread
        launchWithSigningUrl(activity, url, envelopeId, recipientClientUserId, listener)
      }
    }
  }

  private fun launchWithSigningUrl(
    activity: Activity,
    url: String,
    envelopeId: String,
    recipientId: String?,
    listener: DSCaptiveSigningListener
  ) {
    try {
      DocuSign.getInstance().getCustomSettingsDelegate()
        .disableNativeComponentsInOnlineSigning(activity, true)
      DocuSign.getInstance().getSigningDelegate().launchCaptiveSigning(
        activity,
        url,
        envelopeId,
        recipientId,
        listener
      )
    } catch (e: Exception) {
      currentEnvelopeId = null
      val pending = pendingCompletion.getAndSet(null)
      pending?.invoke(Result.failure(SigningFailedException(e.message ?: "Unknown error")))
    }
  }

  /**
   * Minting puts a network round trip between capturing the Activity and using it, which the fetch
   * path never did because it launched on the same stack frame. `runOnUiThread` posts to the main
   * looper regardless of Activity state, so by the time this runs the screen may be gone or the
   * session already resolved by `reset` or `endSigningSession`. Launching the SDK against either is
   * how a dead-window crash or an orphaned signing screen happens.
   *
   * The check is on identity, not nullness. `reset` and `endSigningSession` clear the slot, and a
   * fresh `presentCaptiveSigning` can claim it before a stale mint lands. A nullness check would
   * pass in that window and launch this envelope wired to the new session's promise, resolving it
   * with the wrong outcome. On a mismatch, do nothing at all: the slot is not this call's to
   * resolve, and its own completion was already settled by whoever cleared it.
   */
  private fun canLaunchOn(
    activity: Activity,
    envelopeId: String,
    completion: (Result<SigningOutcome>) -> Unit
  ): Boolean {
    if (pendingCompletion.get() !== completion) return false
    if (activity.isFinishing || activity.isDestroyed) {
      handleSigningCancelled(envelopeId, "activity_unavailable")
      return false
    }
    return true
  }

  private fun mintRecipientViewUrl(
    envelopeId: String,
    recipientUserName: String,
    recipientEmail: String,
    recipientClientUserId: String
  ): String {
    val active = session ?: throw IllegalStateException("no active DocuSign session")
    val endpoint =
      "${restApiRoot(active.host)}/accounts/${active.accountId}/envelopes/$envelopeId/views/recipient"
    // `host` arrives from JS unvalidated, and this request carries the session bearer token. Refuse
    // to send it anywhere that is not https rather than leaking it in cleartext. Throwing here
    // routes to the fetch fallback, so a misconfigured host degrades instead of failing outright.
    if (!isHttpsUrl(endpoint)) {
      throw IOException("DocuSign host must be an https URL to mint a recipient view")
    }
    val body = JSONObject()
      .put("clientUserId", recipientClientUserId)
      .put("userName", recipientUserName)
      .put("email", recipientEmail)
      .put("authenticationMethod", "none")
      .put("returnUrl", "https://docusign/")
      .toString()
    var connection: HttpURLConnection? = null
    return try {
      connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        // Deliberately tighter than the envelope download this replaces. A recipient view is a
        // small JSON POST, and the thread holds the Activity for the whole round trip, so a long
        // ceiling would just delay the fallback and pin the view tree while it waited.
        connectTimeout = 15_000
        readTimeout = 15_000
        doOutput = true
        setRequestProperty("Authorization", "Bearer ${active.accessToken}")
        setRequestProperty("Content-Type", "application/json")
        setRequestProperty("Accept", "application/json")
      }
      connection.outputStream.use { it.write(body.toByteArray()) }
      val code = connection.responseCode
      val stream = if (code in 200..299) connection.inputStream else connection.errorStream
      val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
      if (code !in 200..299) {
        throw IOException("recipient view request failed with HTTP $code")
      }
      JSONObject(text).getString("url")
    } finally {
      connection?.disconnect()
    }
  }

  fun handleSigningCompleted(envelopeId: String) {
    val outcome = SigningOutcome(status = "completed", envelopeId = envelopeId)
    module?.emitSigningComplete(envelopeId)
    currentEnvelopeId = null
    pendingCompletion.getAndSet(null)?.invoke(Result.success(outcome))
  }

  fun handleSigningCancelled(envelopeId: String, reason: String?) {
    val outcome = SigningOutcome(
      status = "cancelled",
      envelopeId = envelopeId,
      errorMessage = reason
    )
    module?.emitSigningCancelled(envelopeId, reason)
    currentEnvelopeId = null
    pendingCompletion.getAndSet(null)?.invoke(Result.success(outcome))
  }

  fun handleSigningError(envelopeId: String?, errorCode: String, errorMessage: String) {
    module?.emitSigningError(envelopeId, errorCode, errorMessage)
    currentEnvelopeId = null
    pendingCompletion.getAndSet(null)?.invoke(Result.failure(SigningFailedException(errorMessage)))
  }
}
