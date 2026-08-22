export type DocuSignEnvironment = 'demo' | 'production';

export type DocuSignConfig = {
  integratorKey: string;
  environment: DocuSignEnvironment;
  disablePoweredByBranding?: boolean;
  disableAppearance?: boolean;
  disableLocationPermission?: boolean;
};

/**
 * Authentication payload for DocuSign captive signing.
 *
 * If `accountId`, `userId`, `userName`, `email`, or `host` are omitted (or
 * passed as empty strings), the native module performs a single
 * `/oauth/userinfo` lookup against the DocuSign account API using
 * `accessToken` and resolves the missing fields automatically. Pass all five
 * up front to skip the network round-trip on every login.
 */
export type DocuSignAuthParams = {
  accessToken: string;
  accountId?: string;
  userId?: string;
  userName?: string;
  email?: string;
  host?: string;
  expiresIn?: number;
};

export type DocuSignAccountInfo = {
  accountId: string;
  userId: string;
  userName: string;
  email: string;
};

/**
 * How the Android SDK opens the signing ceremony.
 *
 * `fetch` downloads the envelope first. That download runs on a size-derived
 * read timeout which floors at 15s when nothing is cached, so it can time out
 * on large envelopes.
 *
 * `signingUrl` mints a recipient view with the session access token and points
 * the SDK straight at it, skipping the download. Requires the token to be
 * scoped to create recipient views on the envelope; if the mint fails it falls
 * back to `fetch`.
 */
export type CaptiveSigningLaunchStrategy = 'fetch' | 'signingUrl';

export type CaptiveSigningParams = {
  envelopeId: string;
  recipientUserName: string;
  recipientEmail: string;
  recipientClientUserId: string;
  /**
   * Android only, ignored on iOS. Defaults to `fetch`, which is the behaviour
   * of every release before this option existed.
   */
  launchStrategy?: CaptiveSigningLaunchStrategy;
};

export type CaptiveSigningUrlParams = {
  signingUrl: string;
  envelopeId: string;
  recipientId?: string;
};

export type SigningStatus = 'completed' | 'cancelled' | 'error';

export type SigningResult = {
  status: SigningStatus;
  envelopeId: string;
  errorCode?: string;
  errorMessage?: string;
};

export type SigningCompleteEvent = {
  envelopeId: string;
};

export type SigningCancelledEvent = {
  envelopeId: string;
  reason?: string;
};

export type SigningErrorEvent = {
  envelopeId?: string;
  errorCode: string;
  errorMessage: string;
};

export type LoginAttemptEvent = {
  integratorKey: string;
  accountId: string;
  userId: string;
  userName: string;
  email: string;
  host: string;
};

export type DocuSignModuleEvents = {
  onSigningComplete: (event: SigningCompleteEvent) => void;
  onSigningCancelled: (event: SigningCancelledEvent) => void;
  onSigningError: (event: SigningErrorEvent) => void;
  onLoginAttempt: (event: LoginAttemptEvent) => void;
};
