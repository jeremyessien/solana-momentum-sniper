import { getBase58Decoder } from '@solana/kit';
import type { DetectedToken } from '../shared/detectedToken.js';
import type { ProgramLogEvent } from '../shared/programLogEvent.js';

const CREATE_EVENT_DISCRIMINATOR = new Uint8Array([27, 114, 169, 77, 222, 235, 99, 118]);
const CREATE_EVENT_DISCRIMINATOR_BASE64_PREFIX = 'G3KpTd7rY3Y';
const PROGRAM_DATA_PREFIX = 'Program data: ';
const PUBKEY_BYTES = 32;

const base58 = getBase58Decoder();
const utf8 = new TextDecoder('utf-8');

const isCreateInstructionLog = (line: string): boolean =>
  line === 'Program log: Instruction: CreateV2' || line === 'Program log: Instruction: Create';

const matchesDiscriminator = (bytes: Uint8Array): boolean => {
  if (bytes.length < CREATE_EVENT_DISCRIMINATOR.length) return false;
  for (let i = 0; i < CREATE_EVENT_DISCRIMINATOR.length; i++) {
    if (bytes[i] !== CREATE_EVENT_DISCRIMINATOR[i]) return false;
  }
  return true;
};

type Cursor = { readonly bytes: Uint8Array; offset: number };

const ensureRoom = (cursor: Cursor, needed: number): void => {
  if (cursor.offset + needed > cursor.bytes.length) {
    throw new RangeError(
      `cursor out of bounds: need ${needed} byte(s) at offset ${cursor.offset}, buffer length ${cursor.bytes.length}`,
    );
  }
};

const readU32LE = (cursor: Cursor): number => {
  ensureRoom(cursor, 4);
  const view = new DataView(cursor.bytes.buffer, cursor.bytes.byteOffset + cursor.offset, 4);
  const value = view.getUint32(0, true);
  cursor.offset += 4;
  return value;
};

const readU64LE = (cursor: Cursor): bigint => {
  ensureRoom(cursor, 8);
  const view = new DataView(cursor.bytes.buffer, cursor.bytes.byteOffset + cursor.offset, 8);
  const value = view.getBigUint64(0, true);
  cursor.offset += 8;
  return value;
};

const readString = (cursor: Cursor): string => {
  const length = readU32LE(cursor);
  ensureRoom(cursor, length);
  const stringBytes = cursor.bytes.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return utf8.decode(stringBytes);
};

const readPubkey = (cursor: Cursor): string => {
  ensureRoom(cursor, PUBKEY_BYTES);
  const pubkeyBytes = cursor.bytes.subarray(cursor.offset, cursor.offset + PUBKEY_BYTES);
  cursor.offset += PUBKEY_BYTES;
  return base58.decode(pubkeyBytes);
};

const skipBytes = (cursor: Cursor, count: number): void => {
  ensureRoom(cursor, count);
  cursor.offset += count;
};

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
    if (!matchesDiscriminator(bytes)) continue;
    return tryDecodeCreateEvent(bytes, options);
  }

  return null;
};
