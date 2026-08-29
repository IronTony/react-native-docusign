import ExpoModulesCore

internal struct DocuSignInitConfig: Record {
  @Field var integratorKey: String = ""
  @Field var environment: String = "demo"
  @Field var disablePoweredByBranding: Bool = false
  @Field var disableAppearance: Bool = false
  @Field var disableLocationPermission: Bool = false
}

internal struct DocuSignAuthRecord: Record {
  @Field var accessToken: String = ""
  @Field var accountId: String = ""
  @Field var userId: String = ""
  @Field var userName: String = ""
  @Field var email: String = ""
  @Field var host: String = ""
  @Field var expiresIn: Int = 3600
}

internal struct CaptiveSigningRecord: Record {
  @Field var envelopeId: String = ""
  @Field var recipientUserName: String = ""
  @Field var recipientEmail: String = ""
  @Field var recipientClientUserId: String = ""
}

internal struct CaptiveSigningUrlRecord: Record {
  @Field var signingUrl: String = ""
  @Field var envelopeId: String = ""
  @Field var recipientId: String = ""
}

public class DocuSignModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DocuSign")

    Events("onSigningComplete", "onSigningCancelled", "onSigningError", "onLoginAttempt")

    OnCreate {
      DocuSignManager.shared.setModule(self)
    }

    AsyncFunction("initialize") { (config: DocuSignInitConfig, promise: Promise) in
      do {
        let environment = DocuSignEnvironment(rawValue: config.environment) ?? .demo
        let options = DocuSignSetupOptions(
          disablePoweredByBranding: config.disablePoweredByBranding,
          disableAppearance: config.disableAppearance,
          disableLocationPermission: config.disableLocationPermission
        )
        try DocuSignManager.shared.initialize(
          integratorKey: config.integratorKey,
          environment: environment,
          options: options
        )
        promise.resolve(nil)
      } catch {
        promise.reject(error)
      }
    }

    AsyncFunction("loginWithAccessToken") { (params: DocuSignAuthRecord, promise: Promise) in
      do {
        try DocuSignManager.shared.loginWithAccessToken(
          accessToken: params.accessToken,
          accountId: params.accountId,
          userId: params.userId,
          userName: params.userName,
          email: params.email,
          host: params.host,
          expiresIn: params.expiresIn
        ) { result in
          switch result {
          case .success(let info):
            promise.resolve([
              "accountId": info.accountId,
              "userId": info.userId,
              "userName": info.userName,
              "email": info.email
            ])
          case .failure(let error):
            self.sendEvent("onSigningError", [
              "errorCode": "login_failed",
              "errorMessage": error.localizedDescription
            ])
            promise.reject(LoginFailedException(error.localizedDescription))
          }
        }
      } catch {
        promise.reject(error)
      }
    }

    AsyncFunction("presentCaptiveSigning") { (params: CaptiveSigningRecord, promise: Promise) in
      do {
        try DocuSignManager.shared.presentCaptiveSigning(
          envelopeId: params.envelopeId,
          recipientUserName: params.recipientUserName,
          recipientEmail: params.recipientEmail,
          recipientClientUserId: params.recipientClientUserId
        ) { result in
          switch result {
          case .success(let outcome):
            promise.resolve([
              "status": outcome.status,
              "envelopeId": outcome.envelopeId,
              "errorCode": outcome.errorCode as Any,
              "errorMessage": outcome.errorMessage as Any
            ])
          case .failure(let error):
            // Forward the failure's own code. Hard-coding signing_failed flattened
            // presentation_failed and hid which stage failed. promise.reject(error) is not the
            // alternative here: it wraps anything that is not an Exception, so a raw SDK NSError
            // would surface as ERR_UNEXPECTED.
            let code = (error as? CodedError)?.code ?? "signing_failed"
            self.sendEvent("onSigningError", [
              "envelopeId": params.envelopeId,
              "errorCode": code,
              "errorMessage": error.localizedDescription
            ])
            promise.reject(code, error.localizedDescription)
          }
        }
      } catch {
        promise.reject(error)
      }
    }

    AsyncFunction("presentCaptiveSigningWithUrl") { (params: CaptiveSigningUrlRecord, promise: Promise) in
      do {
        try DocuSignManager.shared.presentCaptiveSigningWithUrl(
          signingUrl: params.signingUrl,
          envelopeId: params.envelopeId,
          recipientId: params.recipientId.isEmpty ? nil : params.recipientId
        ) { result in
          switch result {
          case .success(let outcome):
            promise.resolve([
              "status": outcome.status,
              "envelopeId": outcome.envelopeId,
              "errorCode": outcome.errorCode as Any,
              "errorMessage": outcome.errorMessage as Any
            ])
          case .failure(let error):
            // Forward the failure's own code. Hard-coding signing_failed flattened
            // presentation_failed and hid which stage failed. promise.reject(error) is not the
            // alternative here: it wraps anything that is not an Exception, so a raw SDK NSError
            // would surface as ERR_UNEXPECTED.
            let code = (error as? CodedError)?.code ?? "signing_failed"
            self.sendEvent("onSigningError", [
              "envelopeId": params.envelopeId,
              "errorCode": code,
              "errorMessage": error.localizedDescription
            ])
            promise.reject(code, error.localizedDescription)
          }
        }
      } catch {
        promise.reject(error)
      }
    }

    AsyncFunction("logout") { (promise: Promise) in
      DocuSignManager.shared.logout()
      promise.resolve(nil)
    }

    AsyncFunction("isLoggedIn") { (promise: Promise) in
      promise.resolve(DocuSignManager.shared.isLoggedIn())
    }

    AsyncFunction("endSigningSession") { (promise: Promise) in
      DocuSignManager.shared.endSigningSession {
        promise.resolve(nil)
      }
    }

    AsyncFunction("reset") { (promise: Promise) in
      DocuSignManager.shared.reset {
        promise.resolve(nil)
      }
    }
  }
}
