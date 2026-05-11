import type { DetectedToken } from './detectedToken.js';
import type { Result } from './result.js';
import type { RugCheckFetchError, RugCheckSnapshot } from './rugCheckSnapshot.js';

export type TokenWithFullContext = {
  readonly detected: DetectedToken;
  readonly analyzedAt: Date;
  readonly rugcheck: Result<RugCheckSnapshot, RugCheckFetchError>;
};
