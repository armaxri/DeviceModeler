// Packages the built extension (run `node scripts/build.mjs` first) into `hsm-vscode-<version>.vsix`
// with @vscode/vsce. All code is bundled, so no node_modules are packaged (`dependencies: false`).
import { createVSIX } from '@vscode/vsce';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8'));
const packagePath = path.join(root, `${name}-${version}.vsix`);
await createVSIX({ cwd: root, packagePath, dependencies: false, allowMissingRepository: true });
console.log(`packaged ${path.relative(process.cwd(), packagePath)}`);
