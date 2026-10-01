import type * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { browserCommand } from '../src/open-browser.js';
import { APP_ID, createUiServer, fileOfPath, isLoopbackHost, listen, runningInstance, uiUrl } from '../src/ui-server.js';

const files = new Map<string, Uint8Array>([
    ['index.html', Buffer.from('<!doctype html><title>HSM Modeler</title>')],
    ['assets/index-abc.js', Buffer.from('console.log(1)')],
    ['assets/codicon.ttf', Buffer.from([0, 1, 2])]
]);

describe('fileOfPath', () => {
    it('maps request paths to files of the web root', () => {
        expect(fileOfPath('/')).toBe('index.html');
        expect(fileOfPath('/assets/index-abc.js')).toBe('assets/index-abc.js');
        expect(fileOfPath('/assets/')).toBe('assets/index.html');
        expect(fileOfPath('/a%20b.js')).toBe('a b.js');
    });

    it('never leaves the web root', () => {
        expect(fileOfPath('/../secret')).toBe('secret');
        expect(fileOfPath('/assets/../../../etc/passwd')).toBe('etc/passwd');
        expect(fileOfPath('/%2e%2e/%2e%2e/etc/passwd')).toBe('etc/passwd');
        expect(fileOfPath('/..%5c..%5csecret')).toBeUndefined();
        expect(fileOfPath('/a%00.js')).toBeUndefined();
        expect(fileOfPath('/%E0%A4%A')).toBeUndefined();
    });
});

describe('isLoopbackHost', () => {
    it('accepts loopback names only', () => {
        expect(isLoopbackHost('127.0.0.1:51734')).toBe(true);
        expect(isLoopbackHost('localhost:8080')).toBe(true);
        expect(isLoopbackHost('LOCALHOST')).toBe(true);
        expect(isLoopbackHost('[::1]:3000')).toBe(true);
        expect(isLoopbackHost('evil.example')).toBe(false);
        expect(isLoopbackHost('127.0.0.1.evil.example:80')).toBe(false);
        expect(isLoopbackHost(undefined)).toBe(false);
    });
});

describe('browserCommand', () => {
    it('uses the opener of the platform', () => {
        expect(browserCommand('http://127.0.0.1:1/', 'darwin')).toEqual(['open', ['http://127.0.0.1:1/']]);
        expect(browserCommand('http://127.0.0.1:1/', 'linux')).toEqual(['xdg-open', ['http://127.0.0.1:1/']]);
        expect(browserCommand('http://127.0.0.1:1/', 'win32')[0]).toBe('rundll32');
    });
});

describe('UI server', () => {
    let server: http.Server | undefined;
    afterEach(() => {
        server?.close();
        server = undefined;
    });

    async function start(): Promise<string> {
        server = createUiServer({ files: { get: file => files.get(file) }, version: '1.2.3' });
        return uiUrl(await listen(server, 0));
    }

    it('serves the files of the web app', async () => {
        const url = await start();
        const index = await fetch(url);
        expect(index.status).toBe(200);
        expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(index.headers.get('cache-control')).toBe('no-cache');
        expect(await index.text()).toContain('HSM Modeler');
        const script = await fetch(`${url}assets/index-abc.js`);
        expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
        expect(script.headers.get('cache-control')).toContain('immutable');
        expect((await fetch(`${url}assets/codicon.ttf`)).headers.get('content-type')).toBe('font/ttf');
        expect((await fetch(`${url}missing.js`)).status).toBe(404);
        expect((await fetch(url, { method: 'POST' })).status).toBe(405);
    });

    it('reports itself at /api/info', async () => {
        const url = await start();
        expect(await (await fetch(`${url}api/info`)).json()).toMatchObject({ app: APP_ID, version: '1.2.3' });
        expect(await runningInstance(Number(new URL(url).port))).toBe('1.2.3');
    });

    it('rejects requests with a foreign Host header (DNS rebinding)', async () => {
        const url = await start();
        const { request } = await import('node:http');
        const status = await new Promise<number | undefined>((resolve, reject) => {
            request(url, { headers: { host: 'attacker.example' } }, response => {
                response.resume();
                resolve(response.statusCode);
            }).on('error', reject).end();
        });
        expect(status).toBe(403);
    });
});
