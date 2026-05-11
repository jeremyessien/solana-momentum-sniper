import { getBase58Decoder } from '@solana/kit';

export const PROGRAM_DATA_PREFIX = 'Program data: ';
export const PUBKEY_BYTES = 32;

const base58 = getBase58Decoder();
const utf8 = new TextDecoder('utf-8');

export type Cursor = { readonly bytes: Uint8Array; offset: number };

export const ensureRoom = (cursor: Cursor, needed: number): void => {
  if (cursor.offset + needed > cursor.bytes.length) {
    throw new RangeError(
      `cursor out of bounds: need ${needed} byte(s) at offset ${cursor.offset}, buffer length ${cursor.bytes.length}`,
    );
  }
};

export const readU32LE = (cursor: Cursor): number => {
  ensureRoom(cursor, 4);
  const view = new DataView(cursor.bytes.buffer, cursor.bytes.byteOffset + cursor.offset, 4);
  const value = view.getUint32(0, true);
  cursor.offset += 4;
  return value;
};

export const readU64LE = (cursor: Cursor): bigint => {
  ensureRoom(cursor, 8);
  const view = new DataView(cursor.bytes.buffer, cursor.bytes.byteOffset + cursor.offset, 8);
  const value = view.getBigUint64(0, true);
  cursor.offset += 8;
  return value;
};

export const readI64LE = (cursor: Cursor): bigint => {
  ensureRoom(cursor, 8);
  const view = new DataView(cursor.bytes.buffer, cursor.bytes.byteOffset + cursor.offset, 8);
  const value = view.getBigInt64(0, true);
  cursor.offset += 8;
  return value;
};

export const readBool = (cursor: Cursor): boolean => {
  ensureRoom(cursor, 1);
  const value = cursor.bytes[cursor.offset];
  cursor.offset += 1;
  return value !== 0;
};

export const readString = (cursor: Cursor): string => {
  const length = readU32LE(cursor);
  ensureRoom(cursor, length);
  const stringBytes = cursor.bytes.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return utf8.decode(stringBytes);
};

export const readPubkey = (cursor: Cursor): string => {
  ensureRoom(cursor, PUBKEY_BYTES);
  const pubkeyBytes = cursor.bytes.subarray(cursor.offset, cursor.offset + PUBKEY_BYTES);
  cursor.offset += PUBKEY_BYTES;
  return base58.decode(pubkeyBytes);
};

export const skipBytes = (cursor: Cursor, count: number): void => {
  ensureRoom(cursor, count);
  cursor.offset += count;
};

export const matchesDiscriminator = (bytes: Uint8Array, discriminator: Uint8Array): boolean => {
  if (bytes.length < discriminator.length) return false;
  for (let i = 0; i < discriminator.length; i++) {
    if (bytes[i] !== discriminator[i]) return false;
  }
  return true;
};
