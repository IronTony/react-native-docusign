import type { SigningErrorEvent } from './DocuSign.types';

/**
 * What failed. Stable across releases, so it is safe to branch on.
 *
 * `usage` codes mean the app called the package wrongly. The rest describe a
 * failure at runtime.
 */
export type DocuSignErrorCode =
  | 'initialize_failed'
  | 'not_initialized'
  | 'not_logged_in'
  | 'login_failed'
  | 'signing_in_progress'
  | 'invalid_signing_url'
  | 'presentation_failed'
  | 'signing_failed'
  | 'unexpected';

/**
 * Why it failed, set only from facts the package can verify. Anything else is
 * `unknown`. A later minor release may turn an `unknown` into a more specific
 * reason, so always handle `unknown`.
 */
export type DocuSignErrorReason =
  'usage' | 'network' | 'auth' | 'configuration' | 'recipient' | 'unknown';

export type DocuSignUnderlyingError = {
  domain?: string;
  code?: string;
  message?: string;
};

/**
 * Raw details from the platform. On iOS `domain` and `code` come from the
 * `NSError`, on Android `domain` is the exception class and `code` is the
 * DocuSign SDK error code when it provides one.
 */
export type DocuSignNativeErrorDetails = DocuSignUnderlyingError & {
  /**
   * The lower-level error behind the failure when known: `NSUnderlyingErrorKey`
   * on iOS, the root of the exception's cause chain on Android, or the transport
   * error of a request the package made itself.
   */
  underlying?: DocuSignUnderlyingError;
};

/** Present when an HTTP response is part of the failure. */
export type DocuSignHttpErrorDetails = {
  status: number;
  /** DocuSign's own error code from the response body, such as `UNKNOWN_ENVELOPE_RECIPIENT`. */
  docusignErrorCode?: string;
  docusignMessage?: string;
};

/**
 * Flat, primitive-only attributes for analytics and error reporting tools.
 * Low cardinality on purpose: no messages, so dashboards can group on every key.
 */
export type DocuSignErrorAttributes = {
  docusign_code: DocuSignErrorCode;
  docusign_reason: DocuSignErrorReason;
  docusign_envelope_id?: string;
  docusign_native_domain?: string;
  docusign_native_code?: string;
  docusign_underlying_domain?: string;
  docusign_underlying_code?: string;
  docusign_http_status?: number;
  docusign_api_error_code?: string;
};

export type DocuSignErrorInit = {
  code: DocuSignErrorCode;
  message: string;
  envelopeId?: string;
  native?: DocuSignNativeErrorDetails;
  http?: DocuSignHttpErrorDetails;
};

const USAGE_CODES: ReadonlySet<DocuSignErrorCode> = new Set([
  'not_initialized',
  'not_logged_in',
  'signing_in_progress',
  'invalid_signing_url',
  'presentation_failed',
]);

const KNOWN_CODES: ReadonlySet<string> = new Set<DocuSignErrorCode>([
  'initialize_failed',
  'not_initialized',
  'not_logged_in',
  'login_failed',
  'signing_in_progress',
  'invalid_signing_url',
  'presentation_failed',
  'signing_failed',
  'unexpected',
]);

const NETWORK_DOMAINS: ReadonlySet<string> = new Set([
  'NSURLErrorDomain',
  'java.net.UnknownHostException',
  'java.net.SocketTimeoutException',
  'java.net.ConnectException',
]);

const RECIPIENT_API_ERROR_CODES: ReadonlySet<string> = new Set([
  'UNKNOWN_ENVELOPE_RECIPIENT',
]);

const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const BEARER_PATTERN = /\bBearer\s+\S+/gi;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;
const TOKEN_LIKE_SEGMENT = /^[A-Za-z0-9_-]{20,}$/;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/**
 * Signing URLs carry a token in their path and query, and SDK messages can
 * echo a URL or a bearer token back. Keep the origin and short path segments so
 * a message still says which host failed, and drop everything token shaped.
 *
 * The URL match also takes punctuation that ends the sentence around it. That
 * is peeled off first, or a token segment followed by a period would fail the
 * token test and be left in place.
 */
function redactUrl(matched: string): string {
  const trailing = TRAILING_PUNCTUATION.exec(matched)?.[0] ?? '';
  const url = matched.slice(0, matched.length - trailing.length);
  const withoutQuery = url.split(/[?#]/)[0];
  const match = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(withoutQuery);
  if (!match) return `[redacted-url]${trailing}`;
  const [, origin, path = ''] = match;
  const segments = path
    .split('/')
    .map((segment) =>
      TOKEN_LIKE_SEGMENT.test(segment) ? '[redacted]' : segment,
    );
  return origin + segments.join('/') + trailing;
}

export function redactSecrets(text: string): string {
  return text
    .replace(JWT_PATTERN, '[redacted-token]')
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(URL_PATTERN, redactUrl);
}

function redactOptional(text: string | undefined): string | undefined {
  return text === undefined ? undefined : redactSecrets(text);
}

function isNetworkDomain(domain: string | undefined): boolean {
  return domain !== undefined && NETWORK_DOMAINS.has(domain);
}

/**
 * Order matters. A caller mistake outranks everything, and a transport failure
 * outranks an HTTP status seen earlier in the same flow, because the transport
 * failure is what actually stopped the call.
 */
export function deriveReason({
  code,
  native,
  http,
}: Pick<DocuSignErrorInit, 'code' | 'native' | 'http'>): DocuSignErrorReason {
  if (USAGE_CODES.has(code)) return 'usage';
  if (
    isNetworkDomain(native?.domain) ||
    isNetworkDomain(native?.underlying?.domain)
  ) {
    return 'network';
  }
  if (http?.status === 401 || http?.status === 403) return 'auth';
  if (
    code === 'login_failed' &&
    http &&
    http.status >= 200 &&
    http.status < 300
  ) {
    return 'configuration';
  }
  if (
    http?.docusignErrorCode &&
    RECIPIENT_API_ERROR_CODES.has(http.docusignErrorCode)
  ) {
    return 'recipient';
  }
  return 'unknown';
}

export class DocuSignError extends Error {
  readonly code: DocuSignErrorCode;
  readonly reason: DocuSignErrorReason;
  readonly envelopeId?: string;
  readonly native?: DocuSignNativeErrorDetails;
  readonly http?: DocuSignHttpErrorDetails;

  constructor(init: DocuSignErrorInit) {
    super(redactSecrets(init.message));
    // Babel's class transform breaks `instanceof` for Error subclasses unless
    // the prototype is restored explicitly.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'DocuSignError';
    this.code = init.code;
    this.envelopeId = init.envelopeId;
    this.native = init.native && {
      ...init.native,
      message: redactOptional(init.native.message),
      underlying: init.native.underlying && {
        ...init.native.underlying,
        message: redactOptional(init.native.underlying.message),
      },
    };
    this.http = init.http && {
      ...init.http,
      docusignMessage: redactOptional(init.http.docusignMessage),
    };
    this.reason = deriveReason({
      code: init.code,
      native: this.native,
      http: this.http,
    });
  }

  toAttributes(): DocuSignErrorAttributes {
    const attributes: DocuSignErrorAttributes = {
      docusign_code: this.code,
      docusign_reason: this.reason,
    };
    if (this.envelopeId) attributes.docusign_envelope_id = this.envelopeId;
    if (this.native?.domain)
      attributes.docusign_native_domain = this.native.domain;
    if (this.native?.code) attributes.docusign_native_code = this.native.code;
    if (this.native?.underlying?.domain) {
      attributes.docusign_underlying_domain = this.native.underlying.domain;
    }
    if (this.native?.underlying?.code) {
      attributes.docusign_underlying_code = this.native.underlying.code;
    }
    if (this.http) attributes.docusign_http_status = this.http.status;
    if (this.http?.docusignErrorCode) {
      attributes.docusign_api_error_code = this.http.docusignErrorCode;
    }
    return attributes;
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toKnownCode(value: unknown): DocuSignErrorCode {
  return typeof value === 'string' && KNOWN_CODES.has(value)
    ? (value as DocuSignErrorCode)
    : 'unexpected';
}

/** Builds the error from the failure payload native code resolves with. */
export function fromFailurePayload(payload: SigningErrorEvent): DocuSignError {
  const underlying: DocuSignUnderlyingError | undefined =
    payload.underlyingDomain ||
    payload.underlyingCode ||
    payload.underlyingMessage
      ? {
          domain: nonEmpty(payload.underlyingDomain),
          code: nonEmpty(payload.underlyingCode),
          message: nonEmpty(payload.underlyingMessage),
        }
      : undefined;

  const hasNative =
    payload.nativeDomain ||
    payload.nativeCode ||
    payload.nativeMessage ||
    underlying;

  return new DocuSignError({
    code: toKnownCode(payload.errorCode),
    message: nonEmpty(payload.errorMessage) ?? 'DocuSign operation failed',
    envelopeId: nonEmpty(payload.envelopeId),
    native: hasNative
      ? {
          domain: nonEmpty(payload.nativeDomain),
          code: nonEmpty(payload.nativeCode),
          message: nonEmpty(payload.nativeMessage),
          underlying,
        }
      : undefined,
    http:
      typeof payload.httpStatus === 'number'
        ? {
            status: payload.httpStatus,
            docusignErrorCode: nonEmpty(payload.docusignErrorCode),
            docusignMessage: nonEmpty(payload.docusignMessage),
          }
        : undefined,
  });
}

/**
 * Normalises anything thrown into a `DocuSignError`. Native rejections arrive
 * as an Error carrying only `code` and `message`, because the Expo bridge drops
 * everything else.
 */
export function toDocuSignError(value: unknown): DocuSignError {
  if (value instanceof DocuSignError) return value;
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code;
    const knownCode = toKnownCode(code);
    return new DocuSignError({
      code: knownCode,
      message: value.message,
      native:
        knownCode === 'unexpected' && typeof code === 'string'
          ? { code, message: value.message }
          : undefined,
    });
  }
  return new DocuSignError({ code: 'unexpected', message: String(value) });
}
