import ExpoModulesCore
import UIKit
import WebKit
import DocuSignSDK

internal enum DocuSignEnvironment: String {
  case demo
  case production
}

internal struct DocuSignAccountInfo {
  let accountId: String
  let userId: String
  let userName: String
  let email: String
}

internal struct DocuSignSetupOptions {
  let disablePoweredByBranding: Bool
  let disableAppearance: Bool
  let disableLocationPermission: Bool
}

internal final class DocuSignManager: NSObject {
  static let shared = DocuSignManager()

  private var _isInitialized = false
  private var _hasLoggedIn = false
  private var _integratorKey: String?
  private var _hostURL: URL?
  private var _observersRegistered = false
  private var currentEnvelopeId: String?
  private weak var module: DocuSignModule?

  private var environment: DocuSignEnvironment = .demo
  private var pendingCompletion: ((Result<SigningOutcome, Error>) -> Void)?

  private let stateQueue = DispatchQueue(label: "com.rndocusign.state")

  private var isInitialized: Bool {
    get { stateQueue.sync { _isInitialized } }
    set { stateQueue.sync { _isInitialized = newValue } }
  }
  private var hasLoggedIn: Bool {
    get { stateQueue.sync { _hasLoggedIn } }
    set { stateQueue.sync { _hasLoggedIn = newValue } }
  }
  private var integratorKey: String? {
    get { stateQueue.sync { _integratorKey } }
    set { stateQueue.sync { _integratorKey = newValue } }
  }
  private var hostURL: URL? {
    get { stateQueue.sync { _hostURL } }
    set { stateQueue.sync { _hostURL = newValue } }
  }

  private override init() {
    super.init()
  }

  func setModule(_ module: DocuSignModule) {
    self.module = module
  }

  func initialize(
    integratorKey: String,
    environment: DocuSignEnvironment,
    options: DocuSignSetupOptions
  ) throws {
    if isInitialized {
      return
    }

    let host: String
    switch environment {
    case .demo:
      host = "https://demo.docusign.net/restapi"
    case .production:
      host = "https://www.docusign.net/restapi"
    }

    guard let url = URL(string: host) else {
      throw NotInitializedException()
    }

    self.integratorKey = integratorKey
    self.hostURL = url
    self.environment = environment

    let dispatchSetup: () -> Void = {
      var configurations = DSMManager.defaultConfigurations() ?? [:]
      if options.disablePoweredByBranding {
        configurations[DSM_SETUP_POWERED_BY_DOCUSIGN_ENABLED] = DSM_SETUP_FALSE_VALUE
      }
      if options.disableAppearance {
        configurations[DSM_SETUP_DISABLE_APPEARANCE] = DSM_SETUP_TRUE_VALUE
      }
      if options.disableLocationPermission {
        configurations[DSM_SETUP_CAPTIVE_SIGNING_DISABLE_LOCATION_PERMISSION] = DSM_SETUP_TRUE_VALUE
      }
      DSMManager.setup(withConfiguration: configurations)
      self.registerNotificationObservers()
    }

    if Thread.isMainThread {
      dispatchSetup()
    } else {
      DispatchQueue.main.sync(execute: dispatchSetup)
    }

    isInitialized = true
  }

  func loginWithAccessToken(
    accessToken: String,
    accountId: String,
    userId: String,
    userName: String,
    email: String,
    host: String,
    expiresIn: Int,
    completion: @escaping (Result<DocuSignAccountInfo, Error>) -> Void
  ) throws {
    guard isInitialized, self.integratorKey != nil, self.hostURL != nil else {
      throw NotInitializedException()
    }

    let needsUserInfo = accountId.isEmpty || userId.isEmpty || userName.isEmpty || email.isEmpty || host.isEmpty

    if !needsUserInfo {
      performLogin(
        accessToken: accessToken,
        accountId: accountId,
        userId: userId,
        userName: userName,
        email: email,
        hostOverride: host,
        expiresIn: expiresIn,
        completion: completion
      )
      return
    }

    fetchUserInfo(accessToken: accessToken, preferredAccountId: accountId) { [weak self] result in
      guard let self = self else { return }
      switch result {
      case .failure(let error):
        completion(.failure(error))
      case .success(let info):
        self.performLogin(
          accessToken: accessToken,
          accountId: accountId.isEmpty ? info.accountId : accountId,
          userId: userId.isEmpty ? info.userId : userId,
          userName: userName.isEmpty ? info.userName : userName,
          email: email.isEmpty ? info.email : email,
          hostOverride: host.isEmpty ? info.host : host,
          expiresIn: expiresIn,
          completion: completion
        )
      }
    }
  }

  private func performLogin(
    accessToken: String,
    accountId: String,
    userId: String,
    userName: String,
    email: String,
    hostOverride: String,
    expiresIn: Int,
    completion: @escaping (Result<DocuSignAccountInfo, Error>) -> Void
  ) {
    guard let integratorKey = self.integratorKey, let fallbackHost = self.hostURL else {
      completion(.failure(NotInitializedException()))
      return
    }

    // DSMManager APIs must run on the main thread. Expo/RN dispatches
    // native module calls on a serial background queue, so hop to main.
    if !Thread.isMainThread {
      DispatchQueue.main.async { [weak self] in
        self?.performLogin(
          accessToken: accessToken,
          accountId: accountId,
          userId: userId,
          userName: userName,
          email: email,
          hostOverride: hostOverride,
          expiresIn: expiresIn,
          completion: completion
        )
      }
      return
    }

    let effectiveHost: URL
    if !hostOverride.isEmpty, let override = URL(string: hostOverride) {
      effectiveHost = override
    } else {
      effectiveHost = fallbackHost
    }

    let expiryDate: Date? = expiresIn > 0
      ? Date(timeIntervalSinceNow: TimeInterval(expiresIn))
      : nil

    // Always tear down WebKit data + DocuSign auth before DSMManager.login.
    // Earlier versions skipped this on first login (when hasLoggedIn=false) on the
    // assumption that a fresh launch implies fresh WebKit data. That assumption is
    // wrong: WKWebsiteDataStore persists across process kills, so a second launch
    // after a force-close still carries the previous session's WebKit state — most
    // critically, the DocuSign signing UI's service worker registration. Without
    // a wipe, that stale service worker intercepts fetch calls inside the next
    // signing WebView and produces an endless "we encountered an error, retrying..."
    // loop even though the new envelope and tokens are valid. The teardown is
    // sequenced via WKWebsiteDataStore.removeData completion before DSMManager.login
    // is invoked, so there is no race with the WebView session bootstrap.
    clearWebCookiesAsync { [weak self] in
      guard let self = self else { return }
      _ = DSMManager.logout()
      self.hasLoggedIn = false
      self.performLoginCall(
        accessToken: accessToken,
        accountId: accountId,
        userId: userId,
        userName: userName,
        email: email,
        effectiveHost: effectiveHost,
        integratorKey: integratorKey,
        expiryDate: expiryDate,
        completion: completion
      )
    }
  }

  private func performLoginCall(
    accessToken: String,
    accountId: String,
    userId: String,
    userName: String,
    email: String,
    effectiveHost: URL,
    integratorKey: String,
    expiryDate: Date?,
    completion: @escaping (Result<DocuSignAccountInfo, Error>) -> Void
  ) {
    let tokenAzp = Self.decodeJWTClaim(accessToken, claim: "azp")
      ?? Self.decodeJWTClaim(accessToken, claim: "aud")
      ?? "(unknown)"
    #if DEBUG
    NSLog("[DocuSign] Calling DSMManager.login with:")
    NSLog("[DocuSign]   integratorKey (init)=\(integratorKey)")
    NSLog("[DocuSign]   token azp/aud=\(tokenAzp)")
    NSLog("[DocuSign]   host=\(effectiveHost.absoluteString)")
    if tokenAzp != "(unknown)" && tokenAzp != integratorKey {
      NSLog("[DocuSign]   ⚠️ MISMATCH: integratorKey != token's azp/aud claim. This is the usual cause of 'Invalid login information'.")
    }
    #endif

    let diagnostic = "integratorKey=\(integratorKey) tokenAzp=\(tokenAzp) host=\(effectiveHost.absoluteString)"

    module?.sendEvent("onLoginAttempt", [
      "integratorKey": integratorKey,
      "accountId": accountId,
      "userId": userId,
      "userName": userName,
      "email": email,
      "host": effectiveHost.absoluteString
    ])

    DSMManager.login(
      withAccessToken: accessToken,
      accountId: accountId,
      userId: userId,
      userName: userName,
      email: email,
      host: effectiveHost,
      integratorKey: integratorKey,
      refreshToken: nil,
      expiresIn: expiryDate
    ) { [weak self] accountInfo, error in
      if let error = error {
        // Classify failure via /oauth/userinfo pre-flight so we can surface
        // an actionable error instead of opaque "unauthorized".
        self?.classifyLoginFailure(accessToken: accessToken, sdkError: error, diagnostic: diagnostic, integratorKey: integratorKey, completion: completion)
        return
      }
      self?.hasLoggedIn = true
      let resolved = DocuSignAccountInfo(
        accountId: accountInfo?.accountId ?? accountId,
        userId: accountInfo?.userId ?? userId,
        userName: accountInfo?.userName ?? userName,
        email: accountInfo?.email ?? email
      )
      completion(.success(resolved))
    }
  }

  /// Clears DocuSign SDK cookies plus all WKWebsiteDataStore data and invokes
  /// `completion` on the main thread once teardown is complete. The DocuSign SDK's
  /// `clearAllWebCookies` has no completion handler, so we layer
  /// `WKWebsiteDataStore.removeData` on top to obtain a real signal that teardown
  /// finished before re-logging in.
  ///
  /// We pass `WKWebsiteDataStore.allWebsiteDataTypes()` rather than an explicit
  /// subset because the DocuSign signing UI registers a service worker on first
  /// visit, and service worker registrations + the fetch cache are stored
  /// separately from cookies/localStorage/IndexedDB. Clearing only the common
  /// subset leaves the SW behind on disk, which then intercepts the next signing
  /// WebView's fetch calls with stale cached responses.
  ///
  /// Note: this wipes the **default** `WKWebsiteDataStore`, which is shared by
  /// every WKWebView in the host process that does not specify a private or
  /// non-persistent configuration. Host apps that use WKWebView for other
  /// content (OAuth flows, in-app browsers, help centers) will have those
  /// WebViews' cookies, caches, and service workers cleared whenever
  /// `loginWithAccessToken` runs. If you need to isolate DocuSign's WebKit
  /// state from the rest of your app, use a non-default data store for those
  /// other WebViews.
  private func clearWebCookiesAsync(completion: @escaping () -> Void) {
    DSMManager.clearAllWebCookies()
    let dataStore = WKWebsiteDataStore.default()
    let types = WKWebsiteDataStore.allWebsiteDataTypes()
    let since = Date(timeIntervalSince1970: 0)
    dataStore.removeData(ofTypes: types, modifiedSince: since) {
      DispatchQueue.main.async { completion() }
    }
  }

  private func classifyLoginFailure(
    accessToken: String,
    sdkError: Error,
    diagnostic: String,
    integratorKey: String,
    completion: @escaping (Result<DocuSignAccountInfo, Error>) -> Void
  ) {
    let sdkMsg = (sdkError as NSError).localizedDescription
    let sdkCode = (sdkError as NSError).code

    probeUserInfoStatus(accessToken: accessToken) { probe in
      let enrichedMsg: String
      switch probe {
      case .ok:
        enrichedMsg = "SDK rejected a valid token. Likely causes: Mobile SDK not enabled for integration key \(integratorKey), or iOS bundle ID not whitelisted in DocuSign admin. Contact DocuSign support. (SDK: \(sdkMsg)) | \(diagnostic)"
      case .unauthorized:
        enrichedMsg = "Access token rejected by DocuSign /oauth/userinfo. Re-mint via JWT Bearer Grant with scope=signature impersonation. (SDK: \(sdkMsg)) | \(diagnostic)"
      case .network(let netMsg):
        enrichedMsg = "\(sdkMsg) (userinfo probe network error: \(netMsg)) | \(diagnostic)"
      }
      let enriched = NSError(
        domain: "DocuSign",
        code: sdkCode,
        userInfo: [NSLocalizedDescriptionKey: enrichedMsg]
      )
      completion(.failure(enriched))
    }
  }

  private enum UserInfoProbe {
    case ok
    case unauthorized
    case network(String)
  }

  private func probeUserInfoStatus(accessToken: String, completion: @escaping (UserInfoProbe) -> Void) {
    guard let base = oauthBaseURL() else {
      completion(.network("no oauth base URL"))
      return
    }
    let url = base.appendingPathComponent("oauth/userinfo")
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.timeoutInterval = 10

    URLSession.shared.dataTask(with: request) { _, response, error in
      if let error = error {
        completion(.network(error.localizedDescription))
        return
      }
      guard let http = response as? HTTPURLResponse else {
        completion(.network("no HTTP response"))
        return
      }
      if (200..<300).contains(http.statusCode) {
        completion(.ok)
      } else if http.statusCode == 401 || http.statusCode == 403 {
        completion(.unauthorized)
      } else {
        completion(.network("userinfo HTTP \(http.statusCode)"))
      }
    }.resume()
  }

  private static func decodeJWTClaim(_ token: String, claim: String) -> String? {
    let parts = token.split(separator: ".")
    guard parts.count >= 2 else { return nil }
    var payload = String(parts[1])
    let padLen = (4 - payload.count % 4) % 4
    payload.append(String(repeating: "=", count: padLen))
    payload = payload.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    guard let data = Data(base64Encoded: payload) else { return nil }
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    if let s = json[claim] as? String { return s }
    if let arr = json[claim] as? [String], let first = arr.first { return first }
    return nil
  }

  private struct ResolvedUserInfo {
    let accountId: String
    let userId: String
    let userName: String
    let email: String
    let host: String
  }

  private func oauthBaseURL() -> URL? {
    switch environment {
    case .demo:
      return URL(string: "https://account-d.docusign.com")
    case .production:
      return URL(string: "https://account.docusign.com")
    }
  }

  private func fetchUserInfo(
    accessToken: String,
    preferredAccountId: String,
    completion: @escaping (Result<ResolvedUserInfo, Error>) -> Void
  ) {
    guard let base = oauthBaseURL() else {
      completion(.failure(LoginFailedException("Could not derive OAuth base URL")))
      return
    }
    let url = base.appendingPathComponent("oauth/userinfo")
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.timeoutInterval = 10

    URLSession.shared.dataTask(with: request) { data, response, error in
      if let error = error {
        completion(.failure(LoginFailedException("userinfo request failed: \(error.localizedDescription)")))
        return
      }
      guard let http = response as? HTTPURLResponse else {
        completion(.failure(LoginFailedException("userinfo: no HTTP response")))
        return
      }
      guard (200..<300).contains(http.statusCode), let data = data else {
        let snippet = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        completion(.failure(LoginFailedException("userinfo HTTP \(http.statusCode): \(snippet.prefix(200))")))
        return
      }
      do {
        let decoded = try JSONDecoder().decode(UserInfoPayload.self, from: data)
        guard let account = Self.pickAccount(from: decoded.accounts, preferredId: preferredAccountId) else {
          completion(.failure(LoginFailedException("userinfo: no accounts in response")))
          return
        }
        let host = account.base_uri.hasSuffix("/restapi") ? account.base_uri : account.base_uri + "/restapi"
        let resolved = ResolvedUserInfo(
          accountId: account.account_id,
          userId: decoded.sub,
          userName: decoded.name,
          email: decoded.email,
          host: host
        )
        completion(.success(resolved))
      } catch {
        completion(.failure(LoginFailedException("userinfo decode error: \(error.localizedDescription)")))
      }
    }.resume()
  }

  private static func pickAccount(from accounts: [UserInfoAccount], preferredId: String) -> UserInfoAccount? {
    if !preferredId.isEmpty, let match = accounts.first(where: { $0.account_id == preferredId }) {
      return match
    }
    if let def = accounts.first(where: { $0.is_default == true }) {
      return def
    }
    return accounts.first
  }

  private struct UserInfoPayload: Decodable {
    let sub: String
    let name: String
    let email: String
    let accounts: [UserInfoAccount]
  }

  private struct UserInfoAccount: Decodable {
    let account_id: String
    let account_name: String?
    let is_default: Bool?
    let base_uri: String
  }

  func logout() {
    if Thread.isMainThread {
      _ = DSMManager.logout()
    } else {
      DispatchQueue.main.sync {
        _ = DSMManager.logout()
      }
    }
    hasLoggedIn = false
  }

  func isLoggedIn() -> Bool {
    return hasLoggedIn
  }

  /// Tears down any in-flight signing session and the underlying SDK auth
  /// state so the next `loginWithAccessToken` + `presentCaptiveSigning` pair
  /// starts from a clean slate. Safe to call when no session is active.
  ///
  /// Consumers should call this between captive signing flows (e.g. inside
  /// the `finally` of their orchestrator hook) to avoid the implicit
  /// teardown path inside `performLogin`. It is also wired into the JS
  /// `useDocuSignSigning` hook's `reset()` so React consumers get this for
  /// free.
  func endSigningSession(completion: @escaping () -> Void) {
    // Resolve any in-flight signing promise so the JS side does not hang.
    var pendingResolved = false
    stateQueue.sync {
      if let pending = pendingCompletion {
        let outcome = SigningOutcome(
          status: "cancelled",
          envelopeId: currentEnvelopeId ?? "",
          errorCode: nil,
          errorMessage: "session_ended"
        )
        pendingCompletion = nil
        currentEnvelopeId = nil
        DispatchQueue.main.async { pending(.success(outcome)) }
        pendingResolved = true
      }
    }
    _ = pendingResolved // silence unused-warning; kept for future telemetry

    clearWebCookiesAsync { [weak self] in
      guard let self = self else {
        completion()
        return
      }
      _ = DSMManager.logout()
      self.hasLoggedIn = false
      completion()
    }
  }

  /// Full SDK teardown: a heavier counterpart to `endSigningSession`. Resolves
  /// any in-flight signing promise as `cancelled`, wipes WebKit data (cookies,
  /// service workers, fetch cache, etc.), calls `DSMManager.logout()`, removes
  /// notification observers, and resets every internal state flag including
  /// `_isInitialized` and `_observersRegistered`. The next `initialize()` call
  /// will run `DSMManager.setup(withConfiguration:)` again, giving the SDK a
  /// completely fresh slate.
  ///
  /// Use this when you want a hard reset between flows (e.g. error recovery,
  /// switching DocuSign accounts, or after an app-level logout). For routine
  /// teardown between consecutive captive signing flows on the same auth,
  /// prefer `endSigningSession`, which keeps the SDK initialized and skips
  /// the observer churn.
  ///
  /// Safe to call when the SDK was never initialized: returns immediately
  /// without touching DSMManager.
  func reset(completion: @escaping () -> Void) {
    stateQueue.sync {
      if let pending = pendingCompletion {
        let outcome = SigningOutcome(
          status: "cancelled",
          envelopeId: currentEnvelopeId ?? "",
          errorCode: nil,
          errorMessage: "reset"
        )
        pendingCompletion = nil
        currentEnvelopeId = nil
        DispatchQueue.main.async { pending(.success(outcome)) }
      }
    }

    let needsTeardown = stateQueue.sync { _isInitialized || _hasLoggedIn }
    guard needsTeardown else {
      completion()
      return
    }

    if !Thread.isMainThread {
      DispatchQueue.main.async { [weak self] in
        guard let self = self else { completion(); return }
        self.reset(completion: completion)
      }
      return
    }

    clearWebCookiesAsync { [weak self] in
      guard let self = self else { completion(); return }
      _ = DSMManager.logout()
      NotificationCenter.default.removeObserver(self)
      // Use stateQueue.async (not sync) for the state reset. We are on main
      // here (clearWebCookiesAsync's completion is dispatched on main), and a
      // nested stateQueue.sync from main while another thread holds the queue
      // is the classic deadlock recipe. async serializes the writes safely
      // without blocking, then hops back to main to fire the completion.
      self.stateQueue.async {
        self._isInitialized = false
        self._hasLoggedIn = false
        self._integratorKey = nil
        self._hostURL = nil
        self._observersRegistered = false
        DispatchQueue.main.async { completion() }
      }
    }
  }

  func presentCaptiveSigning(
    envelopeId: String,
    recipientUserName: String,
    recipientEmail: String,
    recipientClientUserId: String,
    completion: @escaping (Result<SigningOutcome, Error>) -> Void
  ) throws {
    guard isInitialized else {
      throw NotInitializedException()
    }

    guard isLoggedIn() else {
      throw NotLoggedInException()
    }

    var alreadyInFlight = false
    stateQueue.sync {
      if pendingCompletion != nil {
        alreadyInFlight = true
      } else {
        currentEnvelopeId = envelopeId
        pendingCompletion = completion
      }
    }
    if alreadyInFlight {
      throw SigningFailedException("A signing session is already in progress")
    }

    guard let presentingViewController = Self.topmostViewController() else {
      resolvePending(.failure(PresentationException("Could not find a view controller to present from")))
      throw PresentationException("Could not find a view controller to present from")
    }

    DispatchQueue.main.async {
      let envelopesManager = DSMEnvelopesManager()
      envelopesManager.presentCaptiveSigning(
        withPresenting: presentingViewController,
        envelopeId: envelopeId,
        recipientUserName: recipientUserName,
        recipientEmail: recipientEmail,
        recipientClientUserId: recipientClientUserId,
        animated: true,
        completion: { [weak self] (_: UIViewController?, error: Error?) in
          guard let self = self else { return }
          if let error = error {
            self.resolvePending(.failure(error))
          }
          // Success/cancel path is driven by DSMSigningCompletedNotification / DSMSigningCancelledNotification
        }
      )
    }
  }

  /// Guards the URL handed to the SDK's URL overload.
  ///
  /// `DSMEnvelopesManager.presentCaptiveSigning(withPresenting:signingUrl:...)` validates nothing
  /// and presents unconditionally, so a blank or non-https URL renders an empty signing controller
  /// whose completion never fires and leaves the promise unsettled. `CaptiveSigningUrlRecord`
  /// defaults `signingUrl` to "", so an omitted field reaches here as a blank string.
  private static func isHttpsUrl(_ url: String) -> Bool {
    guard let components = URLComponents(string: url) else {
      return false
    }
    return components.scheme?.lowercased() == "https" && !(components.host ?? "").isEmpty
  }

  /// Presents captive signing from a pre-minted DocuSign recipient-view URL.
  ///
  /// The signing URL itself encodes recipient identity via a short-lived token,
  /// so this path intentionally does NOT require a prior `loginWithAccessToken`.
  /// `initialize` is still required.
  func presentCaptiveSigningWithUrl(
    signingUrl: String,
    envelopeId: String,
    recipientId: String?,
    completion: @escaping (Result<SigningOutcome, Error>) -> Void
  ) throws {
    guard isInitialized else {
      throw NotInitializedException()
    }

    // Ahead of the pendingCompletion claim on purpose: a rejected URL must not occupy the slot, or
    // a later valid call would be refused as "already in progress".
    guard Self.isHttpsUrl(signingUrl) else {
      throw SigningFailedException("Signing URL must be a valid HTTPS URL")
    }

    var alreadyInFlight = false
    stateQueue.sync {
      if pendingCompletion != nil {
        alreadyInFlight = true
      } else {
        currentEnvelopeId = envelopeId
        pendingCompletion = completion
      }
    }
    if alreadyInFlight {
      throw SigningFailedException("A signing session is already in progress")
    }

    guard let presentingViewController = Self.topmostViewController() else {
      resolvePending(.failure(PresentationException("Could not find a view controller to present from")))
      throw PresentationException("Could not find a view controller to present from")
    }

    DispatchQueue.main.async {
      let envelopesManager = DSMEnvelopesManager()
      envelopesManager.presentCaptiveSigning(
        withPresenting: presentingViewController,
        signingUrl: signingUrl,
        envelopeId: envelopeId,
        recipientId: recipientId,
        animated: true,
        completion: { [weak self] (_: UIViewController?, error: Error?) in
          guard let self = self else { return }
          if let error = error {
            self.resolvePending(.failure(error))
          }
        }
      )
    }
  }

  internal struct SigningOutcome {
    let status: String
    let envelopeId: String
    let errorCode: String?
    let errorMessage: String?
  }

  private func resolvePending(_ result: Result<SigningOutcome, Error>) {
    var completion: ((Result<SigningOutcome, Error>) -> Void)?
    stateQueue.sync {
      completion = pendingCompletion
      pendingCompletion = nil
      currentEnvelopeId = nil
    }
    completion?(result)
  }

  private func envelopeId(from notification: Notification) -> String {
    if let id = notification.userInfo?[DSMEnvelopeIdKey] as? String, !id.isEmpty {
      return id
    }
    return currentEnvelopeId ?? ""
  }

  private func registerNotificationObservers() {
    var alreadyRegistered = false
    stateQueue.sync {
      if _observersRegistered {
        alreadyRegistered = true
      } else {
        _observersRegistered = true
      }
    }
    if alreadyRegistered { return }

    let nc = NotificationCenter.default
    nc.addObserver(
      self,
      selector: #selector(handleSigningCompleted(_:)),
      name: .DSMSigningCompleted,
      object: nil
    )
    nc.addObserver(
      self,
      selector: #selector(handleSigningCancelled(_:)),
      name: .DSMSigningCancelled,
      object: nil
    )
  }

  @objc private func handleSigningCompleted(_ notification: Notification) {
    let envelopeId = envelopeId(from: notification)
    let outcome = SigningOutcome(
      status: "completed",
      envelopeId: envelopeId,
      errorCode: nil,
      errorMessage: nil
    )
    module?.sendEvent("onSigningComplete", ["envelopeId": envelopeId])
    resolvePending(.success(outcome))
  }

  @objc private func handleSigningCancelled(_ notification: Notification) {
    let envelopeId = envelopeId(from: notification)
    let userInfo = notification.userInfo

    if let sdkError = userInfo?[DSMErrorKey] as? Error {
      let nsErr = sdkError as NSError
      let errorMessage = nsErr.localizedDescription
      let errorCode = String(nsErr.code)
      let outcome = SigningOutcome(
        status: "error",
        envelopeId: envelopeId,
        errorCode: errorCode,
        errorMessage: errorMessage
      )
      module?.sendEvent("onSigningError", [
        "envelopeId": envelopeId,
        "errorCode": errorCode,
        "errorMessage": errorMessage
      ])
      resolvePending(.success(outcome))
      return
    }

    let reason = userInfo?[DSMSigningExitReasonKey] as? String
    let outcome = SigningOutcome(
      status: "cancelled",
      envelopeId: envelopeId,
      errorCode: nil,
      errorMessage: reason
    )
    var event: [String: Any] = ["envelopeId": envelopeId]
    if let reason = reason { event["reason"] = reason }
    module?.sendEvent("onSigningCancelled", event)
    resolvePending(.success(outcome))
  }

  private static func topmostViewController(
    base: UIViewController? = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first(where: { $0.isKeyWindow })?.rootViewController
  ) -> UIViewController? {
    if let nav = base as? UINavigationController {
      return topmostViewController(base: nav.visibleViewController)
    }
    if let tab = base as? UITabBarController, let selected = tab.selectedViewController {
      return topmostViewController(base: selected)
    }
    if let presented = base?.presentedViewController {
      return topmostViewController(base: presented)
    }
    return base
  }
}
