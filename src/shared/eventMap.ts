import type { DetectedToken } from './detectedToken.js';

/**
 * Central registry of all events that flow through the event bus.
 * Each entry maps an event name to its payload type. Modules import
 * this and parameterise their `EventBus` against it.
 *
 * Events are added here as the modules that publish them are built.
 * The full catalog as planned is in `docs/architecture.md` Part Five.
 */
export type EventMap = {
  readonly newTokenLaunchDetected: DetectedToken;
};
