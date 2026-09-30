// Loads the QR encoder the page ships (public/qr.js) so the terminal and the
// page draw the same code from one implementation.
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/qr.js', import.meta.url), 'utf8');
const sandbox = { TextEncoder };
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox, { filename: 'public/qr.js' });

export const { encode, withQuietZone, toTerminalLines } = sandbox.dshQr;
