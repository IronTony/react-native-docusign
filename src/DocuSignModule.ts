import { NativeModule, requireNativeModule } from 'expo';

import {
  CaptiveSigningParams,
  CaptiveSigningUrlParams,
  DocuSignAccountInfo,
  DocuSignAuthParams,
  DocuSignConfig,
  DocuSignModuleEvents,
  SigningErrorEvent,
} from './DocuSign.types';

/**
 * Native code rejects only for caller mistakes, because a rejection crosses the
 * Expo bridge with nothing but `code` and `message`. Runtime failures resolve
 * with this payload instead, so their details survive, and the exported API
 * turns them into a thrown `DocuSignError`.
 */
export type NativeFailureOutcome = SigningErrorEvent & { status: 'error' };

export type NativeSigningOutcome =
  | {
      status: 'completed' | 'cancelled';
      envelopeId: string;
      errorCode?: string | null;
      errorMessage?: string | null;
    }
  | NativeFailureOutcome;

export type NativeLoginOutcome =
  { status: 'success'; account: DocuSignAccountInfo } | NativeFailureOutcome;

declare class DocuSignModule extends NativeModule<DocuSignModuleEvents> {
  initialize(config: DocuSignConfig): Promise<NativeFailureOutcome | null>;
  loginWithAccessToken(params: DocuSignAuthParams): Promise<NativeLoginOutcome>;
  presentCaptiveSigning(
    params: CaptiveSigningParams,
  ): Promise<NativeSigningOutcome>;
  presentCaptiveSigningWithUrl(
    params: CaptiveSigningUrlParams,
  ): Promise<NativeSigningOutcome>;
  logout(): Promise<void>;
  isLoggedIn(): Promise<boolean>;
  endSigningSession(): Promise<void>;
  reset(): Promise<void>;
}

export default requireNativeModule<DocuSignModule>('DocuSign');
