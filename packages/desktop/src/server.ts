// Local HTTP server of the desktop app: serves the web app (packages/web/dist) to the app's windows and the
// file API of FileHost (the embedded mode `?host=http` of the web app, the same protocol as the Eclipse
// plugin). It binds to the loopback interface only, rejects requests whose Host header is not a loopback name
// (DNS rebinding) or that come from a foreign origin, and answers only below `/s/<token>/` (random tokens of
// the opened files and folders).
//
// Why HTTP and not a custom protocol / IPC: the web app is shared with the Eclipse plugin, whose browser
// widget can only reach the plugin over HTTP. With the same transport the page needs no second code path.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import type { FileHost } from './file-host.js';

/** The loopback address the server binds to. */
export const SERVER_HOST = '127.0.0.1';

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

/** True if a request may change something: no foreign Origin (a web site must not post to the API). */
export function isSameOrigin(request: http.IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) {
        return true;
    }
    try {
        return new URL(origin).host === request.headers.host;
    } catch {
        return false;
    }
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

export interface ServerOptions {
    files: StaticFiles;
    host: FileHost;
}

/** Creates the (not yet listening) HTTP server. */
export function createServer(options: ServerOptions): http.Server {
    return http.createServer((request, response) => {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        if (!isLoopbackHost(request.headers.host)) {
            send(response, 403, 'Forbidden: only requests to 127.0.0.1 / localhost are answered\n');
            return;
        }
        if (!isSameOrigin(request)) {
            send(response, 403, 'Forbidden: foreign origin\n');
            return;
        }
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/s/')) {
            send(response, 404, 'Not found\n');
            return;
        }
        options.host.handle(request, response, url, `http://${request.headers.host}/`).then(file => {
            if (file !== undefined) {
                serveStatic(request, response, options.files, fileOfPath(`/${file}`));
            }
        }, error => {
            if (!response.headersSent) {
                send(response, 500, `${error instanceof Error ? error.message : String(error)}\n`);
            }
        });
    });
}

function serveStatic(request: http.IncomingMessage, response: http.ServerResponse, files: StaticFiles, file: string | undefined): void {
    const content = file === undefined ? undefined : files.get(file);
    if (file === undefined || content === undefined) {
        send(response, 404, 'Not found\n');
        return;
    }
    // Vite puts content hashes into the names of the files in assets/
    response.setHeader('Cache-Control', file.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    send(response, 200, content, contentTypes[path.posix.extname(file).toLowerCase()] ?? 'application/octet-stream', request.method === 'HEAD');
}

function send(response: http.ServerResponse, status: number, body: string | Uint8Array, type = 'text/plain; charset=utf-8', headOnly = false): void {
    const data = typeof body === 'string' ? Buffer.from(body) : body;
    response.writeHead(status, { 'Content-Type': type, 'Content-Length': data.byteLength });
    response.end(headOnly ? undefined : data);
}

/** Starts listening on a free port of the loopback interface; resolves with the base URL. */
export function listen(server: http.Server, port = 0): Promise<string> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve(`http://${SERVER_HOST}:${(server.address() as AddressInfo).port}/`);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, SERVER_HOST);
    });
}
