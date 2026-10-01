// Local HTTP server of the bundled web app (`hsm ui`). It serves the static files of packages/web/dist
// from memory (embedded in the executable), binds to the loopback interface only and rejects requests
// whose Host header is not a loopback name (protection against DNS rebinding). It has no write access
// to anything: the web app keeps its files in the browser (localStorage, Open… / Save downloads).
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

/** Name reported by `GET /api/info`, used to recognize a running instance. */
export const APP_ID = 'hsm-modeler';

/** The loopback address the server binds to. */
export const UI_HOST = '127.0.0.1';

/** Default port of `hsm ui`: fixed, because the browser storage of the web app is per origin (host and port). */
export const DEFAULT_UI_PORT = 51734;

/** The static files of the web app, by path relative to the web root (`index.html`, `assets/…`). */
export interface StaticFiles {
    get(file: string): Uint8Array | undefined;
}

const contentTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8'
};

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True if the Host header names the loopback interface (with any port). */
export function isLoopbackHost(host: string | undefined): boolean {
    if (!host) {
        return false;
    }
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    return loopbackHosts.has(name.toLowerCase());
}

/** The file of a request path: `/` is `index.html`; `undefined` for paths leaving the web root. */
export function fileOfPath(pathname: string): string | undefined {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return undefined;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) {
        return undefined;
    }
    const normalized = path.posix.normalize(decoded);
    if (!normalized.startsWith('/') || normalized.split('/').includes('..')) {
        return undefined;
    }
    const file = normalized.slice(1);
    return file === '' || file.endsWith('/') ? `${file}index.html` : file;
}

export interface UiServerOptions {
    files: StaticFiles;
    version: string;
}

/** Creates the (not yet listening) HTTP server of the web app. */
export function createUiServer(options: UiServerOptions): http.Server {
    return http.createServer((request, response) => {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        if (!isLoopbackHost(request.headers.host)) {
            send(response, 403, 'Forbidden: the HSM Modeler only answers requests to 127.0.0.1 / localhost\n');
            return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.setHeader('Allow', 'GET, HEAD');
            send(response, 405, 'Method not allowed\n');
            return;
        }
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (pathname === '/api/info') {
            response.setHeader('Cache-Control', 'no-store');
            send(response, 200, JSON.stringify({ app: APP_ID, version: options.version, pid: process.pid }), 'application/json; charset=utf-8', request.method === 'HEAD');
            return;
        }
        const file = fileOfPath(pathname);
        const content = file === undefined ? undefined : options.files.get(file);
        if (file === undefined || content === undefined) {
            send(response, 404, 'Not found\n');
            return;
        }
        // Vite puts content hashes into the names of the files in assets/
        response.setHeader('Cache-Control', file.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
        send(response, 200, content, contentTypes[path.posix.extname(file).toLowerCase()] ?? 'application/octet-stream', request.method === 'HEAD');
    });
}

function send(response: http.ServerResponse, status: number, body: string | Uint8Array, type = 'text/plain; charset=utf-8', headOnly = false): void {
    const data = typeof body === 'string' ? Buffer.from(body) : body;
    response.writeHead(status, { 'Content-Type': type, 'Content-Length': data.byteLength });
    response.end(headOnly ? undefined : data);
}

/** Starts listening on the loopback interface; resolves with the port (useful for port 0). */
export function listen(server: http.Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve((server.address() as AddressInfo).port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, UI_HOST);
    });
}

/** The URL of the web app served on a port. */
export function uiUrl(port: number): string {
    return `http://${UI_HOST}:${port}/`;
}

/** The version of the HSM Modeler running on a port, `undefined` if the port is used by something else. */
export async function runningInstance(port: number, timeoutMs = 1500): Promise<string | undefined> {
    try {
        const response = await fetch(`${uiUrl(port)}api/info`, { signal: AbortSignal.timeout(timeoutMs) });
        const info = await response.json() as { app?: unknown, version?: unknown };
        return info.app === APP_ID ? String(info.version) : undefined;
    } catch {
        return undefined;
    }
}
