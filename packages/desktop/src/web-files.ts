// The static files of the web app: embedded as assets of the single executable application (SEA), or read
// from a directory when the bundle runs in a normal Node.js (`node dist/hsm.cjs`, used during development).
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StaticFiles } from './ui-server.js';

/** Name of the SEA asset listing the files of the web app (written by scripts/build.mjs). */
export const WEB_MANIFEST = 'web-manifest.json';

/** Prefix of the SEA asset keys of the web app files. */
export const WEB_ASSET_PREFIX = 'web/';

interface SeaModule {
    isSea(): boolean;
    getAsset(key: string): ArrayBuffer;
}

function seaModule(): SeaModule | undefined {
    try {
        // `node:sea` exists since Node.js 20; required lazily so the module also loads in tests
        const sea = (typeof require === 'function' ? require('node:sea') : undefined) as SeaModule | undefined;
        return sea?.isSea() ? sea : undefined;
    } catch {
        return undefined;
    }
}

/** The files embedded in the executable, `undefined` if this is not a single executable application. */
export function embeddedWebFiles(): StaticFiles | undefined {
    const sea = seaModule();
    if (!sea) {
        return undefined;
    }
    const files = new Set(JSON.parse(Buffer.from(sea.getAsset(WEB_MANIFEST)).toString('utf-8')) as string[]);
    const cache = new Map<string, Uint8Array>();
    return {
        get(file) {
            if (!files.has(file)) {
                return undefined;
            }
            let content = cache.get(file);
            if (!content) {
                content = new Uint8Array(sea.getAsset(WEB_ASSET_PREFIX + file));
                cache.set(file, content);
            }
            return content;
        }
    };
}

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
