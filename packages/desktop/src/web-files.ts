// The static files of the web app (packages/web/dist, copied to dist/web by scripts/build.mjs).
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StaticFiles } from './server.js';

/** All files below a directory, as paths with `/` relative to it. */
export function listFiles(dir: string, prefix = ''): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
        ? listFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`)
        : entry.isFile() ? [`${prefix}${entry.name}`] : []);
}

/** The files of a directory (read once, kept in memory). */
export function directoryWebFiles(dir: string): StaticFiles {
    const files = new Map(listFiles(dir).map(file => [file, new Uint8Array(fs.readFileSync(path.join(dir, ...file.split('/'))))]));
    return { get: file => files.get(file) };
}
