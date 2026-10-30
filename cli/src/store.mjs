import {open, mkdir, lstat, rename, unlink, readFile, link} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes, scrypt as scryptCallback, createCipheriv, createDecipheriv} from 'node:crypto';
import {promisify} from 'node:util';
import {need, UserError} from './errors.mjs';

// Kept from CLI 0.2.0: mode-700 data folder, mode-600 files, atomic writes, one process per folder, scrypt + AES-256-GCM.
const scrypt = promisify(scryptCallback), LIMIT = 128 * 1024 * 1024;
const AAD = Buffer.from('XMR20 CLI encrypted local state v1');
export function dataDirectory(value) { return resolve(value || join(homedir(), '.xmr20-wallet')); }
export async function privateDirectory(path) {
  await mkdir(path, {recursive: true, mode: 0o700});
  const st = await lstat(path);
  need(st.isDirectory() && !st.isSymbolicLink(), 'Wallet directory must be a real directory.');
  if (process.platform !== 'win32') need((st.mode & 0o077) === 0 && st.uid === process.getuid(), 'Wallet directory must belong to you with permissions 700.');
}
export async function privateRead(path, limit = LIMIT) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const st = await file.stat();
    need(st.isFile() && st.size <= limit, 'Wallet file is invalid or too large.');
    if (process.platform !== 'win32') need((st.mode & 0o077) === 0 && st.uid === process.getuid(), 'Wallet file permissions must be 600 and owned by you.');
    return await file.readFile();
  } finally { await file.close(); }
}
export async function atomicWrite(path, bytes, {exclusive = false} = {}) {
  const temp = path + '.' + randomBytes(12).toString('hex') + '.tmp';
  const file = await open(temp, 'wx', 0o600);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    if (exclusive) { await link(temp, path); await unlink(temp); }
    else await rename(temp, path);
    if (process.platform !== 'win32') { const dir = await open(resolve(path, '..'), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  } finally { await unlink(temp).catch(() => {}); }
}
export async function lockDirectory(dir) {
  await privateDirectory(dir);
  const path = join(dir, 'process.lock'); let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new UserError('This CLI directory is locked. Close the other CLI process. After a crash, use doctor to inspect the lock; do not delete signing storage.'); throw e; }
  await file.writeFile(JSON.stringify({pid: process.pid, started: new Date().toISOString()})); await file.sync();
  return async () => { await file.close(); await unlink(path); };
}
export async function inspectLock(dir) {
  try { const row = JSON.parse(await privateRead(join(dir, 'process.lock'), 1024)); let running = true;
    try { process.kill(row.pid, 0); } catch (e) { if (e.code === 'ESRCH') running = false; }
    return {...row, running};
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function clearDeadLock(dir) {
  const row = await inspectLock(dir); need(row && row.running === false, 'No confirmed dead process lock to clear.');
  await unlink(join(dir, 'process.lock'));
}
function b64(value, size) {
  need(typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'Invalid encrypted wallet.');
  const b = Buffer.from(value, 'base64');
  need(b.toString('base64') === value && (size === undefined || b.length === size), 'Invalid encrypted wallet.'); return b;
}
async function key(password, salt) { return scrypt(password, salt, 32, {N: 65536, r: 8, p: 1, maxmem: 96 * 1024 * 1024}); }
export async function seal(value, password) {
  need(typeof password === 'string' && password.length >= 12 && password.length <= 1024, 'Use a password of 12–1024 characters.');
  const salt = randomBytes(32), iv = randomBytes(12), k = await key(password, salt), plain = Buffer.from(JSON.stringify(value));
  try { need(plain.length <= 90 * 1024 * 1024, 'Encrypted wallet state exceeds the storage limit. The last saved version is retained.');
    const cipher = createCipheriv('aes-256-gcm', k, iv); cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.from(JSON.stringify({version: 1, kdf: 'scrypt-65536-8-1', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64')}));
  } finally { k.fill(0); plain.fill(0); }
}
export async function unseal(bytes, password) {
  let k, plain;
  try { need(bytes.length <= LIMIT, 'Wallet too large.'); const box = JSON.parse(bytes);
    need(box.version === 1 && box.kdf === 'scrypt-65536-8-1', 'Unsupported wallet.');
    k = await key(password, b64(box.salt, 32)); const decipher = createDecipheriv('aes-256-gcm', k, b64(box.iv, 12));
    decipher.setAAD(AAD); decipher.setAuthTag(b64(box.tag, 16));
    plain = Buffer.concat([decipher.update(b64(box.ciphertext)), decipher.final()]); return JSON.parse(plain);
  } catch { throw new UserError('Could not unlock this CLI wallet. Check the password and file.'); }
  finally { k?.fill(0); plain?.fill(0); }
}
// The wallet file (wallet.json, encrypted with the wallet password): the Monero phrase, its restore height and address, and
// the Solana key the bridge uses. Everything else in the folder holds no keys.
export const SCHEMA='xmr20-cli-v3';
export function checkWallet(state){
  need(state && state.schema === SCHEMA && typeof state.id === 'string' && /^cli-[0-9a-f]{24}$/.test(state.id), 'Unsupported CLI wallet file.');
  need(typeof state.xmr?.address === 'string' && state.xmr.address.length === 95 && typeof state.xmr.seed === 'string' && state.xmr.seed.trim().split(/\s+/).length === 25, 'Unsupported CLI wallet file.');
  need(Number.isSafeInteger(state.xmr.restoreHeight) && state.xmr.restoreHeight >= 0 && state.xmr.restoreHeight < 8000000, 'Unsupported CLI wallet file.');
  need(typeof state.sol?.address === 'string' && typeof state.sol?.secret === 'string', 'Unsupported CLI wallet file.');
  return state;
}
export async function loadWallet(dir, password) {
  let bytes; try { bytes = await privateRead(join(dir, 'wallet.json')); } catch (e) { if (e.code === 'ENOENT') throw new UserError('No wallet in this folder yet. Run "xmr20 create" or "xmr20 import" first.'); throw e; }
  return checkWallet(await unseal(bytes, password));
}
export async function saveWallet(dir, state, password, options) { await atomicWrite(join(dir, 'wallet.json'), await seal(checkWallet(state), password), options); }
export async function hasWallet(dir) { try { await lstat(join(dir, 'wallet.json')); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
