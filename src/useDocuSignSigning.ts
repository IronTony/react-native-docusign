import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CaptiveSigningParams,
  CaptiveSigningUrlParams,
  DocuSignAuthParams,
  DocuSignConfig,
  SigningResult,
} from './DocuSign.types';
import {
  addSigningErrorListener,
  endSigningSession,
  initialize,
  loginWithAccessToken,
  presentCaptiveSigning,
  presentCaptiveSigningWithUrl,
} from './api';

export const SIGNING_STATE = {
  IDLE: 'idle',
  INITIALIZING: 'initializing',
  READY: 'ready',
  PREPARING: 'preparing',
  SIGNING: 'signing',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  ERROR: 'error',
} as const;

export type DocuSignSigningState =
  (typeof SIGNING_STATE)[keyof typeof SIGNING_STATE];

export type SigningSessionWithAuth = DocuSignAuthParams &
  CaptiveSigningParams & { type: 'session' };

export type SigningSessionWithUrl = CaptiveSigningUrlParams & { type: 'url' };

export type SigningSession = SigningSessionWithAuth | SigningSessionWithUrl;

function stateForResult(status: SigningResult['status']): DocuSignSigningState {
  if (status === 'completed') return SIGNING_STATE.COMPLETED;
  if (status === 'cancelled') return SIGNING_STATE.CANCELLED;
  return SIGNING_STATE.ERROR;
}

export type UseDocuSignSigningOptions = {
  /**
   * DocuSign configuration. Pass a stable reference (module-level constant or
   * `useMemo`-wrapped object). A new object identity on every render will
   * re-trigger initialization unless React Compiler memoization is active.
   */
  config: DocuSignConfig;
  autoInitialize?: boolean;
};

export type UseDocuSignSigningReturn = {
  state: DocuSignSigningState;
  error: Error | null;
  result: SigningResult | null;
  initialize: () => Promise<void>;
  startSigning: (session: SigningSession) => Promise<SigningResult>;
  reset: () => void;
};

export function useDocuSignSigning(
  options: UseDocuSignSigningOptions,
): UseDocuSignSigningReturn {
  const { config, autoInitialize = true } = options;

  const [state, setState] = useState<DocuSignSigningState>(SIGNING_STATE.IDLE);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<SigningResult | null>(null);
  const initializedRef = useRef(false);

  const doInitialize = useCallback(async () => {
    if (initializedRef.current) return;
    setState(SIGNING_STATE.INITIALIZING);
    setError(null);
    try {
      await initialize(config);
      initializedRef.current = true;
      setState(SIGNING_STATE.READY);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      setState(SIGNING_STATE.ERROR);
      throw err;
    }
  }, [config]);

  useEffect(
    function autoInitializeSdk() {
      if (!autoInitialize) return;
      // doInitialize sets state on its first line, so react-hooks flags this as a
      // synchronous setState in an effect. It is deliberate: the effect exists to
      // bring an external system (the DocuSign SDK) up, and the state transition
      // to INITIALIZING is how that progress is reported. The cost is one extra
      // render on mount, which is the intended behaviour rather than a cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      doInitialize().catch(() => {
        // error already captured into hook state
      });
    },
    [autoInitialize, doInitialize],
  );

  useEffect(function attachErrorListener() {
    const errorSub = addSigningErrorListener((event) => {
      setError(new Error(`${event.errorCode}: ${event.errorMessage}`));
    });
    return () => {
      errorSub.remove();
    };
  }, []);

  const startSigning = useCallback(
    async (session: SigningSession): Promise<SigningResult> => {
      try {
        if (!initializedRef.current) {
          await doInitialize();
        }

        setState(SIGNING_STATE.PREPARING);
        setError(null);
        setResult(null);

        let signingResult: SigningResult;

        if (session.type === 'url') {
          setState(SIGNING_STATE.SIGNING);
          signingResult = await presentCaptiveSigningWithUrl({
            signingUrl: session.signingUrl,
            envelopeId: session.envelopeId,
            recipientId: session.recipientId,
          });
        } else {
          await loginWithAccessToken({
            accessToken: session.accessToken,
            accountId: session.accountId,
            userId: session.userId,
            userName: session.userName,
            email: session.email,
            host: session.host,
          });

          setState(SIGNING_STATE.SIGNING);
          signingResult = await presentCaptiveSigning({
            envelopeId: session.envelopeId,
            recipientUserName: session.recipientUserName,
            recipientEmail: session.recipientEmail,
            recipientClientUserId: session.recipientClientUserId,
          });
        }

        setResult(signingResult);
        setState(stateForResult(signingResult.status));
        return signingResult;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        setState(SIGNING_STATE.ERROR);
        throw err;
      }
    },
    [doInitialize],
  );

  const reset = useCallback(() => {
    if (initializedRef.current) {
      // Tear down any in-flight signing session and SDK auth state so the
      // next startSigning starts clean. Fire-and-forget so reset stays
      // synchronous from the caller's perspective; errors here are
      // recoverable (consumer can retry startSigning). `void` marks the
      // unawaited promise deliberately rather than by omission.
      // eslint-disable-next-line no-void
      void endSigningSession().catch(() => {
        // swallow: SDK teardown failures should not surface as hook errors
      });
    }
    setState(initializedRef.current ? SIGNING_STATE.READY : SIGNING_STATE.IDLE);
    setError(null);
    setResult(null);
  }, []);

  return {
    state,
    error,
    result,
    initialize: doInitialize,
    startSigning,
    reset,
  };
}
