// Dependency-free ZIP writer. Include only runtime source files: never walk
// environment files, caches, generated boards, uploads or dependency folders.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
const entries = [];
async function add(relative) {
  entries.push({ name: 'dunkai-runtime/' + relative, bytes: await fs.readFile(path.join(root, relative)), executable: /start\.(sh|command)$/.test(relative) });
}
async function sourceTree(relative, extensions) {
  for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === '__pycache__' || item.name.startsWith('test')) continue;
    const name = relative + '/' + item.name;
    if (item.isDirectory()) await sourceTree(name, extensions);
    else if (item.isFile() && extensions.includes(path.extname(item.name))) await add(name);
  }
}
await sourceTree('ai_engine/agents', ['.py', '.txt', '.json']);
await sourceTree('ai_engine/data/profiles', ['.json']);
await sourceTree('dunkai-designer/src', ['.mjs', '.js', '.json', '.ts']);
await sourceTree('runtime/src', ['.mjs']);
for (const name of ['ai_engine/requirements.txt', 'dunkai-designer/package.json', 'dunkai-designer/package-lock.json',
  'dunkai-designer/.npmrc', 'runtime/Dockerfile', 'runtime/start.sh', 'runtime/start.command', 'runtime/start.bat', 'runtime/runtime.env.example', '.dockerignore', 'docs/LOCAL_RUNTIME.md']) await add(name);
const table = Array.from({ length: 256 }, (_, index) => { let c = index; for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
const crc32 = (bytes) => { let crc = 0xffffffff; for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; };
const bodies = [], central = []; let offset = 0;
for (const { name, bytes, executable } of entries) {
  const encoded = Buffer.from(name); const crc = crc32(bytes);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(encoded.length, 26);
  const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(0x314, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x800, 8);
  dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(bytes.length, 20); dir.writeUInt32LE(bytes.length, 24); dir.writeUInt16LE(encoded.length, 28);
  dir.writeUInt32LE(((executable ? 0o100755 : 0o100644) << 16) >>> 0, 38); dir.writeUInt32LE(offset, 42);
  bodies.push(local, encoded, bytes); central.push(dir, encoded); offset += local.length + encoded.length + bytes.length;
}
const index = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
const destination = path.join(root, 'backend/public/dunkai-runtime.zip');
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, Buffer.concat([...bodies, index, end]));
console.log('Packaged ' + entries.length + ' source files into backend/public/dunkai-runtime.zip');
