// Adapted from Sekiz by Senol Gulgonul (2026), MIT.
// Upstream commit d7bd0d4e1cf0ab3f237c1c0c475b50264922d3fe.
// Compiler: LLVM Apache-2.0 WITH LLVM-exception. Arduino core: LGPL-2.1.

"use strict";
function sekizUntar(bytes) {
  /* USTAR reader: Uint8Array (already gunzipped) -> { "path": Uint8Array } */
  const files = {};
  const td = new TextDecoder();
  let off = 0;
  while (off + 512 <= bytes.length) {
    const block = bytes.subarray(off, off + 512);
    if (block.every(b => b === 0)) break;
    const name = td.decode(block.subarray(0, 100)).replace(/\0.*$/, '');
    const sizeOct = td.decode(block.subarray(124, 136)).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOct || '0', 8);
    const type = block[156];
    const prefix = td.decode(block.subarray(345, 500)).replace(/\0.*$/, '');
    const full = (prefix ? prefix + '/' : '') + name;
    off += 512;
    if (type === 48 || type === 0) { /* '0' or NUL: regular file */
      files[full] = bytes.slice(off, off + size);
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}
let TC = null;   /* { files, clangFactory, lldFactory } */

async function fetchProgress(url, label, expectBytes) {
  const res = await fetch(url, {signal: AbortSignal.timeout(60000), credentials: 'omit'});
  if (!res.ok) throw new Error(label + ': HTTP ' + res.status + ' for ' + url);
  const total = Number(res.headers.get('content-length')) || expectBytes || 0;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (got > 50000000) throw new Error('Toolchain asset exceeds its size budget');
    postMessage({ type: 'progress', label, got, total });
  }
  const out = new Uint8Array(got);
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function loadFactory(jsBytes) {
  const url = URL.createObjectURL(new Blob([jsBytes], { type: 'text/javascript' }));
  importScripts(url);
  URL.revokeObjectURL(url);
  const f = self.createModule;          /* emscripten -sEXPORT_NAME=createModule */
  self.createModule = undefined;
  if (!f) throw new Error('toolchain glue did not define createModule');
  return f;
}

async function gunzip(bytes) {
  return new Uint8Array(await new Response(new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

async function init() {
  const base = new URL('/vendor/avr/', self.location.origin).href;
  const clangJS = await fetchProgress(base + 'clang.js', 'clang.js');
  const clangWasm = await gunzip(await fetchProgress(base + 'clang.wasm.gz', 'compiler', 15883969));
  const lldJS = await fetchProgress(base + 'lld.js', 'lld.js');
  const lldWasm = await gunzip(await fetchProgress(base + 'lld.wasm.gz', 'linker', 8271021));
  const srGz = await fetchProgress(base + 'sysroot.tar.gz', 'sysroot');
  postMessage({ type: 'progress', label: 'unpacking sysroot', got: 0, total: 0 });
  const tarBuf = await new Response(
    new Response(srGz).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const files = sekizUntar(new Uint8Array(tarBuf));
  const libraries = JSON.parse(new TextDecoder().decode(await fetchProgress(base + 'libraries.json', 'Arduino libraries'))).files;
  const clangFactory = await loadFactory(clangJS);
  const lldFactory = await loadFactory(lldJS);
  TC = { files, libraries, clangWasm, lldWasm, clangFactory, lldFactory };
  postMessage({ type: 'ready', fileCount: Object.keys(files).length });
}

async function runTool(factory, wasmBinary, args, inputs, wanted) {
  let log = '';
  const mod = await factory({
    wasmBinary,
    print: s => { log += s + '\n'; },
    printErr: s => { log += s + '\n'; },
    noInitialRun: true,
  });
  const made = new Set();
  const mk = (p) => {
    if (!p || p === '/' || made.has(p)) return;
    mk(p.slice(0, p.lastIndexOf('/')));
    try { mod.FS.mkdir(p); } catch (e) {}
    made.add(p);
  };
  for (const [path, data] of Object.entries(TC.files)) {
    const guest = '/' + path;      /* tar paths are 'sysroot/...' */
    mk(guest.slice(0, guest.lastIndexOf('/')));
    mod.FS.writeFile(guest, data);
  }
  for (const [path, data] of Object.entries(inputs)) {
    mk(path.slice(0, path.lastIndexOf('/')));
    mod.FS.writeFile(path, data);
  }
  let code = 0;
  try { code = mod.callMain(args); }
  catch (e) { if (e && e.status !== undefined) code = e.status; else throw e; }
  const out = {};
  if (code === 0) for (const w of wanted) out[w] = mod.FS.readFile(w);
  return { code, log, out };
}

const PROGMEM_FIX = '-D__progmem__=__section__(".progmem.data")';
const CFLAGS = ['--target=avr', '-mmcu=atmega328p', '-Os',
  '-D__DELAY_BACKWARD_COMPATIBLE__',   /* clang lacks __builtin_avr_delay_cycles; use avr-libc's pure-C delay path */
  '-resource-dir', '/sysroot/clangrt',
  '-DF_CPU=16000000L', '-DARDUINO=10819', '-DARDUINO_AVR_UNO', '-DARDUINO_ARCH_AVR',
  '-isystem', '/sysroot/include', '-I', '/sysroot/arduino', '-I', '/',
  '-std=gnu++11', '-fno-exceptions', '-fno-rtti', '-Wno-everything', PROGMEM_FIX];

async function compile(files) {
  if (!TC) throw new Error('Compiler is not initialized');
  if (!Array.isArray(files) || files.length > 16 || files.some(f => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(f.filename) || typeof f.code !== 'string') || files.reduce((n,f) => n + f.code.length, 0) > 100000) throw new Error('Invalid source files');
  const enc = new TextEncoder();
  const inputs = Object.fromEntries(files.map(f => ['/' + f.filename, enc.encode(f.code)]));
  for (const [name, source] of Object.entries(TC.libraries)) inputs['/'+name]=enc.encode(source);
  const ino = files.filter(f => f.filename.endsWith('.ino'));
  const units = files.filter(f => /\.(cpp|c)$/.test(f.filename)).map(f => ({path:'/'+f.filename,c:f.filename.endsWith('.c')}));
  if (ino.length) {
    inputs['/sketch.cpp'] = enc.encode('#include <Arduino.h>\n' + ino.map(f => '#line 1 ' + JSON.stringify(f.filename) + '\n' + f.code).join('\n'));
    units.unshift({path:'/sketch.cpp',c:false});
  }
  if (!units.length) throw new Error('No firmware translation units');
  const allSource=files.map(f=>f.code).join('\n');
  if (/#\s*include\s*[<"]Wire\.h[>"]/.test(allSource)) units.push({path:'/Wire.cpp',c:false},{path:'/utility/twi.c',c:true});
  if (/#\s*include\s*[<"]SPI\.h[>"]/.test(allSource)) units.push({path:'/SPI.cpp',c:false});
  const objects = {};
  let log = '';
  for (let index=0; index<units.length; index++) {
    const unit=units[index], output='/unit'+index+'.o';
    postMessage({type:'stage',stage:'Compiling '+unit.path.slice(1)});
    const flags=unit.c ? CFLAGS.filter(f => !['-std=gnu++11','-fno-exceptions','-fno-rtti'].includes(f)).concat('-std=gnu11') : CFLAGS;
    const compiled=await runTool(TC.clangFactory,TC.clangWasm,[...flags,'-c','-x',unit.c?'c':'c++',unit.path,'-o',output],inputs,[output]);
    log+=compiled.log;
    if (compiled.code!==0) {postMessage({type:'error',stage:'compile',log:log.slice(-100000)});return;}
    objects[output]=compiled.out[output];
  }
  postMessage({ type: 'stage', stage: 'linking' });
  const l = await runTool(TC.lldFactory, TC.lldWasm,
    ['-flavor', 'gnu', '-T', '/sysroot/avr5_lld.ld', '--gc-sections',
     '/sysroot/lib/crtatmega328p.o', ...Object.keys(objects), '/sysroot/lib/core.a',
     '/sysroot/lib/libc.a', '/sysroot/lib/libm.a', '/sysroot/lib/libgcc.a',
     '-o', '/sketch.elf'],
    objects, ['/sketch.elf']);
  if (l.code !== 0) { postMessage({ type: 'error', stage: 'link', log: l.log }); return; }
  const elf = l.out['/sketch.elf'];
  postMessage({ type: 'done', elf: elf.buffer, log: (log + l.log).slice(-100000) }, [elf.buffer]);
}

onmessage = (e) => {
  const m = e.data;
  const fail = (err) => postMessage({ type: 'error', stage: 'worker', log: String(err && err.message || err) });
  if (m.cmd === 'init') init().catch(fail);
  else if (m.cmd === 'compile') compile(m.files).catch(fail);
};
