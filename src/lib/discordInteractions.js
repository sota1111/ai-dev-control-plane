'use strict';

const crypto = require('crypto');

/**
 * Converts a 32-byte hex public key to SubjectPublicKeyInfo (SPKI) DER format.
 * @param {string} hexKey - 32-byte hex string
 * @returns {Buffer}
 */
function hexPublicKeyToDer(hexKey) {
  // Ed25519 OID prefix for SubjectPublicKeyInfo
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const keyBytes = Buffer.from(hexKey, 'hex');
  return Buffer.concat([prefix, keyBytes]);
}

/**
 * Verify Discord Interaction request signature using Ed25519.
 * @param {string} publicKey - DISCORD_PUBLIC_KEY env var (hex string)
 * @param {string} signature - X-Signature-Ed25519 header value
 * @param {string} timestamp - X-Signature-Timestamp header value
 * @param {string|Buffer} body - raw request body
 * @returns {boolean}
 */
function verifyDiscordSignature(publicKey, signature, timestamp, body) {
  try {
    const message = Buffer.concat([
      Buffer.from(timestamp, 'utf8'),
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'),
    ]);
    const derKey = hexPublicKeyToDer(publicKey);
    return crypto.verify(
      null,
      message,
      {
        key: derKey,
        format: 'der',
        type: 'spki',
      },
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}

module.exports = { verifyDiscordSignature };
