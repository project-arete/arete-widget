// electron/settings.js
// ---------------------------------------------------------------------------
// settings.json in Electron's userData dir. Carries the Config tab state:
//   lastConnect { protocol, host, port, allowSelfSigned }
//   rememberToken (bool) + tokenEnc (base64 of safeStorage ciphertext)
//   autoConnect (bool)
//   systemName (the System name this app registers on the realm)
// The per-realm token is ONLY stored when rememberToken is on AND the OS
// provides encryption (macOS Keychain / Windows DPAPI / Linux keyring via
// safeStorage). Unchecking "remember" wipes the stored ciphertext.
// encrypt/decryptPassword are generic safeStorage string helpers (named for
// their original use); they now carry the token.
// ---------------------------------------------------------------------------

import { app, safeStorage } from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('fs');

const FILE = () => path.join(app.getPath('userData'), 'settings.json');

export function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch (_) {
    return {};
  }
}

export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('Failed to persist settings.json', e);
  }
  return next;
}

export function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

export function encryptPassword(plain) {
  if (!plain || !canEncrypt()) return null;
  try {
    return safeStorage.encryptString(String(plain)).toString('base64');
  } catch (_) {
    return null;
  }
}

export function decryptPassword(passwordEnc) {
  if (!passwordEnc || !canEncrypt()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(passwordEnc, 'base64'));
  } catch (_) {
    return '';
  }
}
