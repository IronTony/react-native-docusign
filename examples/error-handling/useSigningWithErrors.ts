import {
  DocuSignConfig,
  DocuSignError,
  DocuSignSigningState,
  endSigningSession,
  SigningResult,
  SigningSession,
  useDocuSignSigning,
} from 'react-native-docusign';

import { shouldRetry } from './retry';

const MAX_ATTEMPTS = 2;

export type UseSigningWithErrorsOptions = {
  config: DocuSignConfig;
  /** Receives the final failure. Map `error.reason` to translated copy here, for example in a toast. */
  onFailure: (error: DocuSignError) => void;
};

export type UseSigningWithErrorsReturn = {
  state: DocuSignSigningState;
  sign: (session: SigningSession) => Promise<SigningResult | null>;
};

/**
 * Wraps `useDocuSignSigning` with a retry policy driven by `reason`. Logging is
 * not done here: `installDocuSignErrorReporting` already sees every failure.
 */
export function useSigningWithErrors({
  config,
  onFailure,
}: UseSigningWithErrorsOptions): UseSigningWithErrorsReturn {
  const signing = useDocuSignSigning({ config });

  const sign = async (session: SigningSession) => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await signing.startSigning(session);
      } catch (error) {
        if (!(error instanceof DocuSignError)) throw error;
        if (attempt === MAX_ATTEMPTS || !shouldRetry(error)) {
          onFailure(error);
          return null;
        }
        // Awaited, unlike the hook's reset(), so the next attempt does not race
        // the teardown of the one that failed.
        await endSigningSession();
      }
    }
    return null;
  };

  return { state: signing.state, sign };
}
