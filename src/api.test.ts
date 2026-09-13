import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

import { DocuSignError } from './DocuSignError';
import DocuSignModule from './DocuSignModule';
import {
  addLoginAttemptListener,
  addSigningCancelledListener,
  addSigningCompleteListener,
  addSigningErrorListener,
  DocuSignErrorListener,
  endSigningSession,
  initialize,
  isLoggedIn,
  loginWithAccessToken,
  logout,
  presentCaptiveSigning,
  presentCaptiveSigningWithUrl,
  reset,
} from './api';

const nativeModule = jest.mocked(DocuSignModule);

const sessionParams = {
  envelopeId: 'env-1',
  recipientUserName: 'Recipient',
  recipientEmail: 'recipient@example.com',
  recipientClientUserId: 'client-1',
};

const urlParams = {
  signingUrl: 'https://demo.docusign.net/signing/example',
  envelopeId: 'env-2',
  recipientId: 'recipient-id',
};

const account = {
  accountId: 'account-1',
  userId: 'user-1',
  userName: 'User',
  email: 'user@example.com',
};

const nativeRejection = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

const captureRejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

let warn: jest.SpiedFunction<typeof console.warn>;
let subscriptions: { remove(): void }[] = [];

const listen = (listener: DocuSignErrorListener) => {
  const subscription = addSigningErrorListener(listener);
  subscriptions.push(subscription);
  return subscription;
};

beforeEach(() => {
  jest.clearAllMocks();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  subscriptions.forEach((subscription) => subscription.remove());
  subscriptions = [];
  warn.mockRestore();
});

describe('presentCaptiveSigning', () => {
  it('resolves a completed outcome without the native extras', async () => {
    nativeModule.presentCaptiveSigning.mockResolvedValue({
      status: 'completed',
      envelopeId: 'env-1',
      errorCode: null,
      errorMessage: null,
    });

    await expect(presentCaptiveSigning(sessionParams)).resolves.toEqual({
      status: 'completed',
      envelopeId: 'env-1',
    });
    expect(nativeModule.presentCaptiveSigning).toHaveBeenCalledWith(
      sessionParams,
    );
  });

  it('keeps the cancel reason on a cancelled outcome', async () => {
    nativeModule.presentCaptiveSigning.mockResolvedValue({
      status: 'cancelled',
      envelopeId: 'env-1',
      errorMessage: 'session_ended',
    });

    await expect(presentCaptiveSigning(sessionParams)).resolves.toEqual({
      status: 'cancelled',
      envelopeId: 'env-1',
      errorMessage: 'session_ended',
    });
  });

  it('keeps an error code that native sends on a resolved outcome', async () => {
    nativeModule.presentCaptiveSigning.mockResolvedValue({
      status: 'cancelled',
      envelopeId: 'env-1',
      errorCode: 'exit',
    });

    await expect(presentCaptiveSigning(sessionParams)).resolves.toEqual({
      status: 'cancelled',
      envelopeId: 'env-1',
      errorCode: 'exit',
    });
  });

  it('rejects with a DocuSignError built from a failure outcome', async () => {
    nativeModule.presentCaptiveSigning.mockResolvedValue({
      status: 'error',
      envelopeId: 'env-1',
      errorCode: 'signing_failed',
      errorMessage: 'DocuSign ended the signing ceremony with an error.',
      nativeDomain: 'NSURLErrorDomain',
      nativeCode: '-1005',
    });

    const error = await captureRejection(presentCaptiveSigning(sessionParams));

    expect(error).toBeInstanceOf(DocuSignError);
    expect(error).toMatchObject({
      code: 'signing_failed',
      reason: 'network',
      envelopeId: 'env-1',
      native: { domain: 'NSURLErrorDomain', code: '-1005' },
    });
  });

  it('rejects with a usage DocuSignError when native rejects a caller mistake', async () => {
    nativeModule.presentCaptiveSigning.mockRejectedValue(
      nativeRejection('not_logged_in', 'Call loginWithAccessToken() first.'),
    );

    const error = await captureRejection(presentCaptiveSigning(sessionParams));

    expect(error).toBeInstanceOf(DocuSignError);
    expect(error).toMatchObject({ code: 'not_logged_in', reason: 'usage' });
  });
});

describe('presentCaptiveSigningWithUrl', () => {
  it('delegates to the native module and resolves its outcome', async () => {
    nativeModule.presentCaptiveSigningWithUrl.mockResolvedValue({
      status: 'completed',
      envelopeId: 'env-2',
    });

    await expect(presentCaptiveSigningWithUrl(urlParams)).resolves.toEqual({
      status: 'completed',
      envelopeId: 'env-2',
    });
    expect(nativeModule.presentCaptiveSigningWithUrl).toHaveBeenCalledWith(
      urlParams,
    );
  });

  it('rejects with invalid_signing_url when native refuses the URL', async () => {
    nativeModule.presentCaptiveSigningWithUrl.mockRejectedValue(
      nativeRejection(
        'invalid_signing_url',
        'signingUrl must be a non-empty https URL.',
      ),
    );

    const error = await captureRejection(
      presentCaptiveSigningWithUrl(urlParams),
    );

    expect(error).toMatchObject({
      code: 'invalid_signing_url',
      reason: 'usage',
    });
  });
});

describe('loginWithAccessToken', () => {
  it('resolves the account from a success outcome', async () => {
    nativeModule.loginWithAccessToken.mockResolvedValue({
      status: 'success',
      account,
    });

    await expect(
      loginWithAccessToken({ accessToken: 'token' }),
    ).resolves.toEqual(account);
  });

  it('rejects with auth when the userinfo check returned 401', async () => {
    nativeModule.loginWithAccessToken.mockResolvedValue({
      status: 'error',
      errorCode: 'login_failed',
      errorMessage: 'DocuSign rejected the access token.',
      httpStatus: 401,
    });

    const error = await captureRejection(
      loginWithAccessToken({ accessToken: 'token' }),
    );

    expect(error).toMatchObject({
      code: 'login_failed',
      reason: 'auth',
      http: { status: 401 },
    });
  });
});

describe('initialize', () => {
  it('resolves when native resolves', async () => {
    nativeModule.initialize.mockResolvedValue(undefined);

    await expect(
      initialize({ integratorKey: 'key', environment: 'demo' }),
    ).resolves.toBeUndefined();
  });

  it('rejects with a DocuSignError when native rejects', async () => {
    nativeModule.initialize.mockRejectedValue(
      nativeRejection('initialize_failed', 'Invalid DocuSign host URL.'),
    );

    const error = await captureRejection(
      initialize({ integratorKey: 'key', environment: 'demo' }),
    );

    expect(error).toMatchObject({
      code: 'initialize_failed',
      reason: 'unknown',
    });
  });
});

describe('addSigningErrorListener', () => {
  it('delivers the same error the caller receives, exactly once', async () => {
    const listener = jest.fn<DocuSignErrorListener>();
    listen(listener);
    nativeModule.presentCaptiveSigning.mockResolvedValue({
      status: 'error',
      envelopeId: 'env-1',
      errorCode: 'signing_failed',
      errorMessage: 'failed',
    });

    const error = await captureRejection(presentCaptiveSigning(sessionParams));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(error);
  });

  it('delivers caller mistakes too', async () => {
    const listener = jest.fn<DocuSignErrorListener>();
    listen(listener);
    nativeModule.presentCaptiveSigning.mockRejectedValue(
      nativeRejection('not_initialized', 'Call initialize() first.'),
    );

    await captureRejection(presentCaptiveSigning(sessionParams));

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'not_initialized', reason: 'usage' }),
    );
  });

  it('stops delivering after remove', async () => {
    const listener = jest.fn<DocuSignErrorListener>();
    listen(listener).remove();
    nativeModule.presentCaptiveSigning.mockRejectedValue(
      nativeRejection('not_initialized', 'Call initialize() first.'),
    );

    await captureRejection(presentCaptiveSigning(sessionParams));

    expect(listener).not.toHaveBeenCalled();
  });

  it('still rejects with the original error when a listener throws', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    listen(() => {
      throw new Error('broken logger');
    });
    nativeModule.presentCaptiveSigning.mockRejectedValue(
      nativeRejection('not_initialized', 'Call initialize() first.'),
    );

    const error = await captureRejection(presentCaptiveSigning(sessionParams));

    expect(error).toMatchObject({ code: 'not_initialized' });
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe('session teardown and state', () => {
  it('delegates logout to the native module', async () => {
    nativeModule.logout.mockResolvedValue(undefined);

    await logout();

    expect(nativeModule.logout).toHaveBeenCalledTimes(1);
  });

  it('returns the native login state', async () => {
    nativeModule.isLoggedIn.mockResolvedValue(true);

    await expect(isLoggedIn()).resolves.toBe(true);
  });

  it('delegates endSigningSession to the native module', async () => {
    nativeModule.endSigningSession.mockResolvedValue(undefined);

    await endSigningSession();

    expect(nativeModule.endSigningSession).toHaveBeenCalledTimes(1);
  });

  it('delegates reset to the native module', async () => {
    nativeModule.reset.mockResolvedValue(undefined);

    await reset();

    expect(nativeModule.reset).toHaveBeenCalledTimes(1);
  });
});

describe('native event listeners', () => {
  it.each([
    ['onSigningComplete', addSigningCompleteListener],
    ['onSigningCancelled', addSigningCancelledListener],
    ['onLoginAttempt', addLoginAttemptListener],
  ] as const)('subscribes %s on the native module', (eventName, subscribe) => {
    const listener = jest.fn();

    subscribe(listener);

    expect(nativeModule.addListener).toHaveBeenCalledWith(eventName, listener);
  });
});

describe('development warning', () => {
  it('warns once for a usage error, naming the code and the fix', async () => {
    nativeModule.presentCaptiveSigning.mockRejectedValue(
      nativeRejection('not_initialized', 'Call initialize() first.'),
    );

    await captureRejection(presentCaptiveSigning(sessionParams));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[react-native-docusign] not_initialized: Call initialize() first.',
    );
  });

  it('does not warn for a runtime failure', async () => {
    nativeModule.presentCaptiveSigning.mockResolvedValue({
      status: 'error',
      envelopeId: 'env-1',
      errorCode: 'signing_failed',
      errorMessage: 'failed',
    });

    await captureRejection(presentCaptiveSigning(sessionParams));

    expect(warn).not.toHaveBeenCalled();
  });
});
