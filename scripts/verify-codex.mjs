import { spawnSync } from 'node:child_process';

const command = process.env.CODEX_COMMAND?.trim() || 'codex';

console.log(`Checking Codex CLI availability via "${command} --version"...`);

const result = spawnSync(command, ['--version'], {
  stdio: 'inherit',
  shell: false
});

if (result.error) {
  console.error(`Failed to execute "${command} --version":`, result.error);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`"${command} --version" exited with status ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log('Codex CLI detected.');
