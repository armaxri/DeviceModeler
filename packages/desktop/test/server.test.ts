import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileHost, resolveInRoot, type FileHostListener, type Session } from '../src/file-host.js';
import { createServer, fileOfPath, isLoopbackHost, listen } from '../src/server.js';

const files = new Map<string, Uint8Array>([
    ['index.html', Buffer.from('<!doctype html><title>HSM Modeler</title>')],
    ['assets/index-abc.js', Buffer.from('console.log(1)')],
    ['assets/codicon.ttf', Buffer.from([0, 1, 2])]
]);

describe('fileOfPath', () => {
    it('maps request paths to files of the web root', () => {
        expect(fileOfPath('/')).toBe('index.html');
        expect(fileOfPath('/assets/index-abc.js')).toBe('assets/index-abc.js');
        expect(fileOfPath('/a%20b.js')).toBe('a b.js');
    });

    it('never leaves the web root', () => {
        expect(fileOfPath('/../secret')).toBe('secret');
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
        expect(isLoopbackHost('[::1]:3000')).toBe(true);
        expect(isLoopbackHost('evil.example')).toBe(false);
        expect(isLoopbackHost('127.0.0.1.evil.example:80')).toBe(false);
        expect(isLoopbackHost(undefined)).toBe(false);
    });
});

describe('resolveInRoot', () => {
    let root: string;
    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-root-')));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('resolves paths below the root', () => {
        expect(resolveInRoot(root, 'a/b.hsm')).toBe(path.join(root, 'a', 'b.hsm'));
        expect(resolveInRoot(root, 'a\\b.hsm')).toBe(path.join(root, 'a', 'b.hsm'));
        expect(resolveInRoot(root, 'a/../b.hsm')).toBe(path.join(root, 'b.hsm'));
    });

    it('rejects paths leaving the root', () => {
        expect(() => resolveInRoot(root, '../x.hsm')).toThrow(/outside/);
        expect(() => resolveInRoot(root, '/etc/passwd')).toThrow(/Invalid/);
        expect(() => resolveInRoot(root, 'C:/x')).toThrow(/Invalid/);
        expect(() => resolveInRoot(root, '')).toThrow(/Invalid/);
        expect(() => resolveInRoot(root, 'a\0b')).toThrow(/Invalid/);
    });

    it.skipIf(process.platform === 'win32')('rejects symbolic links leading outside', () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-outside-'));
        try {
            fs.symlinkSync(outside, path.join(root, 'link'));
            expect(() => resolveInRoot(root, 'link/x.hsm')).toThrow(/leads outside/);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});

describe('server with file host', () => {
    let root: string;
    let server: http.Server | undefined;
    let host: FileHost;
    const events: string[] = [];

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-host-')));
        fs.mkdirSync(path.join(root, 'models', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(root, 'models', 'gate.hsm'), 'statemachine Gate {}\n');
        fs.writeFileSync(path.join(root, 'models', 'sub', 'motor.hsm'), 'statemachine Motor {}\n');
        fs.writeFileSync(path.join(root, 'types.h'), 'struct A {};\n');
        fs.writeFileSync(path.join(root, 'readme.txt'), 'not importable');
        fs.writeFileSync(path.join(root, 'hsm.gen.json'), '{"root":true}');
        fs.writeFileSync(path.join(root, 'models', 'hsm.gen.json'), '{"near":true}');
        events.length = 0;
    });
    afterEach(() => {
        host?.close();
        server?.close();
        server = undefined;
        fs.rmSync(root, { recursive: true, force: true });
    });

    async function start(listener: FileHostListener = {}): Promise<string> {
        host = new FileHost({
            watch: false,
            settingsFile: path.join(root, '.settings', 'page.json'),
            theme: () => 'dark',
            listener: {
                dirtyChanged: session => events.push(`dirty ${session.path} ${session.dirty}`),
                openFile: (_session, file) => events.push(`open ${path.relative(root, file)}`),
                ...listener
            }
        });
        server = createServer({ files: { get: file => files.get(file) }, host });
        return await listen(server, 0);
    }

    function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
        return fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain', ...headers } });
    }

    it('serves the web app only below the token of an opened file', async () => {
        const url = await start();
        const { page } = host.openFile(path.join(root, 'models', 'gate.hsm'), root);
        expect(page).toMatch(/^s\/[0-9a-f]{32}\/index\.html\?host=http$/);
        const index = await fetch(url + page);
        expect(index.status).toBe(200);
        expect(await index.text()).toContain('HSM Modeler');
        const script = await fetch(url + page.replace('index.html?host=http', 'assets/index-abc.js'));
        expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
        expect(script.headers.get('cache-control')).toContain('immutable');
        expect((await fetch(url)).status).toBe(404);
        expect((await fetch(`${url}index.html`)).status).toBe(404);
        expect((await fetch(`${url}s/${'0'.repeat(32)}/index.html`)).status).toBe(404);
        expect((await fetch(`${url}s/${'0'.repeat(32)}/api/document`)).status).toBe(404);
    });

    it('provides the document, its imports and generator configurations', async () => {
        const url = await start();
        const { page } = host.openFile(path.join(root, 'models', 'gate.hsm'), root);
        const api = url + page.replace('index.html?host=http', 'api/');
        const document = await (await fetch(`${api}document`)).json();
        expect(document).toEqual({
            fileName: 'gate.hsm',
            path: 'models/gate.hsm',
            text: 'statemachine Gate {}\n',
            files: { 'models/sub/motor.hsm': 'statemachine Motor {}\n', 'types.h': 'struct A {};\n' },
            configs: [{ path: 'models/hsm.gen.json', text: '{"near":true}' }, { path: 'hsm.gen.json', text: '{"root":true}' }],
            theme: 'dark'
        });
        expect(await (await fetch(`${api}file?path=hsm.gen.json`)).text()).toBe('{"root":true}');
        expect((await fetch(`${api}file?path=../../etc/passwd`)).status).toBe(403);
        expect((await fetch(`${api}file?path=missing.h`)).status).toBe(404);
    });

    it('tracks the dirty state and saves', async () => {
        const url = await start();
        const { session, page } = host.openFile(path.join(root, 'models', 'gate.hsm'), root);
        const api = url + page.replace('index.html?host=http', 'api/');
        await fetch(`${api}document`);
        expect((await post(`${api}changed`, 'statemachine Gate { }\n')).status).toBe(204);
        expect(session.dirty).toBe(true);
        expect((await post(`${api}save`, 'statemachine Gate { }\n')).status).toBe(204);
        expect(fs.readFileSync(path.join(root, 'models', 'gate.hsm'), 'utf-8')).toBe('statemachine Gate { }\n');
        expect(session.dirty).toBe(false);
        expect(events).toEqual(['dirty models/gate.hsm true', 'dirty models/gate.hsm false']);
        expect(fs.readdirSync(path.join(root, 'models')).filter(name => name.endsWith('.tmp'))).toEqual([]);
    });

    it('lets the app save new models itself', async () => {
        const saved: Array<[Session, string]> = [];
        const url = await start({ saveRequested: (session, text) => { saved.push([session, text]); return Promise.resolve(false); } });
        const { page } = host.openFile(path.join(root, 'new.hsm'), root);
        const api = url + page.replace('index.html?host=http', 'api/');
        expect((await (await fetch(`${api}document`)).json()).text).toBe('');
        expect((await post(`${api}save`, 'x')).status).toBe(409);
        expect(saved.map(([session, text]) => [session.path, text])).toEqual([['new.hsm', 'x']]);
        expect(fs.existsSync(path.join(root, 'new.hsm'))).toBe(false);
    });

    it('opens, exports and generates within the root only', async () => {
        const url = await start();
        const { page } = host.openFile(path.join(root, 'models', 'gate.hsm'), root);
        const api = url + page.replace('index.html?host=http', 'api/');
        // paths relative to the root (host.ts) and, for older pages, to the edited file
        expect((await post(`${api}open`, 'models/sub/motor.hsm')).status).toBe(204);
        expect((await post(`${api}open`, 'sub/motor.hsm')).status).toBe(204);
        expect((await post(`${api}open`, 'missing.hsm')).status).toBe(404);
        expect((await post(`${api}open`, '../../x.hsm')).status).toBe(403);
        expect(events).toEqual([`open ${path.join('models', 'sub', 'motor.hsm')}`, `open ${path.join('models', 'sub', 'motor.hsm')}`]);

        const exported = await fetch(`${api}export?fileName=${encodeURIComponent('../../gate.svg')}`, { method: 'POST', body: '<svg/>' });
        expect(await exported.json()).toEqual({ message: 'Exported models/gate.svg.' });
        expect(fs.readFileSync(path.join(root, 'models', 'gate.svg'), 'utf-8')).toBe('<svg/>');

        const generate = (paths: string[]) => post(`${api}generate`, JSON.stringify({ files: paths.map(p => ({ path: p, content: `// ${p}` })), messages: [] }), { 'Content-Type': 'application/json' });
        expect(await (await generate(['gen/Gate.h', 'gen/Gate.cpp'])).json()).toEqual({ message: 'Generated 2 files (2 changed).' });
        expect(await (await generate(['gen/Gate.h'])).json()).toEqual({ message: 'Generated 1 files (0 changed).' });
        expect(fs.readFileSync(path.join(root, 'gen', 'Gate.cpp'), 'utf-8')).toBe('// gen/Gate.cpp');
        expect((await generate(['../outside.h'])).status).toBe(403);
        expect(fs.existsSync(path.join(root, '..', 'outside.h'))).toBe(false);
        expect((await post(`${api}generate`, '{')).status).toBe(400);
    });

    it('stores the page settings', async () => {
        const url = await start();
        const { page } = host.openFile(path.join(root, 'models', 'gate.hsm'), root);
        const api = url + page.replace('index.html?host=http', 'api/');
        expect((await post(`${api}settings`, '{"theme":"dark"}')).status).toBe(204);
        expect(fs.readFileSync(path.join(root, '.settings', 'page.json'), 'utf-8')).toBe('{"theme":"dark"}');
        expect((await (await fetch(`${api}document`)).json()).settings).toBe('{"theme":"dark"}');
        expect((await post(`${api}model`, '{"textLength":0,"problems":[],"outline":[]}')).status).toBe(204);
    });

    it('lists the models of an opened folder', async () => {
        const url = await start();
        const folder = url + host.openFolder(root);
        const list = await (await fetch(folder)).text();
        expect(list).toContain('href="open?path=models%2Fgate.hsm"');
        expect(list).toContain('models/sub/motor.hsm');
        const opened = await fetch(`${folder}open?path=models%2Fgate.hsm`, { redirect: 'manual' });
        expect(opened.status).toBe(303);
        expect(opened.headers.get('location')).toMatch(/\/s\/[0-9a-f]{32}\/index\.html\?host=http$/);
        expect((await fetch(`${folder}open?path=..%2Fx`, { redirect: 'manual' })).status).toBe(403);
    });

    it('rejects foreign hosts and origins', async () => {
        const url = await start();
        const { page } = host.openFile(path.join(root, 'models', 'gate.hsm'), root);
        const api = url + page.replace('index.html?host=http', 'api/');
        expect((await post(`${api}save`, 'evil', { Origin: 'https://evil.example' })).status).toBe(403);
        expect(fs.readFileSync(path.join(root, 'models', 'gate.hsm'), 'utf-8')).toBe('statemachine Gate {}\n');
        const { request } = await import('node:http');
        const status = await new Promise<number | undefined>((resolve, reject) => {
            request(`${api}document`, { headers: { host: 'attacker.example' } }, response => {
                response.resume();
                resolve(response.statusCode);
            }).on('error', reject).end();
        });
        expect(status).toBe(403);
    });

    it('reports changes on disk', async () => {
        const changes: string[] = [];
        host = new FileHost({ listener: { externalChange: (session, replaceText) => changes.push(`${session.path} ${replaceText}`) } });
        const { session } = host.openFile(path.join(root, 'models', 'gate.hsm'), root);
        session.diskText = 'statemachine Gate {}\n';
        await new Promise(resolve => setTimeout(resolve, 100));
        fs.writeFileSync(path.join(root, 'models', 'sub', 'motor.hsm'), 'statemachine Motor { }\n');
        fs.writeFileSync(path.join(root, 'models', 'gate.hsm'), 'statemachine Gate { }\n');
        for (let i = 0; i < 50 && !changes.includes('models/gate.hsm true'); i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        // (the watcher may also report the files created before it started)
        expect([...new Set(changes)].sort()).toEqual(['models/gate.hsm false', 'models/gate.hsm true']);
    });
});
