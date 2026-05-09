import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBase58Decoder } from '@solana/kit';

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/pumpfun-create-v2-sample.json',
);

type Fixture = { readonly transaction: { readonly logs: readonly string[] } };

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Fixture;

const PROGRAM_DATA_PREFIX = 'Program data: ';
const CREATE_V2_DISCRIMINATOR = [27, 114, 169, 77, 222, 235, 99, 118];

const dataLines = fixture.transaction.logs.filter((l) => l.startsWith(PROGRAM_DATA_PREFIX));
console.log(`Found ${dataLines.length} 'Program data:' line(s) in the fixture\n`);

const matching = dataLines.find((line) => {
  const bytes = Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length), 'base64');
  return CREATE_V2_DISCRIMINATOR.every((b, i) => bytes[i] === b);
});

if (!matching) {
  console.error('No Program data line matches the CreateV2 discriminator');
  process.exit(1);
}

const bytes = Buffer.from(matching.slice(PROGRAM_DATA_PREFIX.length), 'base64');
console.log(`Total payload bytes: ${bytes.length}`);
console.log(`Discriminator (first 8): [${Array.from(bytes.subarray(0, 8)).join(', ')}]`);
console.log(`Discriminator hex:       ${bytes.subarray(0, 8).toString('hex').toUpperCase()}\n`);

const base58 = getBase58Decoder();
let offset = 8;

const fmtOffset = (n: number): string => n.toString().padStart(4, ' ');

const readString = (label: string): void => {
  const startOffset = offset;
  const length = bytes.readUInt32LE(offset);
  offset += 4;
  const value = bytes.subarray(offset, offset + length).toString('utf-8');
  offset += length;
  console.log(`offset ${fmtOffset(startOffset)}: ${label.padEnd(22)} length=${length}, "${value}"`);
};

const readPubkey = (label: string): void => {
  const startOffset = offset;
  const value = base58.decode(bytes.subarray(offset, offset + 32));
  offset += 32;
  console.log(`offset ${fmtOffset(startOffset)}: ${label.padEnd(22)} ${value}`);
};

const readI64 = (label: string, hint: string): void => {
  const startOffset = offset;
  const value = bytes.readBigInt64LE(offset);
  offset += 8;
  console.log(`offset ${fmtOffset(startOffset)}: ${label.padEnd(22)} ${value}  (${hint})`);
};

const readU64 = (label: string, hint: string): void => {
  const startOffset = offset;
  const value = bytes.readBigUInt64LE(offset);
  offset += 8;
  console.log(`offset ${fmtOffset(startOffset)}: ${label.padEnd(22)} ${value}  (${hint})`);
};

readString('name');
readString('symbol');
readString('uri');
readPubkey('mint');
readPubkey('bondingCurve');
readPubkey('user');
readPubkey('creator');
readI64('timestamp', 'expected: ~1.7e9 if seconds, ~1.7e15 if ms, ~1.7e18 if ns');
readU64('virtualTokenReserves', 'expected: ~1e15 token-units');
readU64('virtualSolReserves', 'expected: ~3e10 lamports (~30 SOL)');
readU64('realTokenReserves', 'expected: < tokenTotalSupply');
readU64('tokenTotalSupply', 'expected: ~1e15 token-units');

console.log(`\nBytes consumed: ${offset} / ${bytes.length}`);
if (offset !== bytes.length) {
  console.log(`⚠️  Mismatch — ${bytes.length - offset} byte(s) unread or over-read`);
} else {
  console.log('✓ Exact byte coverage');
}
