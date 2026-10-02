import { spawn } from 'node:child_process';
import { openSync, closeSync, writeSync } from 'node:fs';
import { constants } from 'node:os';

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // group already gone
  }
}

export function runWithTimeout(command, { cwd, timeoutSec, logFile, env = process.env }) {
  const argv = Array.isArray(command) ? command : ['sh', '-c', command];
  const fd = openSync(logFile, 'a');
  const started = Date.now();

  return new Promise((resolve) => {
    let timedOut = false;
    let finished = false;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', fd, fd], detached: true });

    const finish = (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (child.pid) killGroup(child.pid);
      closeSync(fd);
      resolve({ exitCode, timedOut, durationSec: Math.round((Date.now() - started) / 1000) });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killGroup(child.pid);
    }, timeoutSec * 1000);

    child.on('error', (err) => {
      writeSync(fd, `\n[harness] failed to start ${argv[0]}: ${err.message}\n`);
      finish(127);
    });
    child.on('exit', (code, signal) => finish(code ?? 128 + (constants.signals[signal] ?? 0)));
  });
}
