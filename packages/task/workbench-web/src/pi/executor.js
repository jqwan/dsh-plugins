import { execFileSync } from 'node:child_process';

/** 查找操作指定 session 文件的 pi 进程。 */
export function findPiPids(sessionFile) {
  if (!sessionFile) return [];
  try {
    if (process.platform === 'win32') {
      const env = { ...process.env, PI_SESSION_FILE: sessionFile };
      const script = "$needle=$env:PI_SESSION_FILE; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } | ForEach-Object { $_.ProcessId }";
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', env });
      return output.split(/\r?\n/).map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
    }
    const output = execFileSync('pgrep', ['-f', sessionFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { encoding: 'utf8' });
    return output.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 终止任务的 pi 进程（SIGTERM → 等待 → SIGKILL）。 */
export function killPi(sessionFile, { timeoutMs = 2500 } = {}) {
  const pids = findPiPids(sessionFile);
  if (!pids.length) return 0;
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (findPiPids(sessionFile).length === 0) break;
    sleepSync(200);
  }
  for (const pid of findPiPids(sessionFile)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }
  return pids.length;
}
