import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import * as api from './api';
import { SIGNING_STATE, useDocuSignSigning } from './useDocuSignSigning';

jest.mock('./api', () => ({
  __esModule: true,
  initialize: jest.fn(),
  loginWithAccessToken: jest.fn(),
  presentCaptiveSigning: jest.fn(),
  presentCaptiveSigningWithUrl: jest.fn(),
  endSigningSession: jest.fn(),
  reset: jest.fn(),
  addSigningErrorListener: jest.fn(() => ({ remove: jest.fn() })),
}));

const config = {
  integratorKey: 'test-key',
  environment: 'demo' as const,
};

const mockedApi = api as jest.Mocked<typeof api>;

beforeEach(() => {
  jest.clearAllMocks();
  mockedApi.initialize.mockResolvedValue(undefined);
  mockedApi.loginWithAccessToken.mockResolvedValue({
    accountId: 'a',
    userId: 'u',
    userName: 'name',
    email: 'e@example.com',
  });
  mockedApi.presentCaptiveSigning.mockResolvedValue({
    status: 'completed',
    envelopeId: 'env-1',
  });
  mockedApi.presentCaptiveSigningWithUrl.mockResolvedValue({
    status: 'completed',
    envelopeId: 'env-1',
  });
  mockedApi.endSigningSession.mockResolvedValue(undefined);
  mockedApi.addSigningErrorListener.mockReturnValue({ remove: jest.fn() });
});

describe('useDocuSignSigning', () => {
  it('auto-initializes and transitions idle -> initializing -> ready', async () => {
    const { result } = renderHook(() => useDocuSignSigning({ config }));

    await waitFor(() => {
      expect(result.current.state).toBe(SIGNING_STATE.READY);
    });
    expect(mockedApi.initialize).toHaveBeenCalledWith(config);
    expect(mockedApi.initialize).toHaveBeenCalledTimes(1);
  });

  it('does not auto-initialize when autoInitialize is false', async () => {
    const { result } = renderHook(() =>
      useDocuSignSigning({ config, autoInitialize: false }),
    );

    expect(result.current.state).toBe(SIGNING_STATE.IDLE);
    expect(mockedApi.initialize).not.toHaveBeenCalled();
  });

  it('drives session-flow signing through ready -> preparing -> signing -> completed', async () => {
    const { result } = renderHook(() => useDocuSignSigning({ config }));

    await waitFor(() => {
      expect(result.current.state).toBe(SIGNING_STATE.READY);
    });

    await act(async () => {
      await result.current.startSigning({
        type: 'session',
        accessToken: 'token',
        envelopeId: 'env-1',
        recipientUserName: 'r',
        recipientEmail: 'r@example.com',
        recipientClientUserId: 'client-1',
      });
    });

    expect(mockedApi.loginWithAccessToken).toHaveBeenCalledTimes(1);
    expect(mockedApi.presentCaptiveSigning).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe(SIGNING_STATE.COMPLETED);
    expect(result.current.result).toEqual({
      status: 'completed',
      envelopeId: 'env-1',
    });
  });

  it('routes url-flow signing through presentCaptiveSigningWithUrl without login', async () => {
    const { result } = renderHook(() => useDocuSignSigning({ config }));

    await waitFor(() => {
      expect(result.current.state).toBe(SIGNING_STATE.READY);
    });

    await act(async () => {
      await result.current.startSigning({
        type: 'url',
        signingUrl: 'https://example.com/sign',
        envelopeId: 'env-2',
      });
    });

    expect(mockedApi.loginWithAccessToken).not.toHaveBeenCalled();
    expect(mockedApi.presentCaptiveSigningWithUrl).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe(SIGNING_STATE.COMPLETED);
  });

  it('captures cancelled outcome into state', async () => {
    mockedApi.presentCaptiveSigning.mockResolvedValue({
      status: 'cancelled',
      envelopeId: 'env-1',
    });

    const { result } = renderHook(() => useDocuSignSigning({ config }));

    await waitFor(() => {
      expect(result.current.state).toBe(SIGNING_STATE.READY);
    });

    await act(async () => {
      await result.current.startSigning({
        type: 'session',
        accessToken: 'token',
        envelopeId: 'env-1',
        recipientUserName: 'r',
        recipientEmail: 'r@example.com',
        recipientClientUserId: 'client-1',
      });
    });

    expect(result.current.state).toBe(SIGNING_STATE.CANCELLED);
  });

  it('captures error outcome into state and rethrows', async () => {
    const failure = new Error('SDK rejected token');
    mockedApi.loginWithAccessToken.mockRejectedValue(failure);

    const { result } = renderHook(() => useDocuSignSigning({ config }));

    await waitFor(() => {
      expect(result.current.state).toBe(SIGNING_STATE.READY);
    });

    await act(async () => {
      await expect(
        result.current.startSigning({
          type: 'session',
          accessToken: 'token',
          envelopeId: 'env-1',
          recipientUserName: 'r',
          recipientEmail: 'r@example.com',
          recipientClientUserId: 'client-1',
        }),
      ).rejects.toThrow(failure);
    });

    expect(result.current.state).toBe(SIGNING_STATE.ERROR);
    expect(result.current.error).toBe(failure);
  });

  it('reset() calls endSigningSession when initialized and returns to ready', async () => {
    const { result } = renderHook(() => useDocuSignSigning({ config }));

    await waitFor(() => {
      expect(result.current.state).toBe(SIGNING_STATE.READY);
    });

    act(() => {
      result.current.reset();
    });

    await waitFor(() => {
      expect(mockedApi.endSigningSession).toHaveBeenCalledTimes(1);
    });
    expect(result.current.state).toBe(SIGNING_STATE.READY);
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBeNull();
  });

  it('reset() does NOT call endSigningSession when never initialized', async () => {
    const { result } = renderHook(() =>
      useDocuSignSigning({ config, autoInitialize: false }),
    );

    act(() => {
      result.current.reset();
    });

    expect(mockedApi.endSigningSession).not.toHaveBeenCalled();
    expect(result.current.state).toBe(SIGNING_STATE.IDLE);
  });

  it('subscribes to signing errors and surfaces them into error state', async () => {
    let listener:
      | ((event: { errorCode: string; errorMessage: string }) => void)
      | undefined;
    mockedApi.addSigningErrorListener.mockImplementation((cb) => {
      listener = cb;
      return { remove: jest.fn() };
    });

    const { result } = renderHook(() => useDocuSignSigning({ config }));

    await waitFor(() => {
      expect(result.current.state).toBe(SIGNING_STATE.READY);
    });

    act(() => {
      listener?.({ errorCode: 'signing_failed', errorMessage: 'boom' });
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('signing_failed: boom');
  });

  it('removes the error listener on unmount', () => {
    const remove = jest.fn();
    mockedApi.addSigningErrorListener.mockReturnValue({ remove });

    const { unmount } = renderHook(() =>
      useDocuSignSigning({ config, autoInitialize: false }),
    );

    unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('captures initialization failure into error state', async () => {
    const failure = new Error('init failed');
    mockedApi.initialize.mockRejectedValue(failure);

    const { result } = renderHook(() => useDocuSignSigning({ config }));

    await waitFor(() => {
      expect(result.current.state).toBe(SIGNING_STATE.ERROR);
    });
    expect(result.current.error).toBe(failure);
  });

  it('routes a SigningResult with status "error" into the ERROR state', async () => {
    mockedApi.presentCaptiveSigning.mockResolvedValue({
      status: 'error',
      envelopeId: 'env-1',
      errorCode: 'signing_failed',
      errorMessage: 'SDK rejected envelope',
    });

    const { result } = renderHook(() => useDocuSignSigning({ config }));

    await waitFor(() => {
      expect(result.current.state).toBe(SIGNING_STATE.READY);
    });

    await act(async () => {
      await result.current.startSigning({
        type: 'session',
        accessToken: 'token',
        envelopeId: 'env-1',
        recipientUserName: 'r',
        recipientEmail: 'r@example.com',
        recipientClientUserId: 'client-1',
      });
    });

    expect(result.current.state).toBe(SIGNING_STATE.ERROR);
    expect(result.current.result?.status).toBe('error');
  });

  it('startSigning auto-initializes when called before init completes', async () => {
    const { result } = renderHook(() =>
      useDocuSignSigning({ config, autoInitialize: false }),
    );

    expect(result.current.state).toBe(SIGNING_STATE.IDLE);
    expect(mockedApi.initialize).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.startSigning({
        type: 'session',
        accessToken: 'token',
        envelopeId: 'env-1',
        recipientUserName: 'r',
        recipientEmail: 'r@example.com',
        recipientClientUserId: 'client-1',
      });
    });

    expect(mockedApi.initialize).toHaveBeenCalledTimes(1);
    expect(mockedApi.presentCaptiveSigning).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe(SIGNING_STATE.COMPLETED);
  });
});
