import {
  type Cursor,
  matchesDiscriminator,
  PROGRAM_DATA_PREFIX,
  PUBKEY_BYTES,
  readPubkey,
  readString,
  readU64LE,
  skipBytes,
} from '../shared/borshCursor.js';
import type { DetectedToken } from '../shared/detectedToken.js';
import type { ProgramLogEvent } from '../shared/programLogEvent.js';

const CREATE_EVENT_DISCRIMINATOR = new Uint8Array([27, 114, 169, 77, 222, 235, 99, 118]);
const CREATE_EVENT_DISCRIMINATOR_BASE64_PREFIX = 'G3KpTd7rY3Y';

const isCreateInstructionLog = (line: string): boolean =>
  line === 'Program log: Instruction: CreateV2' || line === 'Program log: Instruction: Create';

export type ParsePumpfunCreateOptions = {
  readonly internalId: string;
  readonly detectedAt: Date;
};

const tryDecodeCreateEvent = (
  bytes: Uint8Array,
  options: ParsePumpfunCreateOptions,
): DetectedToken | null => {
  try {
    const cursor: Cursor = { bytes, offset: CREATE_EVENT_DISCRIMINATOR.length };

    readString(cursor);
    readString(cursor);
    readString(cursor);

    const mint = readPubkey(cursor);
    skipBytes(cursor, PUBKEY_BYTES);
    skipBytes(cursor, PUBKEY_BYTES);
    const creatorWallet = readPubkey(cursor);
    skipBytes(cursor, 8);
    skipBytes(cursor, 8);
    const initialLiquidityLamports = readU64LE(cursor);

    return {
      internalId: options.internalId,
      mint,
      launchpad: 'pumpfun',
      creatorWallet,
      initialLiquidityLamports,
      detectedAt: options.detectedAt,
    };
  } catch {
    return null;
  }
};

export const parsePumpfunCreate = (
  event: ProgramLogEvent,
  options: ParsePumpfunCreateOptions,
): DetectedToken | null => {
  if (event.err !== null) return null;

  let markerSeen = false;
  for (const line of event.logs) {
    if (!markerSeen) {
      if (isCreateInstructionLog(line)) markerSeen = true;
      continue;
    }
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const base64 = line.slice(PROGRAM_DATA_PREFIX.length);
    if (!base64.startsWith(CREATE_EVENT_DISCRIMINATOR_BASE64_PREFIX)) continue;
    const bytes = Buffer.from(base64, 'base64');
    if (!matchesDiscriminator(bytes, CREATE_EVENT_DISCRIMINATOR)) continue;
    return tryDecodeCreateEvent(bytes, options);
  }

  return null;
};
