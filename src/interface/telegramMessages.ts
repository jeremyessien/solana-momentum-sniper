import type { DetectedToken } from '../shared/detectedToken.js';
import type { TokenTrackingClosed } from '../shared/tokenTrackingClosed.js';
import type { TokenWithFullContext } from '../shared/tokenWithFullContext.js';

const escapeHtml = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const lamportsToSol = (lamports: bigint): string => (Number(lamports) / 1_000_000_000).toFixed(2);

export const formatNewTokenLaunchDetected = (token: DetectedToken): string => {
  return [
    '🆕 <b>New launch</b>',
    `<b>Mint:</b> <code>${escapeHtml(token.mint)}</code>`,
    `<b>Creator:</b> <code>${escapeHtml(token.creatorWallet)}</code>`,
    `<b>Liquidity:</b> ${lamportsToSol(token.initialLiquidityLamports)} SOL`,
    `<b>Launchpad:</b> ${escapeHtml(token.launchpad)}`,
  ].join('\n');
};

export const formatTokenAnalysisCompleted = (analysis: TokenWithFullContext): string => {
  const rc = analysis.rugcheck;
  if (rc.kind === 'err') {
    const statusPart = rc.error.kind === 'http_error' ? ` (${rc.error.status})` : '';
    return [
      '📊 <b>Analysis failed</b>',
      `<b>Mint:</b> <code>${escapeHtml(analysis.detected.mint)}</code>`,
      `<b>Reason:</b> ${escapeHtml(rc.error.kind)}${statusPart}`,
    ].join('\n');
  }

  const snap = rc.value;
  const name = snap.tokenName !== null ? escapeHtml(snap.tokenName) : null;
  const symbol = snap.tokenSymbol !== null ? escapeHtml(snap.tokenSymbol) : '?';
  const header =
    name !== null ? `📊 <b>Analysis: $${symbol} (${name})</b>` : `📊 <b>Analysis: $${symbol}</b>`;
  const topHolderPct = snap.topHolders[0]?.pct.toFixed(1) ?? '—';
  const mintAuthority = snap.mintAuthority === null ? 'renounced ✓' : 'active ⚠️';
  const freezeAuthority = snap.freezeAuthority === null ? 'renounced ✓' : 'active ⚠️';

  const lines: string[] = [
    header,
    `<b>Mint:</b> <code>${escapeHtml(snap.mint)}</code>`,
    `<b>Risk score:</b> ${snap.scoreNormalised}/10`,
    `<b>Holders:</b> ${snap.totalHolders} (top: ${topHolderPct}%)`,
    `<b>Mint authority:</b> ${mintAuthority}`,
    `<b>Freeze authority:</b> ${freezeAuthority}`,
    `<b>Liquidity:</b> $${snap.totalMarketLiquidityUsd.toFixed(0)}`,
  ];
  if (snap.risks.length > 0) {
    const flags = snap.risks.map((r) => escapeHtml(r.name)).join(', ');
    lines.push(`<b>Flags:</b> ${flags}`);
  }
  if (snap.rugged) {
    lines.push('⚠️ <b>RUGGED FLAG SET</b>');
  }
  return lines.join('\n');
};

export const formatTokenTrackingClosed = (event: TokenTrackingClosed): string => {
  return [
    '🏁 <b>Tracking closed</b>',
    `<b>Mint:</b> <code>${escapeHtml(event.mint)}</code>`,
    `<b>Reason:</b> ${escapeHtml(event.reason)}`,
    `<b>Trades:</b> ${event.tradeCount} (${event.buyCount} buys, ${event.sellCount} sells)`,
    `<b>Unique traders:</b> ${event.uniqueTraders}`,
    `<b>Creator traded:</b> ${event.creatorTraded ? 'yes' : 'no'}`,
  ].join('\n');
};
