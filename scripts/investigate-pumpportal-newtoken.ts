// One-shot probe: connect to PumpPortal's free data WebSocket, subscribe to new
// Pump.fun token creations, print the first few raw messages, then exit.
//
// Purpose: ground-truth the actual message shape before we map it onto
// DetectedToken. No API key required. PumpPortal asks clients to keep a single
// connection rather than reconnecting in a loop, so run this once and let it
// finish:
//   pnpm exec tsx scripts/investigate-pumpportal-newtoken.ts

const PUMPPORTAL_WS_URL = 'wss://pumpportal.fun/api/data';
const MAX_MESSAGES = 6;
const TIMEOUT_MS = 60_000;

const ws = new WebSocket(PUMPPORTAL_WS_URL);
let received = 0;

const finish = (code: number): never => {
  try {
    ws.close();
  } catch {
    // already closing
  }
  process.exit(code);
};

const timeout = setTimeout(() => {
  console.log(`\nTimed out after ${TIMEOUT_MS}ms with ${received} message(s) received.`);
  finish(received > 0 ? 0 : 2);
}, TIMEOUT_MS);

ws.addEventListener('open', () => {
  console.log(`connected: ${PUMPPORTAL_WS_URL}`);
  ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  console.log('subscribed: {"method":"subscribeNewToken"}');
  console.log('waiting for new-token messages...\n');
});

ws.addEventListener('message', (event: MessageEvent) => {
  received += 1;
  const raw = typeof event.data === 'string' ? event.data : String(event.data);
  let body = raw;
  try {
    body = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // not JSON — show the raw frame as-is
  }
  console.log(`=== message ${received} of up to ${MAX_MESSAGES} ===`);
  console.log(body);
  console.log('');

  if (received >= MAX_MESSAGES) {
    clearTimeout(timeout);
    console.log(`captured ${received} message(s); closing.`);
    finish(0);
  }
});

ws.addEventListener('error', (event) => {
  const detail =
    (event as { error?: unknown }).error ?? (event as { message?: unknown }).message ?? event;
  console.error('websocket error:', detail);
  clearTimeout(timeout);
  finish(1);
});

ws.addEventListener('close', (event: CloseEvent) => {
  console.log(`websocket closed (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`);
});
