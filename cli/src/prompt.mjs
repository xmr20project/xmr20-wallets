import {createInterface} from 'node:readline/promises';
import {need, UserError} from './errors.mjs';
export async function ask(question, {secret = false} = {}) {
  need(process.stdin.isTTY && process.stdout.isTTY, 'An interactive terminal is required. Secrets are never accepted through arguments, pipes or environment variables.');
  if (!secret) { const rl = createInterface({input: process.stdin, output: process.stdout}); try { return await rl.question(question); } finally { rl.close(); } }
  const input = process.stdin, previousRaw = input.isRaw; input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let text = '';
    function finish(error) { input.off('data', receive); input.setRawMode(previousRaw); input.pause(); process.stdout.write('\n'); error ? reject(error) : resolve(text); text = ''; }
    function receive(chunk) {
      for (const c of chunk.toString('utf8')) {
        if (c === '\u0003' || c === '\u0004') return finish(new UserError('Cancelled.'));
        if (c === '\r' || c === '\n') return finish();
        if (c === '\u007f' || c === '\b') text = text.slice(0, -1);
        else if (c >= ' ' && c !== '\u001b') text += c;
        if (text.length > 2048) return finish(new UserError('Input too long.'));
      }
    }
    input.on('data', receive);
    // Disable terminal echo and install the listener before exposing the
    // prompt, including to fast pasted/automated terminal input.
    process.stdout.write(question);
  });
}
export async function password(confirm = false) {
  const value = await ask('Wallet password: ', {secret: true});
  need(value.length >= 12 && value.length <= 1024, 'Use at least 12 characters.');
  if (confirm) need(value === await ask('Repeat password: ', {secret: true}), 'Passwords did not match.');
  return value;
}
export async function approve(message) { return (await ask(message + ' Type yes to continue: ')).trim() === 'yes'; }
