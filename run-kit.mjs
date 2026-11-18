import { spawn } from 'node:child_process';
import fs from 'node:fs';

const child = spawn('node', [
  '--experimental-strip-types',
  '/home/hatch/workspace/makefun/github-core-clone-01-kit/github-core-clone-01-kit/sdk/run.ts',
  '--url', 'http://127.0.0.1:18716',
  '--token', 'test-token-123',
  '--json'
]);

let out = '';
child.stdout.on('data', d => out += d);
child.stderr.on('data', d => process.stderr.write(d));
child.on('close', code => {
  if (out) {
    fs.writeFileSync('/home/hatch/workspace/makefun/entry-github-core-clone/runner-s4.json', out);
  }
  console.log('Runner exited with code', code);
});
