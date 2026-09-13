import { describe, expect, it } from '@jest/globals';

import {
  DocuSignError,
  deriveReason,
  fromFailurePayload,
  redactSecrets,
  toDocuSignError,
} from './DocuSignError';

describe('deriveReason', () => {
  it.each([
    'not_initialized',
    'not_logged_in',
    'signing_in_progress',
    'invalid_signing_url',
    'presentation_failed',
  ] as const)('classifies %s as usage', (code) => {
    expect(deriveReason({ code })).toBe('usage');
  });

  it('classifies an iOS URL loading error as network', () => {
    expect(
      deriveReason({
        code: 'signing_failed',
        native: { domain: 'NSURLErrorDomain', code: '-1005' },
      }),
    ).toBe('network');
  });

  it('classifies a network error found in the underlying error as network', () => {
    expect(
      deriveReason({
        code: 'signing_failed',
        native: {
          domain: 'com.docusign.androidsdk.exceptions.DSSigningException',
          underlying: { domain: 'java.net.UnknownHostException' },
        },
      }),
    ).toBe('network');
  });

  it.each([
    'java.net.UnknownHostException',
    'java.net.SocketTimeoutException',
    'java.net.ConnectException',
  ])('classifies Android %s as network', (domain) => {
    expect(deriveReason({ code: 'signing_failed', native: { domain } })).toBe(
      'network',
    );
  });

  it('prefers network over an HTTP status seen earlier in the flow', () => {
    expect(
      deriveReason({
        code: 'signing_failed',
        native: { domain: 'NSURLErrorDomain' },
        http: { status: 401 },
      }),
    ).toBe('network');
  });

  it.each([401, 403])('classifies HTTP %i as auth', (status) => {
    expect(deriveReason({ code: 'login_failed', http: { status } })).toBe(
      'auth',
    );
  });

  it('classifies a login rejected despite a valid token as configuration', () => {
    expect(deriveReason({ code: 'login_failed', http: { status: 200 } })).toBe(
      'configuration',
    );
  });

  it('does not call a successful HTTP status configuration outside login', () => {
    expect(
      deriveReason({ code: 'signing_failed', http: { status: 200 } }),
    ).toBe('unknown');
  });

  it('classifies an unknown envelope recipient as recipient', () => {
    expect(
      deriveReason({
        code: 'signing_failed',
        http: { status: 400, docusignErrorCode: 'UNKNOWN_ENVELOPE_RECIPIENT' },
      }),
    ).toBe('recipient');
  });

  it('falls back to unknown when no fact identifies the cause', () => {
    expect(
      deriveReason({
        code: 'signing_failed',
        native: { domain: 'DocuSignSDK', code: '1001' },
        http: { status: 500, docusignErrorCode: 'SOMETHING_ELSE' },
      }),
    ).toBe('unknown');
  });
});

describe('redactSecrets', () => {
  it('redacts a JWT', () => {
    expect(
      redactSecrets(
        'token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl was rejected',
      ),
    ).toBe('token [redacted-token] was rejected');
  });

  it('redacts a bearer credential', () => {
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: Bearer [redacted]',
    );
  });

  it('keeps the origin and short path of a URL but drops the query and token-like segments', () => {
    expect(
      redactSecrets(
        'failed to load https://demo.docusign.net/Signing/MTRedeem/v1/4b5c7d9e-1f2a-4b3c-8d9e-0f1a2b3c4d5e?slt=abc',
      ),
    ).toBe(
      'failed to load https://demo.docusign.net/Signing/MTRedeem/v1/[redacted]',
    );
  });

  it.each([
    ['a period', '.'],
    ['a comma', ','],
    ['a closing parenthesis', ')'],
    ['several punctuation marks', ').'],
  ])(
    'redacts a token segment followed by %s and keeps the punctuation',
    (_label, punctuation) => {
      expect(
        redactSecrets(
          `blocked by https://account.docusign.com/o/abcdefghijklmnopqrstuvwxyz0123456789${punctuation} Try again`,
        ),
      ).toBe(
        `blocked by https://account.docusign.com/o/[redacted]${punctuation} Try again`,
      );
    },
  );

  it('drops a query that is followed by punctuation', () => {
    expect(
      redactSecrets('open https://demo.docusign.net/Signing?slt=abc123.'),
    ).toBe('open https://demo.docusign.net/Signing.');
  });

  it('keeps punctuation after a URL that has no path', () => {
    expect(redactSecrets('host was https://demo.docusign.net.')).toBe(
      'host was https://demo.docusign.net.',
    );
  });

  it('leaves a plain REST root readable', () => {
    expect(redactSecrets('host=https://demo.docusign.net/restapi')).toBe(
      'host=https://demo.docusign.net/restapi',
    );
  });

  it('leaves text without secrets unchanged', () => {
    expect(redactSecrets('The network connection was lost.')).toBe(
      'The network connection was lost.',
    );
  });
});

describe('DocuSignError', () => {
  it('is an Error with a stable name', () => {
    const error = new DocuSignError({
      code: 'signing_failed',
      message: 'boom',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DocuSignError);
    expect(error.name).toBe('DocuSignError');
    expect(error.message).toBe('boom');
  });

  it('redacts secrets in every message field', () => {
    const error = new DocuSignError({
      code: 'signing_failed',
      message: 'Bearer secret-token',
      native: {
        message: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln',
        underlying: {
          message: 'https://demo.docusign.net/x?token=abc',
        },
      },
      http: { status: 400, docusignMessage: 'Bearer another' },
    });

    expect(error.message).toBe('Bearer [redacted]');
    expect(error.native?.message).toBe('[redacted-token]');
    expect(error.native?.underlying?.message).toBe(
      'https://demo.docusign.net/x',
    );
    expect(error.http?.docusignMessage).toBe('Bearer [redacted]');
  });

  it('derives its reason from the facts it was built with', () => {
    const error = new DocuSignError({
      code: 'login_failed',
      message: 'rejected',
      http: { status: 401 },
    });

    expect(error.reason).toBe('auth');
  });

  it('flattens every known fact into attributes', () => {
    const error = new DocuSignError({
      code: 'signing_failed',
      message: 'failed',
      envelopeId: 'env-1',
      native: {
        domain: 'NSURLErrorDomain',
        code: '-1005',
        message: 'lost',
        underlying: { domain: 'kCFErrorDomainCFNetwork', code: '-1005' },
      },
      http: { status: 400, docusignErrorCode: 'UNKNOWN_ENVELOPE_RECIPIENT' },
    });

    expect(error.toAttributes()).toEqual({
      docusign_code: 'signing_failed',
      docusign_reason: 'network',
      docusign_envelope_id: 'env-1',
      docusign_native_domain: 'NSURLErrorDomain',
      docusign_native_code: '-1005',
      docusign_underlying_domain: 'kCFErrorDomainCFNetwork',
      docusign_underlying_code: '-1005',
      docusign_http_status: 400,
      docusign_api_error_code: 'UNKNOWN_ENVELOPE_RECIPIENT',
    });
  });

  it('omits attributes it has no value for', () => {
    const error = new DocuSignError({
      code: 'not_initialized',
      message: 'init',
    });

    expect(error.toAttributes()).toEqual({
      docusign_code: 'not_initialized',
      docusign_reason: 'usage',
    });
  });
});

describe('fromFailurePayload', () => {
  it('builds native and http details from the flat native payload', () => {
    const error = fromFailurePayload({
      errorCode: 'login_failed',
      errorMessage: 'DocuSign rejected a valid access token.',
      nativeDomain: 'DocuSign',
      nativeCode: '7',
      nativeMessage: 'unauthorized',
      underlyingDomain: 'NSURLErrorDomain',
      underlyingCode: '-1009',
      underlyingMessage: 'offline',
      httpStatus: 200,
      docusignErrorCode: 'invalid_grant',
      docusignMessage: 'expired',
    });

    expect(error.code).toBe('login_failed');
    expect(error.native).toEqual({
      domain: 'DocuSign',
      code: '7',
      message: 'unauthorized',
      underlying: {
        domain: 'NSURLErrorDomain',
        code: '-1009',
        message: 'offline',
      },
    });
    expect(error.http).toEqual({
      status: 200,
      docusignErrorCode: 'invalid_grant',
      docusignMessage: 'expired',
    });
    expect(error.reason).toBe('network');
  });

  it('leaves native and http undefined when the payload carries no details', () => {
    const error = fromFailurePayload({
      errorCode: 'signing_failed',
      errorMessage: 'failed',
      envelopeId: 'env-1',
    });

    expect(error.native).toBeUndefined();
    expect(error.http).toBeUndefined();
    expect(error.envelopeId).toBe('env-1');
  });

  it('maps a code it does not know to unexpected', () => {
    const error = fromFailurePayload({
      errorCode: 'something_new',
      errorMessage: 'x',
    });

    expect(error.code).toBe('unexpected');
  });

  it('falls back to a generic message when native sends an empty one', () => {
    const error = fromFailurePayload({
      errorCode: 'signing_failed',
      errorMessage: '',
    });

    expect(error.message).toBe('DocuSign operation failed');
  });
});

describe('toDocuSignError', () => {
  it('returns a DocuSignError unchanged', () => {
    const original = new DocuSignError({
      code: 'signing_failed',
      message: 'x',
    });

    expect(toDocuSignError(original)).toBe(original);
  });

  it('keeps a known code from a native rejection', () => {
    const rejection = Object.assign(new Error('Call initialize() first.'), {
      code: 'not_initialized',
    });

    const error = toDocuSignError(rejection);

    expect(error.code).toBe('not_initialized');
    expect(error.reason).toBe('usage');
    expect(error.message).toBe('Call initialize() first.');
    expect(error.native).toBeUndefined();
  });

  it('keeps an unknown native code under native so it is not lost', () => {
    const rejection = Object.assign(new Error('bad argument'), {
      code: 'ERR_ARGUMENT_CAST',
    });

    const error = toDocuSignError(rejection);

    expect(error.code).toBe('unexpected');
    expect(error.native).toEqual({
      code: 'ERR_ARGUMENT_CAST',
      message: 'bad argument',
    });
  });

  it('wraps an Error without a code as unexpected', () => {
    const error = toDocuSignError(new Error('plain'));

    expect(error.code).toBe('unexpected');
    expect(error.native).toBeUndefined();
  });

  it('wraps a non-Error value', () => {
    const error = toDocuSignError('raw string');

    expect(error.code).toBe('unexpected');
    expect(error.message).toBe('raw string');
  });
});
