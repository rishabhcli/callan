import { spawn } from 'node:child_process';

const procs = [
  spawn('node', ['server/index.js'], { stdio: 'inherit', env: process.env }),
  spawn('npm', ['exec', 'vite'], { stdio: 'inherit', env: process.env })
];

const shutdown = (sig) => {
  for (const p of procs) if (!p.killed) p.kill(sig);
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

for (const p of procs) {
  p.on('exit', (code) => {
    if (code && code !== 0) {
      for (const other of procs) if (other !== p && !other.killed) other.kill('SIGTERM');
      process.exit(code);
    }
  });
}
