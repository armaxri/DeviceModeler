// The HSM Modeler desktop app (Electron main process): one native window per opened model, showing the web
// app of packages/web in its embedded mode (`?host=http`, packages/web/src/host.ts), served by a loopback
// HTTP server of this process (server.ts) that reads and writes the files on disk (file-host.ts) - the same
// protocol as the Eclipse plugin. The app adds what a browser cannot do: native menus, file dialogs, recent
// files, file associations, dirty state and a confirmation before unsaved changes are lost.
//
// Command line: `HSM Modeler [file.hsm | folder]...`; `--smoke-test <model.hsm> --smoke-result <file.json>`
// opens the model in a hidden window, edits and saves it through the page and exits (used by CI).
import { app, BrowserWindow, dialog, Menu, nativeTheme, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileHost, isInside, writeFileAtomic, type Session } from './file-host.js';
import { createServer, listen } from './server.js';
import { directoryWebFiles } from './web-files.js';

declare const __HSM_VERSION__: string;
const version = typeof __HSM_VERSION__ === 'string' ? __HSM_VERSION__ : app.getVersion();

const PRODUCT = 'HSM Modeler';
/** Preferred port: the same origin in every run keeps the settings of the page (local storage). */
const PREFERRED_PORT = 51735;
const MAX_RECENT = 10;
const NEW_MODEL = `statemachine NewMachine {
    interface:
        in event start

    [*] -> Idle

    state Idle
}
`;

/** What a window shows. */
interface WindowState {
    /** The session of the edited file (undefined while the window shows a folder). */
    token?: string;
    /** The opened folder (folder windows; root of the models opened from it). */
    folder?: string;
    /** The model is not saved yet (`New`): Save asks for a file. */
    untitled?: boolean;
    /** The close was confirmed (or nothing was to be saved). */
    closing?: boolean;
    /** A save dialog is open (the menu and the page may both ask to save). */
    saving?: boolean;
}

const windows = new Map<BrowserWindow, WindowState>();
let host: FileHost;
let baseUrl = '';
let quitting = false;
let untitledCount = 0;
/** Files opened before the app was ready (macOS `open-file`, command line). */
const pendingPaths: string[] = [];

// ---------------------------------------------------------------------------------------------------------
// Command line

interface Arguments {
    paths: string[];
    smokeTest?: string;
    smokeResult?: string;
}

function parseArguments(argv: string[]): Arguments {
    const result: Arguments = { paths: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--smoke-test') {
            result.smokeTest = argv[++i];
        } else if (arg === '--smoke-result') {
            result.smokeResult = argv[++i];
        } else if (!arg.startsWith('-') && arg !== '.' && !arg.startsWith('psn_')) {
            result.paths.push(path.resolve(arg));
        }
    }
    return result;
}

/** The arguments of the app (without the executable, and without the main script in development). */
function appArguments(argv: string[]): string[] {
    return argv.slice(app.isPackaged ? 1 : 2);
}

const args = parseArguments(appArguments(process.argv));

// ---------------------------------------------------------------------------------------------------------
// Windows

function createWindow(state: WindowState): BrowserWindow {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 600,
        minHeight: 400,
        show: !args.smokeTest,
        title: PRODUCT,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            backgroundThrottling: !args.smokeTest,
            spellcheck: false
        }
    });
    windows.set(win, state);
    const contents = win.webContents;
    contents.setWindowOpenHandler(({ url }) => {
        // links of the page (documentation, …) open in the browser of the system
        if (/^https?:/.test(url) && !url.startsWith(baseUrl)) {
            void shell.openExternal(url);
        }
        return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
        if (!url.startsWith(baseUrl)) {
            event.preventDefault();
            if (/^https?:/.test(url)) {
                void shell.openExternal(url);
            }
        } else if (state.folder && /\/open\?/.test(url)) {
            // a model of the folder page: in a window of its own
            event.preventDefault();
            const window = createWindow({});
            void window.loadURL(url);
        }
    });
    contents.on('did-navigate', (_event, url) => {
        const token = /\/s\/([0-9a-f]{32})\/index\.html/.exec(url)?.[1];
        if (token && host.session(token) && token !== state.token) {
            if (state.token) {
                host.closeSession(state.token);
            }
            state.token = token;
            state.folder = undefined;
            const session = host.session(token)!;
            addRecent(host.fileOf(session));
        }
        updateTitle(win);
    });
    win.on('close', event => {
        if (!state.closing) {
            event.preventDefault();
            void confirmClose(win);
        }
    });
    win.on('closed', () => {
        if (state.token) {
            host.closeSession(state.token);
        }
        windows.delete(win);
    });
    return win;
}

function stateOf(win: BrowserWindow | undefined | null): WindowState | undefined {
    return win ? windows.get(win) : undefined;
}

function sessionOf(win: BrowserWindow | undefined | null): Session | undefined {
    const token = stateOf(win)?.token;
    return token ? host.session(token) : undefined;
}

function windowOfSession(session: Session): BrowserWindow | undefined {
    return [...windows].find(([, state]) => state.token === session.token)?.[0];
}

/** Opens a model in a window (or focuses the window that shows it); `root`: the boundary of its imports. */
function openFile(file: string, root?: string): BrowserWindow {
    const resolved = path.resolve(file);
    for (const [win, state] of windows) {
        const session = state.token ? host.session(state.token) : undefined;
        if (session && !state.untitled && host.fileOf(session) === safeRealPath(resolved)) {
            win.show();
            win.focus();
            return win;
        }
    }
    // the root: an opened folder containing the file, else the folder of the file
    root ??= [...windows.values()].map(state => state.folder).find(folder => folder && isInside(folder, safeRealPath(resolved)));
    const { session, page } = host.openFile(resolved, root);
    const win = createWindow({ token: session.token });
    void win.loadURL(baseUrl + page);
    addRecent(host.fileOf(session));
    return win;
}

function openFolder(folder: string): BrowserWindow {
    const real = fs.realpathSync(folder);
    const win = createWindow({ folder: real });
    void win.loadURL(baseUrl + host.openFolder(real));
    addRecent(real);
    updateTitle(win);
    return win;
}

/** A new model, saved to a file chosen on the first save. */
function newModel(): BrowserWindow {
    const folder = path.join(os.tmpdir(), `hsm-modeler-${process.pid}`);
    fs.mkdirSync(folder, { recursive: true });
    const name = `Untitled-${++untitledCount}.hsm`;
    fs.writeFileSync(path.join(folder, name), NEW_MODEL);
    const { session, page } = host.openFile(path.join(folder, name));
    const win = createWindow({ token: session.token, untitled: true });
    void win.loadURL(baseUrl + page);
    return win;
}

function openPath(file: string): void {
    try {
        if (fs.statSync(file).isDirectory()) {
            openFolder(file);
        } else {
            openFile(file);
        }
    } catch {
        if (file.endsWith('.hsm') && fs.existsSync(path.dirname(file))) {
            // a new model (created by the first save)
            openFile(file);
        } else {
            dialog.showErrorBox(PRODUCT, `${file} does not exist.`);
        }
    }
}

function updateTitle(win: BrowserWindow): void {
    const state = stateOf(win);
    const session = sessionOf(win);
    if (session) {
        const file = host.fileOf(session);
        const name = path.basename(file);
        win.setTitle(`${session.dirty ? '● ' : ''}${name}${state?.untitled ? '' : ` — ${path.dirname(file)}`}`);
        if (process.platform === 'darwin') {
            win.setRepresentedFilename(state?.untitled ? '' : file);
            win.setDocumentEdited(session.dirty);
        }
    } else if (state?.folder) {
        win.setTitle(`${path.basename(state.folder)} — ${state.folder}`);
    }
}

// ---------------------------------------------------------------------------------------------------------
// Page

/** Runs a script in the page (`window.hsmApp` is the web app). */
async function inPage<T>(contents: WebContents, script: string): Promise<T> {
    return await contents.executeJavaScript(script, true) as T;
}

/** The current text of the page (undefined if the page is not ready). */
async function pageText(win: BrowserWindow): Promise<string | undefined> {
    try {
        return await inPage<string | null>(win.webContents,
            'window.hsmApp && window.hsmApp.diagram ? (typeof window.hsmApp.getText === "function" ? window.hsmApp.getText() : window.hsmApp.editor.getValue()) : null') ?? undefined;
    } catch {
        return undefined;
    }
}

/** An edit command of the menu: by the web app if it offers it (`hostCommand`), else by Chromium. */
async function pageCommand(win: BrowserWindow, command: 'undo' | 'redo' | 'find'): Promise<void> {
    const handled = await inPage<boolean>(win.webContents,
        `!!(window.hsmApp && typeof window.hsmApp.hostCommand === "function" && window.hsmApp.hostCommand(${JSON.stringify(command)}))`).catch(() => false);
    if (!handled && command !== 'find') {
        win.webContents[command]();
    }
}

// ---------------------------------------------------------------------------------------------------------
// Save

/** Saves the model of a window (Save As for new models); false if it was not saved. */
async function save(win: BrowserWindow, text?: string): Promise<boolean> {
    const state = stateOf(win);
    const session = sessionOf(win);
    if (!state || !session) {
        return false;
    }
    if (state.untitled) {
        return await saveAs(win, text);
    }
    text ??= await pageText(win);
    if (text === undefined) {
        return false;
    }
    try {
        host.save(session, text);
        return true;
    } catch (error) {
        dialog.showErrorBox(PRODUCT, `Could not save ${host.fileOf(session)}: ${error instanceof Error ? error.message : error}`);
        return false;
    }
}

/** Saves the model under a new name and edits that file in the window from then on. */
async function saveAs(win: BrowserWindow, text?: string): Promise<boolean> {
    const state = stateOf(win);
    const session = sessionOf(win);
    if (!state || !session || state.saving) {
        return false;
    }
    text ??= await pageText(win);
    if (text === undefined) {
        return false;
    }
    state.saving = true;
    try {
        const result = await dialog.showSaveDialog(win, {
            title: 'Save Model',
            defaultPath: state.untitled ? path.join(app.getPath('documents'), path.basename(session.path)) : host.fileOf(session),
            filters: [{ name: 'State machine models', extensions: ['hsm'] }, { name: 'All files', extensions: ['*'] }]
        });
        if (result.canceled || !result.filePath) {
            return false;
        }
        writeFileAtomic(result.filePath, text);
        const old = state.token;
        const root = state.untitled ? undefined : [...windows.values()].map(s => s.folder).find(f => f && isInside(f, safeRealPath(result.filePath!)));
        const opened = host.openFile(result.filePath, root);
        state.token = opened.session.token;
        state.untitled = false;
        if (old) {
            host.closeSession(old);
        }
        addRecent(host.fileOf(opened.session));
        await win.loadURL(baseUrl + opened.page);
        return true;
    } catch (error) {
        dialog.showErrorBox(PRODUCT, `Could not save: ${error instanceof Error ? error.message : error}`);
        return false;
    } finally {
        state.saving = false;
    }
}

/** Asks before unsaved changes are lost; closes the window unless cancelled. */
async function confirmClose(win: BrowserWindow): Promise<void> {
    const state = stateOf(win);
    const session = sessionOf(win);
    if (!state) {
        return;
    }
    const text = session ? await pageText(win) : undefined;
    const changed = !!session && (session.dirty || (text !== undefined && text !== session.diskText));
    if (changed && !args.smokeTest) {
        const name = path.basename(session.path);
        const { response } = await dialog.showMessageBox(win, {
            type: 'warning',
            message: `Do you want to save the changes to ${name}?`,
            detail: 'Your changes will be lost if you don\'t save them.',
            buttons: ['Save', 'Don\'t Save', 'Cancel'],
            defaultId: 0,
            cancelId: 2
        });
        if (response === 2 || (response === 0 && !await save(win, text))) {
            quitting = false;
            return;
        }
    }
    state.closing = true;
    win.close();
    if (quitting) {
        app.quit();
    }
}

// ---------------------------------------------------------------------------------------------------------
// Recent files

function recentFile(): string {
    return path.join(app.getPath('userData'), 'recent.json');
}

function recent(): string[] {
    try {
        const list = JSON.parse(fs.readFileSync(recentFile(), 'utf-8')) as unknown;
        return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

function addRecent(file: string): void {
    if (args.smokeTest || file.startsWith(path.join(os.tmpdir(), 'hsm-modeler-'))) {
        return;
    }
    const list = [file, ...recent().filter(item => item !== file)].slice(0, MAX_RECENT);
    try {
        fs.mkdirSync(path.dirname(recentFile()), { recursive: true });
        fs.writeFileSync(recentFile(), JSON.stringify(list, undefined, 2));
    } catch {
        // not important
    }
    app.addRecentDocument(file);
    buildMenu();
}

// ---------------------------------------------------------------------------------------------------------
// Menu

async function showOpenDialog(folder: boolean): Promise<void> {
    const parent = BrowserWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = folder
        ? { title: 'Open Folder', properties: ['openDirectory', 'createDirectory'] }
        : {
            title: 'Open Model',
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'State machine models', extensions: ['hsm'] }, { name: 'All files', extensions: ['*'] }]
        };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    for (const file of result.canceled ? [] : result.filePaths) {
        openPath(file);
    }
}

function focused(): BrowserWindow | undefined {
    return BrowserWindow.getFocusedWindow() ?? undefined;
}

function buildMenu(): void {
    const isMac = process.platform === 'darwin';
    const recentItems: MenuItemConstructorOptions[] = recent().map(file => ({ label: file, click: () => openPath(file) }));
    const template: MenuItemConstructorOptions[] = [
        ...isMac ? [{ role: 'appMenu' as const }] : [],
        {
            label: '&File',
            submenu: [
                { label: 'New Model', accelerator: 'CmdOrCtrl+N', click: () => newModel() },
                { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => void showOpenDialog(false) },
                { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => void showOpenDialog(true) },
                {
                    label: 'Open Recent',
                    submenu: recentItems.length > 0
                        ? [...recentItems, { type: 'separator' }, { label: 'Clear Recent', click: clearRecent }]
                        : [{ label: 'No recent files', enabled: false }]
                },
                { type: 'separator' },
                // Ctrl+S is handled by the page itself (also when the menu has no focus): not registered twice
                { label: 'Save', accelerator: 'CmdOrCtrl+S', registerAccelerator: false, click: () => { const win = focused(); if (win) { void save(win); } } },
                { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => { const win = focused(); if (win) { void saveAs(win); } } },
                { type: 'separator' },
                { label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: () => focused()?.close() },
                ...isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: 'E&xit' }]
            ]
        },
        {
            label: '&Edit',
            submenu: [
                // undo / redo / find: the page handles the keys itself (text editor or diagram)
                { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => { const win = focused(); if (win) { void pageCommand(win, 'undo'); } } },
                { label: 'Redo', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', registerAccelerator: false, click: () => { const win = focused(); if (win) { void pageCommand(win, 'redo'); } } },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
                { type: 'separator' },
                { label: 'Find', accelerator: 'CmdOrCtrl+F', registerAccelerator: false, click: () => { const win = focused(); if (win) { void pageCommand(win, 'find'); } } }
            ]
        },
        {
            label: '&View',
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        { role: 'windowMenu' },
        {
            role: 'help',
            submenu: [
                { label: 'Documentation', click: () => void shell.openExternal('https://github.com/armaxri/HSM#readme') },
                { label: `${PRODUCT} ${version}`, enabled: false }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function clearRecent(): void {
    try {
        fs.rmSync(recentFile(), { force: true });
    } catch {
        // not important
    }
    app.clearRecentDocuments();
    buildMenu();
}

// ---------------------------------------------------------------------------------------------------------
// Smoke test (CI): open a model in a hidden window, wait for the diagram, edit and save it through the page

async function smokeTest(model: string, resultFile: string | undefined): Promise<void> {
    const report = (result: Record<string, unknown>) => {
        const json = JSON.stringify({ version, ...result });
        console.log(json);
        if (resultFile) {
            fs.writeFileSync(resultFile, json);
        }
    };
    const timeout = setTimeout(() => {
        report({ ok: false, error: 'timeout (90 s)' });
        app.exit(1);
    }, 90_000);
    try {
        const before = fs.readFileSync(model, 'utf-8');
        const win = openFile(model);
        const contents = win.webContents;
        // the page is ready when the diagram shows the states of the model
        let states = 0;
        for (let i = 0; i < 600 && states === 0; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            states = await inPage<number>(contents, 'window.hsmApp && window.hsmApp.diagram ? document.querySelectorAll("#sprotty .hsm-node").length : 0').catch(() => 0);
        }
        const text = await pageText(win);
        if (text !== before) {
            throw new Error('the page does not show the text of the file');
        }
        if (states === 0) {
            throw new Error('the diagram shows no states');
        }
        // the validation in the page (with the imports of the folder) reports no errors
        const session = sessionOf(win)!;
        for (let i = 0; i < 100 && !session.problems; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const errors = (session.problems ?? [{ severity: 'error', message: 'no validation report', line: 0, column: 0 }]).filter(problem => problem.severity === 'error');
        if (errors.length > 0) {
            throw new Error(`problems: ${errors.map(problem => `${problem.line}:${problem.column} ${problem.message}`).join('; ')}`);
        }
        // an edit in the page and Save (button of the page → api/save)
        const marker = `// smoke test ${Date.now()}`;
        await inPage(contents, `window.hsmApp.editor.setValue(window.hsmApp.editor.getValue() + ${JSON.stringify(`\n${marker}\n`)}); document.getElementById('btn-save').click();`);
        let saved = false;
        for (let i = 0; i < 100 && !saved; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            saved = fs.readFileSync(model, 'utf-8').includes(marker);
        }
        if (!saved) {
            throw new Error('Save in the page did not write the file');
        }
        report({ ok: true, states, file: model });
        clearTimeout(timeout);
        app.exit(0);
    } catch (error) {
        report({ ok: false, error: error instanceof Error ? error.message : String(error) });
        app.exit(1);
    }
}

// ---------------------------------------------------------------------------------------------------------
// Startup

function safeRealPath(file: string): string {
    try {
        return fs.realpathSync(file);
    } catch {
        try {
            return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
        } catch {
            return file;
        }
    }
}

async function startServer(): Promise<void> {
    const webRoot = path.join(__dirname, 'web');
    host = new FileHost({
        settingsFile: path.join(app.getPath('userData'), 'page-settings.json'),
        theme: () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
        watch: !args.smokeTest,
        listener: {
            dirtyChanged: session => {
                const win = windowOfSession(session);
                if (win) {
                    updateTitle(win);
                }
            },
            openFile: (session, file) => openFile(file, session.root),
            // a new model: Save (also Ctrl+S in the page) asks for the file
            saveRequested: (session, text) => {
                const win = windowOfSession(session);
                return win && stateOf(win)?.untitled ? saveAs(win, text) : undefined;
            },
            externalChange: (session, replaceText) => void reloadFromDisk(session, replaceText)
        }
    });
    const server = createServer({ files: directoryWebFiles(webRoot), host });
    try {
        baseUrl = await listen(server, args.smokeTest ? 0 : PREFERRED_PORT);
    } catch {
        // in use (e.g. a second user session): any free port
        baseUrl = await listen(server, 0);
    }
}

/** Files changed on disk: the page loads them again (asks first if the model itself changed and has unsaved changes). */
async function reloadFromDisk(session: Session, replaceText: boolean): Promise<void> {
    const win = windowOfSession(session);
    if (!win) {
        return;
    }
    if (replaceText && session.dirty) {
        const { response } = await dialog.showMessageBox(win, {
            type: 'question',
            message: `${path.basename(session.path)} was changed on disk.`,
            detail: 'Load the file from disk and discard your changes?',
            buttons: ['Load from Disk', 'Keep My Changes'],
            defaultId: 1,
            cancelId: 1
        });
        if (response !== 0) {
            return;
        }
    }
    await inPage(win.webContents, `window.hsmApp && window.hsmApp.reloadFromHost(${replaceText})`).catch(() => undefined);
}

if (!args.smokeTest && !app.requestSingleInstanceLock()) {
    // the app runs already: it opens the files (second-instance)
    app.quit();
} else {
    app.on('second-instance', (_event, argv) => {
        const paths = parseArguments(appArguments(argv)).paths;
        for (const file of paths) {
            openPath(file);
        }
        if (paths.length === 0) {
            const win = BrowserWindow.getAllWindows()[0] ?? newModel();
            if (win.isMinimized()) {
                win.restore();
            }
            win.focus();
        }
    });
    // macOS: files opened in the Finder / dropped on the Dock icon (also before `ready`)
    app.on('open-file', (event, file) => {
        event.preventDefault();
        if (app.isReady() && baseUrl) {
            openPath(file);
        } else {
            pendingPaths.push(file);
        }
    });
    app.on('before-quit', () => {
        quitting = true;
    });
    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0 && baseUrl) {
            newModel();
        }
    });
    app.on('will-quit', () => host?.close());

    app.whenReady().then(async () => {
        await startServer();
        if (args.smokeTest) {
            await smokeTest(path.resolve(args.smokeTest), args.smokeResult);
            return;
        }
        buildMenu();
        const paths = [...args.paths, ...pendingPaths];
        pendingPaths.length = 0;
        for (const file of paths) {
            openPath(file);
        }
        if (windows.size === 0) {
            newModel();
        }
    }).catch(error => {
        dialog.showErrorBox(PRODUCT, `${PRODUCT} could not start: ${error instanceof Error ? error.stack : error}`);
        app.exit(1);
    });
}
