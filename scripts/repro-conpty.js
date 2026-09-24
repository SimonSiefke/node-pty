'use strict';
// Standalone diagnostic. Track worker IDs, never retain Worker or terminal objects.
const { resolve } = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const workerThreads = require('worker_threads');
const BaseWorker = workerThreads.Worker;
const live = new Set();
let started = 0;
let exited = 0;
workerThreads.Worker = class extends BaseWorker {
  constructor(...args) {
    super(...args);
    const id = ++started;
    live.add(id);
    this.once('exit', () => { exited++; live.delete(id); });
  }
};
const pty = require(resolve(process.argv[2], 'lib'));
const out = resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshots = [];
function snapshot(phase) {
  if (global.gc) global.gc();
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}'; [pscustomobject]@{pid=$p.ProcessId;createdAt=$p.CreationDate;privateBytes=$p.PrivatePageCount;handles=$p.HandleCount;threads=$p.ThreadCount} | ConvertTo-Json -Compress`], { encoding: 'utf8' });
  const row = { phase, started, exited, liveWorkers: live.size, process: JSON.parse(raw), memory: process.memoryUsage() };
  snapshots.push(row);
  fs.writeFileSync(resolve(out, 'result.json'), JSON.stringify(snapshots, null, 2));
  console.log(JSON.stringify(row));
}
async function cycle() {
  const term = pty.spawn('cmd.exe', ['/d', '/q'], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConptyDll: true });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { listener.dispose(); reject(new Error('No cmd output')); }, 10000);
      const listener = term.onData(() => { clearTimeout(timeout); listener.dispose(); resolve(); });
    });
    await sleep(100);
    term.kill();
  } catch (error) { term.kill(); throw error; }
}
(async () => {
  for (let i = 0; i < 2; i++) await cycle();
  await sleep(3000);
  snapshot('before');
  for (let i = 0; i < 37; i++) await cycle();
  snapshot('immediate');
  await sleep(5000);
  snapshot('idle-5s');
  await sleep(25000);
  snapshot('idle-30s');
  // This is an evidence collector: report failure explicitly, then terminate leaked workers with the process.
  process.exit(live.size ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
