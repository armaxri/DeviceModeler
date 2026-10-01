// File access of the desktop app: the host side of the web app's embedded mode (`?host=http`,
// packages/web/src/host.ts) for files on disk. It implements the same HTTP API as the Eclipse plugin
// (eclipse-plugin/…/WebServer.java), so the web app has one protocol for every host:
//
//   /s/<token>/index.html?host=http   the web app editing one file (one random token per opened file)
//   /s/<token>/api/…                  the API of host.ts: document, file, changed, save, model, settings,
//                                     open, export, generate
//   /s/<folder token>/                an opened folder: the list of its models
//
// Every session has a root folder (the opened folder, or the folder of the opened file): all paths of the API
// are relative to it (with `/`), nothing outside of it is read or written (`..` and symbolic links leaving
// the root are rejected). Requests without a known token are rejected, so other local processes and web
// sites cannot read or write files (the token is only in the URL of the app's window).
//
// Like Eclipse, the app calls functions of the page for the other direction (`hsmApp.reloadFromHost()` after
// changes on disk, see `FileHostListener.externalChange`).
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as path from 'node:path';

/** Files a model may import: other models and C/C++ headers (as in the Eclipse plugin). */
export const IMPORTABLE = /\.(hsm|h|hh|hpp|hxx|h\+\+|inl)$/i;
/** Generator configurations (`hsm generate`). */
export const GENERATOR_CONFIG = /^(hsm\.gen\.json|.+\.hsm\.gen\.json)$/;

const MAX_FILES = 500;
const MAX_FILE_SIZE = 2_000_000;
const MAX_TOTAL_SIZE = 30_000_000;
const MAX_BODY_SIZE = 50_000_000;
const SKIPPED_FOLDERS = new Set(['node_modules']);

/** One opened file (one window of the web app). */
export interface Session {
    readonly token: string;
    /** The boundary of the session: real path of a folder. */
    readonly root: string;
    /** Path relative to the root, with `/`. */
    readonly path: string;
    /** The text on disk as last loaded or saved (to tell own saves from external changes). */
    diskText?: string;
    /** The page has unsaved changes. */
    dirty: boolean;
}

/** Notifications of the host to the app (all optional). */
export interface FileHostListener {
    /** The dirty state of a session changed (or it was saved). */
    dirtyChanged?(session: Session): void;
    /** The page asks to open another file (double-click on a submachine state). */
    openFile?(session: Session, file: string): void;
    /**
     * The page asks to save (`api/save`): a promise if the app saves itself (e.g. a new model that needs a
     * file name first; false: not saved), undefined to let the host write the file.
     */
    saveRequested?(session: Session, text: string): Promise<boolean> | undefined;
    /** Files of the root of a session changed on disk; `replaceText`: the edited file itself changed. */
    externalChange?(session: Session, replaceText: boolean): void;
}

export interface FileHostOptions {
    /** File storing the page settings (`api/settings`), shared by all pages; none: kept in memory. */
    settingsFile?: string;
    /** The theme of the host (`HostDocument.theme`). */
    theme?: () => 'light' | 'dark';
    /** Watch the roots and report changes on disk (default: true). */
    watch?: boolean;
    listener?: FileHostListener;
}

export class HttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

/**
 * The resolved file of a path relative to the root; throws an HttpError (403) if the path leaves the root
 * (`..`, absolute paths, symbolic links pointing outside).
 */
export function resolveInRoot(root: string, relative: string): string {
    const normalized = relative.replace(/\\/g, '/');
    if (normalized === '' || normalized.includes('\0') || path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
        throw new HttpError(403, `Invalid path '${relative}'`);
    }
    const file = path.resolve(root, ...normalized.split('/'));
    if (!isInside(root, file)) {
        throw new HttpError(403, `The path '${relative}' is outside of ${root}`);
    }
    // symbolic links: the nearest existing ancestor must really be inside the root
    let existing = file;
    while (!fs.existsSync(existing) && existing !== root) {
        existing = path.dirname(existing);
    }
    if (!isInside(root, fs.realpathSync(existing))) {
        throw new HttpError(403, `The path '${relative}' leads outside of ${root}`);
    }
    return file;
}

export function isInside(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The path of a file relative to the root, with `/`. */
function relativePath(root: string, file: string): string {
    return path.relative(root, file).split(path.sep).join('/');
}

/** The real path of a file that may not exist yet (its folder must exist). */
function realFile(file: string): string {
    const absolute = path.resolve(file);
    return fs.existsSync(absolute) ? fs.realpathSync(absolute) : path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
}

interface Watch {
    watcher?: fs.FSWatcher;
    users: number;
}

export class FileHost {
    private readonly sessions = new Map<string, Session>();
    /** Opened folders: token → real path. */
    private readonly folders = new Map<string, string>();
    private readonly watches = new Map<string, Watch>();
    private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
    private settings?: string;

    constructor(private readonly options: FileHostOptions = {}) {
        try {
            this.settings = options.settingsFile ? fs.readFileSync(options.settingsFile, 'utf-8') : undefined;
        } catch {
            // no settings stored yet
        }
    }

    /**
     * Opens a file (it may not exist yet: it is created by the first save) in a new session; `root`: the
     * boundary (default: the folder of the file). Returns the session and the URL path of its page.
     */
    openFile(file: string, root?: string): { session: Session, page: string } {
        const real = realFile(file);
        const realRoot = fs.realpathSync(root ?? path.dirname(real));
        if (!isInside(realRoot, real)) {
            throw new Error(`${file} is not inside of ${realRoot}`);
        }
        const session: Session = { token: newToken(), root: realRoot, path: relativePath(realRoot, real), dirty: false };
        this.sessions.set(session.token, session);
        this.watch(realRoot);
        return { session, page: pagePath(session.token) };
    }

    /** Opens a folder: returns the URL path of the page listing its models. */
    openFolder(folder: string): string {
        const token = newToken();
        this.folders.set(token, fs.realpathSync(folder));
        return `s/${token}/`;
    }

    /** The session of a token. */
    session(token: string): Session | undefined {
        return this.sessions.get(token);
    }

    /** The absolute file of a session. */
    fileOf(session: Session): string {
        return path.join(session.root, ...session.path.split('/'));
    }

    /** Ends a session (its window was closed). */
    closeSession(token: string): void {
        const session = this.sessions.get(token);
        if (session) {
            this.sessions.delete(token);
            this.unwatch(session.root);
        }
    }

    close(): void {
        for (const token of [...this.sessions.keys()]) {
            this.closeSession(token);
        }
        for (const timer of this.pending.values()) {
            clearTimeout(timer);
        }
    }

    /** Saves the text of a session (`api/save`, or the app on closing a window). */
    save(session: Session, text: string): void {
        const file = resolveInRoot(session.root, session.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        session.diskText = text;
        writeFileAtomic(file, text);
        this.setDirty(session, false);
    }

    private setDirty(session: Session, dirty: boolean): void {
        session.dirty = dirty;
        this.options.listener?.dirtyChanged?.(session);
    }

    /**
     * Handles a request below `/s/`; returns the static file of the web app to serve (`index.html`,
     * `assets/…`) if it is not an API request, or `undefined` if the request was answered.
     */
    async handle(request: http.IncomingMessage, response: http.ServerResponse, url: URL, serverUrl: string): Promise<string | undefined> {
        const match = /^\/s\/([0-9a-f]{32})\/(.*)$/.exec(url.pathname);
        const token = match?.[1] ?? '';
        const rest = match?.[2] ?? '';
        const folder = this.folders.get(token);
        if (folder) {
            this.handleFolder(folder, request, response, url, rest, serverUrl);
            return undefined;
        }
        const session = this.sessions.get(token);
        if (!session) {
            send(response, 404, 'Unknown session (the file was closed)\n');
            return undefined;
        }
        if (!rest.startsWith('api/')) {
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                send(response, 405, 'Method not allowed\n');
                return undefined;
            }
            return rest === '' ? 'index.html' : rest;
        }
        try {
            await this.handleApi(session, `${request.method} ${rest.substring('api/'.length)}`, request, response, url);
        } catch (error) {
            const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : 500;
            send(response, status, `${error instanceof Error ? error.message : String(error)}\n`);
        }
        return undefined;
    }

    private async handleApi(session: Session, operation: string, request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
        switch (operation) {
            case 'GET document': {
                sendJson(response, 200, this.document(session));
                return;
            }
            case 'GET file': {
                const file = resolveInRoot(session.root, url.searchParams.get('path') ?? '');
                if (!isFile(file)) {
                    throw new HttpError(404, 'Not found');
                }
                send(response, 200, fs.readFileSync(file, 'utf-8'));
                return;
            }
            case 'POST changed': {
                const dirty = await readBody(request, 'utf-8') !== session.diskText;
                if (dirty !== session.dirty) {
                    this.setDirty(session, dirty);
                }
                sendEmpty(response);
                return;
            }
            case 'POST save': {
                const text = await readBody(request, 'utf-8');
                const saving = this.options.listener?.saveRequested?.(session, text);
                if (saving) {
                    if (!await saving) {
                        throw new HttpError(409, 'Not saved');
                    }
                } else {
                    this.save(session, text);
                }
                sendEmpty(response);
                return;
            }
            case 'POST model': {
                // problems and outline of the model: the page shows them itself
                await readBody(request, 'utf-8');
                sendEmpty(response);
                return;
            }
            case 'POST settings': {
                const json = await readBody(request, 'utf-8');
                JSON.parse(json);
                this.settings = json;
                if (this.options.settingsFile) {
                    fs.mkdirSync(path.dirname(this.options.settingsFile), { recursive: true });
                    fs.writeFileSync(this.options.settingsFile, json);
                }
                sendEmpty(response);
                return;
            }
            case 'POST open': {
                const file = resolveInRoot(session.root, this.pagePathOf(session, (await readBody(request, 'utf-8')).trim()));
                if (!isFile(file)) {
                    throw new HttpError(404, 'Not found');
                }
                this.options.listener?.openFile?.(session, file);
                sendEmpty(response);
                return;
            }
            case 'POST export': {
                const content = await readBody(request);
                const name = path.basename((url.searchParams.get('fileName') ?? 'diagram').replace(/\\/g, '/'));
                const target = path.posix.join(path.posix.dirname(session.path), name);
                writeFileAtomic(resolveInRoot(session.root, target), content);
                sendJson(response, 200, { message: `Exported ${target}.` });
                return;
            }
            case 'POST generate': {
                const generated = JSON.parse(await readBody(request, 'utf-8')) as { files?: Array<{ path: string, content: string }> };
                const files = (generated.files ?? []).map(file => ({ file: resolveInRoot(session.root, file.path), content: file.content }));
                let changed = 0;
                for (const { file, content } of files) {
                    if (!isFile(file) || fs.readFileSync(file, 'utf-8') !== content) {
                        fs.mkdirSync(path.dirname(file), { recursive: true });
                        writeFileAtomic(file, content);
                        changed++;
                    }
                }
                sendJson(response, 200, { message: `Generated ${files.length} files (${changed} changed).` });
                return;
            }
            default:
                throw new HttpError(404, `Unknown operation ${operation}`);
        }
    }

    /**
     * A path of the page (`api/open`): relative to the root (protocol of host.ts); older pages send paths
     * relative to the edited file, which are tried second.
     */
    private pagePathOf(session: Session, relative: string): string {
        try {
            if (isFile(resolveInRoot(session.root, relative))) {
                return relative;
            }
        } catch {
            // not a path relative to the root
        }
        return path.posix.join(path.posix.dirname(session.path), relative.replace(/\\/g, '/'));
    }

    /** `api/document` of a session (HostDocument of host.ts). */
    private document(session: Session): object {
        const file = resolveInRoot(session.root, session.path);
        // a new file is created by the first save
        const text = isFile(file) ? fs.readFileSync(file, 'utf-8') : '';
        session.diskText = text;
        return {
            fileName: path.posix.basename(session.path),
            path: session.path,
            text,
            files: importableFiles(session.root, session.path),
            configs: generatorConfigs(session.root, session.path),
            ...this.settings !== undefined ? { settings: this.settings } : {},
            ...this.options.theme ? { theme: this.options.theme() } : {}
        };
    }

    private handleFolder(root: string, request: http.IncomingMessage, response: http.ServerResponse, url: URL, rest: string, serverUrl: string): void {
        if (request.method !== 'GET') {
            send(response, 405, 'Method not allowed\n');
            return;
        }
        if (rest === 'open') {
            // a model of the list (or a new one): redirect to its page
            let name = (url.searchParams.get('path') ?? '').trim();
            if (name && !name.endsWith('.hsm')) {
                name += '.hsm';
            }
            try {
                const file = resolveInRoot(root, name);
                fs.mkdirSync(path.dirname(file), { recursive: true });
                const { page } = this.openFile(file, root);
                response.writeHead(303, { Location: serverUrl + page, 'Cache-Control': 'no-store' });
                response.end();
            } catch (error) {
                send(response, error instanceof HttpError ? error.status : 500, `${error instanceof Error ? error.message : error}\n`);
            }
            return;
        }
        if (rest !== '') {
            send(response, 404, 'Not found\n');
            return;
        }
        const items = models(root).map(model =>
            `<li><a href="open?path=${encodeURIComponent(model)}">${escapeHtml(model)}</a></li>`).join('\n');
        send(response, 200, folderPage(root, items), 'text/html; charset=utf-8');
    }

    // -----------------------------------------------------------------------------------------------------
    // Changes on disk

    private watch(root: string): void {
        if (this.options.watch === false) {
            return;
        }
        let watch = this.watches.get(root);
        if (!watch) {
            watch = { users: 0 };
            try {
                watch.watcher = fs.watch(root, { recursive: true, persistent: false }, (_type, name) => {
                    if (name) {
                        this.fileChanged(root, relativePath(root, path.resolve(root, name.toString())));
                    }
                });
                watch.watcher.on('error', () => watch?.watcher?.close());
            } catch {
                // recursive watching is not available: no reload on external changes
            }
            this.watches.set(root, watch);
        }
        watch.users++;
    }

    private unwatch(root: string): void {
        const watch = this.watches.get(root);
        if (watch && --watch.users <= 0) {
            watch.watcher?.close();
            this.watches.delete(root);
        }
    }

    private fileChanged(root: string, relative: string): void {
        if (!IMPORTABLE.test(relative) && !GENERATOR_CONFIG.test(path.posix.basename(relative))) {
            return;
        }
        // editors and git write files in several steps: wait until it is quiet
        const key = `${root}\0${relative}`;
        clearTimeout(this.pending.get(key));
        this.pending.set(key, setTimeout(() => {
            this.pending.delete(key);
            for (const session of this.sessions.values()) {
                if (session.root !== root) {
                    continue;
                }
                if (session.path !== relative) {
                    this.options.listener?.externalChange?.(session, false);
                    continue;
                }
                const file = this.fileOf(session);
                const text = isFile(file) ? fs.readFileSync(file, 'utf-8') : undefined;
                // deleted (the page keeps its text) or the own save
                if (text !== undefined && text !== session.diskText) {
                    this.options.listener?.externalChange?.(session, true);
                }
            }
        }, 200));
    }
}

/** URL path of the page of a session. */
function pagePath(token: string): string {
    return `s/${token}/index.html?host=http`;
}

/** The importable files below the root (without the edited file), by path relative to the root. */
export function importableFiles(root: string, exclude: string): Record<string, string> {
    const files: Record<string, string> = {};
    let count = 0;
    let total = 0;
    const collect = (dir: string) => {
        for (const entry of readDir(dir)) {
            if (count >= MAX_FILES || total > MAX_TOTAL_SIZE) {
                return;
            }
            const file = path.join(dir, entry.name);
            if (entry.isFile() && IMPORTABLE.test(entry.name)) {
                const relative = relativePath(root, file);
                const size = fs.statSync(file).size;
                if (relative !== exclude && size <= MAX_FILE_SIZE) {
                    files[relative] = fs.readFileSync(file, 'utf-8');
                    count++;
                    total += size;
                }
            } else if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name)) {
                collect(file);
            }
        }
    };
    collect(root);
    return files;
}

/** The generator configurations from the folder of the model up to the root, nearest first. */
export function generatorConfigs(root: string, model: string): Array<{ path: string, text: string }> {
    const configs: Array<{ path: string, text: string }> = [];
    let dir = path.dirname(resolveInRoot(root, model));
    for (;;) {
        for (const entry of readDir(dir)) {
            if (entry.isFile() && GENERATOR_CONFIG.test(entry.name)) {
                const file = path.join(dir, entry.name);
                configs.push({ path: relativePath(root, file), text: fs.readFileSync(file, 'utf-8') });
            }
        }
        if (dir === root || !isInside(root, dir)) {
            return configs;
        }
        dir = path.dirname(dir);
    }
}

/** All models below a folder. */
export function models(root: string): string[] {
    const result: string[] = [];
    const collect = (dir: string) => {
        for (const entry of readDir(dir)) {
            if (result.length >= MAX_FILES) {
                return;
            }
            if (entry.isFile() && entry.name.endsWith('.hsm')) {
                result.push(relativePath(root, path.join(dir, entry.name)));
            } else if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name)) {
                collect(path.join(dir, entry.name));
            }
        }
    };
    collect(root);
    return result;
}

function readDir(dir: string): fs.Dirent[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        return [];
    }
}

function newToken(): string {
    return randomBytes(16).toString('hex');
}

function isFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

/** Writes a file via a temporary file and a rename (no half written models). */
export function writeFileAtomic(file: string, content: string | Buffer): void {
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    fs.writeFileSync(temporary, content);
    try {
        fs.renameSync(temporary, file);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}

function readBody(request: http.IncomingMessage): Promise<Buffer>;
function readBody(request: http.IncomingMessage, encoding: 'utf-8'): Promise<string>;
function readBody(request: http.IncomingMessage, encoding?: 'utf-8'): Promise<Buffer | string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        request.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                reject(new HttpError(413, 'Request too large'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            resolve(encoding ? body.toString(encoding) : body);
        });
        request.on('error', reject);
    });
}

function send(response: http.ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
    const data = Buffer.from(body);
    response.writeHead(status, { 'Content-Type': type, 'Content-Length': data.byteLength, 'Cache-Control': 'no-store' });
    response.end(data);
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
    send(response, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function sendEmpty(response: http.ServerResponse): void {
    response.writeHead(204, { 'Cache-Control': 'no-store' });
    response.end();
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function folderPage(root: string, items: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(path.basename(root))}</title>
<style>
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #ffffff; --link: #0969da; --line: #d1d9e0; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f0f6fc; --muted: #9198a1; --bg: #0d1117; --link: #4493f8; --line: #3d444d; } }
  body { font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 32px 16px; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p { color: var(--muted); margin: 0 0 20px; word-break: break-all; }
  ul { list-style: none; padding: 0; margin: 0 0 24px; border-top: 1px solid var(--line); }
  li { border-bottom: 1px solid var(--line); }
  a { display: block; padding: 8px 4px; color: var(--link); text-decoration: none; font-family: ui-monospace, monospace; }
  a:hover { text-decoration: underline; }
  form { display: flex; gap: 8px; }
  input { flex: 1; font: inherit; padding: 4px 8px; min-width: 0; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(path.basename(root))}</h1>
<p>${escapeHtml(root)}</p>
<ul>
${items || '<li><p>No models (*.hsm) in this folder.</p></li>'}
</ul>
<form action="open" method="get">
  <input name="path" placeholder="new-model.hsm" aria-label="Path of a new model" required>
  <button type="submit">New model</button>
</form>
</main>
</body>
</html>
`;
}
