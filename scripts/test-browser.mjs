import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.output', 'browser-tests');
const browser = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(candidate => candidate && existsSync(candidate));
if (!browser) throw new Error('找不到 Chrome/Edge。请通过 CHROME_PATH 指定浏览器可执行文件。');

await build({
  configFile: false, root, logLevel: 'error',
  build: { outDir: output, emptyOutDir: true, target: 'es2022',
    lib: { entry: join(root, 'tests/epub.browser.ts'), name: 'EpubResourceTests', formats: ['iife'], fileName: () => 'tests.js' } },
});
await mkdir(output, { recursive: true });
await writeFile(join(output, 'index.html'), '<!doctype html><html><meta charset="utf-8"><title>EPUB resource regression tests</title><body><pre>Running…</pre><script src="./tests.js"></script></body></html>');
const profile = await mkdtemp(join(output, 'profile-'));
const child = spawn(browser, ['--headless=new', '--no-sandbox', '--disable-gpu', '--in-process-gpu',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile],
{ windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
let send;
let diagnostics = '';
const pending = new Map();
const timeout = setTimeout(() => {
  const error = new Error('浏览器检查超时。' + diagnostics.slice(-1000));
  for (const task of pending.values()) task.reject(error);
  child.kill();
  socket?.close();
  process.exitCode = 1;
}, 30_000);

try {
  const address = await new Promise((resolveAddress, reject) => {
    child.stderr.on('data', data => {
      diagnostics += String(data);
      const match = diagnostics.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolveAddress(match[1]);
    });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`浏览器启动失败（${code}）：${diagnostics.slice(-1000)}`)));
  });
  socket = new WebSocket(address);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const task of pending.values()) task.reject(new Error('浏览器连接已关闭'));
    pending.clear();
  });
  send = (method, params = {}, sessionId) => new Promise((resolveCall, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveCall, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: pathToFileURL(join(output, 'index.html')).href }, sessionId);
  let finished = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    const value = await send('Runtime.evaluate', {
      expression: 'JSON.stringify(globalThis.__epubResourceTest || null)', returnByValue: true,
    }, sessionId);
    const result = JSON.parse(value.result.value ?? 'null');
    if (!result?.done) continue;
    finished = true;
    if (result.error) throw new Error(result.error);
    console.log(`EPUB 浏览器检查通过：${result.passed} 项`);
    for (const check of result.checks) console.log('  ✓ ' + check);
    break;
  }
  if (!finished) throw new Error('EPUB 浏览器测试未完成。' + diagnostics.slice(-1000));
  await send('Browser.close');
} finally {
  clearTimeout(timeout);
  socket?.close();
  child.kill();
}
