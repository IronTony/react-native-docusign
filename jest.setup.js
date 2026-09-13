// Stub the native module so tests never reach requireNativeModule.
jest.mock('./src/DocuSignModule', () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(),
    loginWithAccessToken: jest.fn(),
    presentCaptiveSigning: jest.fn(),
    presentCaptiveSigningWithUrl: jest.fn(),
    logout: jest.fn(),
    isLoggedIn: jest.fn(),
    endSigningSession: jest.fn(),
    reset: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));
