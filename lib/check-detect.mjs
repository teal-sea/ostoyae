import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON } from './cli-config.mjs';

export function detectCheck(repo) {
  const has = p => existsSync(join(repo, p));
  if (has('package.json')) {
    const pkg = readJSON(join(repo, 'package.json'), 'package');
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('package.json must contain an object');
    if (pkg.scripts?.test) return 'npm test';
  }
  if (has('Cargo.toml')) return 'cargo test';
  if (has('go.mod')) return 'go test ./...';
  if (has('pytest.ini') || has('tests') || has('pyproject.toml') || has('setup.cfg')) return 'pytest -q';
  if (has('lakefile.toml') || has('lakefile.lean')) return 'lake build';
  return null;
}
