// The Device Modeler desktop app (Electron main process): one native window per opened model, showing the web
// app of packages/web in its embedded mode (`?host=http`, packages/web/src/host.ts), served by a loopback
// HTTP server of this process (server.ts) that reads and writes the files on disk (file-host.ts) - the same
// protocol as the Eclipse plugin. The app adds what a browser cannot do: native menus, file dialogs, recent
// files, file associations, dirty state and a confirmation before unsaved changes are lost.
//
// Command line: `Device Modeler [file.devm | folder]...`; `--smoke-test <model.devm> --smoke-result <file.json>`
// opens the model in a hidden window, edits and saves it through the page and exits (used by CI);
// `--smoke-structure <structure.devm>` also checks the structure diagram of a structure file and its navigation.
import { app, BrowserWindow, dialog, Menu, nativeTheme, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileHost, isInside, locationQuery, positionQuery, writeFileAtomic, type OpenPosition, type Session } from './file-host.js';
import { createServer, listen } from './server.js';
import { directoryWebFiles } from './web-files.js';

declare const __DEVM_VERSION__: string;
const version = typeof __DEVM_VERSION__ === 'string' ? __DEVM_VERSION__ : app.getVersion();

const PRODUCT = 'Device Modeler';
/**
 * Preferred port: the same origin in every run keeps the settings of the page (local storage); not the one
 * of the HSM Modeler (51735), the app this one was forked from, so that both can run at the same time.
 */
const PREFERRED_PORT = 51736;
const MAX_RECENT = 10;
const NEW_MODEL = `statemachine NewMachine {
    interface:
        in event start

    [*] -> Idle

    state Idle
}
`;
const NEW_STRUCTURE = `/** A component type: its ports carry data and events (docs/structure-language.md). */
component NewComponent {
    in async start
    out sync value : integer
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
    /** A header viewer window (read-only, go to definition): the file it shows. */
    viewer?: string;
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
    /** Smoke test: a structure file to check as well (structure diagram, navigation). */
    smokeStructure?: string;
}

function parseArguments(argv: string[]): Arguments {
    const result: Arguments = { paths: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--smoke-test') {
            result.smokeTest = argv[++i];
        } else if (arg === '--smoke-result') {
            result.smokeResult = argv[++i];
        } else if (arg === '--smoke-structure') {
            result.smokeStructure = argv[++i];
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
        if (state.viewer) {
            // a header viewer shows a file of the session of a model window, it does not own the session
            win.setTitle(`${path.basename(state.viewer)} (read-only) — ${path.dirname(state.viewer)}`);
            return;
        }
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

/**
 * Opens a model in a window (or focuses the window that shows it); `root`: the boundary of its imports;
 * `position`: the range to select (go to definition from another model); `location`: what the diagram shows
 * (JSON of a navigation of the structure diagram, e.g. a subsystem part with its breadcrumb).
 */
function openFile(file: string, root?: string, position?: OpenPosition, location?: string): BrowserWindow {
    const resolved = path.resolve(file);
    for (const [win, state] of windows) {
        const session = state.token ? host.session(state.token) : undefined;
        if (session && !state.untitled && host.fileOf(session) === safeRealPath(resolved)) {
            win.show();
            win.focus();
            if (position) {
                void inPage(win.webContents, `window.devmApp.revealPosition(${position.line}, ${position.column}, ${position.endLine}, ${position.endColumn})`).catch(() => undefined);
            }
            if (location) {
                void inPage(win.webContents, `window.devmApp && typeof window.devmApp.revealLocation === "function" && window.devmApp.revealLocation(${JSON.stringify(location)})`).catch(() => undefined);
            }
            return win;
        }
    }
    // the root: an opened folder containing the file, else the folder of the file
    root ??= [...windows.values()].map(state => state.folder).find(folder => folder && isInside(folder, safeRealPath(resolved)));
    const { session, page } = host.openFile(resolved, root);
    const win = createWindow({ token: session.token });
    // (the page reveals a position and a location of its URL once it has started)
    void win.loadURL(baseUrl + page + positionQuery(position) + locationQuery(location));
    addRecent(host.fileOf(session));
    return win;
}

/**
 * Shows a header read-only in a viewer window (the web app with `view=<path>`: Monaco with the C++ grammar),
 * at the range of a go to definition; a header that is already shown gets the new position.
 */
function openViewer(session: Session, file: string, position?: OpenPosition): BrowserWindow {
    const real = safeRealPath(file);
    const url = `${baseUrl}s/${session.token}/index.html?host=http&view=${encodeURIComponent(path.relative(session.root, real).split(path.sep).join('/'))}${positionQuery(position)}`;
    let win = [...windows].find(([, state]) => state.viewer === real)?.[0];
    if (!win) {
        win = createWindow({ viewer: real });
        win.setSize(1000, 800);
    }
    void win.loadURL(url);
    win.show();
    win.focus();
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

/** A new model (a state machine or a structure file), saved to a file chosen on the first save. */
function newModel(kind: 'statemachine' | 'structure' = 'statemachine'): BrowserWindow {
    const folder = path.join(os.tmpdir(), `device-modeler-${process.pid}`);
    fs.mkdirSync(folder, { recursive: true });
    const name = `Untitled-${++untitledCount}.devm`;
    fs.writeFileSync(path.join(folder, name), kind === 'structure' ? NEW_STRUCTURE : NEW_MODEL);
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
        if (file.endsWith('.devm') && fs.existsSync(path.dirname(file))) {
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

/** Runs a script in the page (`window.devmApp` is the web app). */
async function inPage<T>(contents: WebContents, script: string): Promise<T> {
    return await contents.executeJavaScript(script, true) as T;
}

/** The current text of the page (undefined if the page is not ready). */
async function pageText(win: BrowserWindow): Promise<string | undefined> {
    try {
        return await inPage<string | null>(win.webContents,
            'window.devmApp && window.devmApp.diagram ? (typeof window.devmApp.getText === "function" ? window.devmApp.getText() : window.devmApp.editor.getValue()) : null') ?? undefined;
    } catch {
        return undefined;
    }
}

/** An edit command of the menu: by the web app if it offers it (`hostCommand`), else by Chromium. */
async function pageCommand(win: BrowserWindow, command: 'undo' | 'redo' | 'find'): Promise<void> {
    const handled = await inPage<boolean>(win.webContents,
        `!!(window.devmApp && typeof window.devmApp.hostCommand === "function" && window.devmApp.hostCommand(${JSON.stringify(command)}))`).catch(() => false);
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
            filters: [{ name: 'Device Modeler models', extensions: ['devm'] }, { name: 'All files', extensions: ['*'] }]
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
    if (args.smokeTest || file.startsWith(path.join(os.tmpdir(), 'device-modeler-'))) {
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
            filters: [{ name: 'Device Modeler models', extensions: ['devm'] }, { name: 'All files', extensions: ['*'] }]
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
                { label: 'New State Machine', accelerator: 'CmdOrCtrl+N', click: () => newModel() },
                { label: 'New Structure File', accelerator: 'CmdOrCtrl+Alt+N', click: () => newModel('structure') },
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
                { label: 'Documentation', click: () => void shell.openExternal('https://github.com/armaxri/DeviceModeler#readme') },
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
            states = await inPage<number>(contents, 'window.devmApp && window.devmApp.diagram ? document.querySelectorAll("#sprotty .devm-node").length : 0').catch(() => 0);
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
        await inPage(contents, `window.devmApp.editor.setValue(window.devmApp.editor.getValue() + ${JSON.stringify(`\n${marker}\n`)}); document.getElementById('btn-save').click();`);
        let saved = false;
        for (let i = 0; i < 100 && !saved; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            saved = fs.readFileSync(model, 'utf-8').includes(marker);
        }
        if (!saved) {
            throw new Error('Save in the page did not write the file');
        }
        const navigation = await smokeTestNavigation(win, model);
        if (args.smokeStructure) {
            navigation.push(...await smokeTestStructure(path.resolve(args.smokeStructure)));
        }
        report({ ok: true, states, file: model, navigation });
        clearTimeout(timeout);
        app.exit(0);
    } catch (error) {
        report({ ok: false, error: error instanceof Error ? error.message : String(error) });
        app.exit(1);
    }
}

/**
 * Go to definition in the page (smoke test): F12 on the import path of `motor.devm` opens the model in a window
 * of its own; a header next to the model (`smoke_types.h`, written by scripts/smoke-test.mjs) opens in a
 * read-only viewer window with the name of the declaration selected (`api/open` with a position).
 */
async function smokeTestNavigation(win: BrowserWindow, model: string): Promise<string[]> {
    const done: string[] = [];
    const motor = safeRealPath(path.join(path.dirname(model), 'motor.devm'));
    await inPage(win.webContents, `(() => { const e = window.devmApp.editor; const m = e.getModel(); e.setPosition(m.getPositionAt(m.getValue().indexOf('motor.devm')));
        e.focus(); e.trigger('smoke', 'editor.action.revealDefinition', null); })()`);
    await until('navigation: motor.devm was not opened', () => [...windows.values()].some(state => {
        const session = state.token ? host.session(state.token) : undefined;
        return !!session && host.fileOf(session) === motor;
    }));
    done.push('model');
    const header = path.join(path.dirname(model), 'smoke_types.h');
    if (fs.existsSync(header)) {
        await inPage(win.webContents, `fetch('api/open?line=2&column=12&endLine=2&endColumn=16', { method: 'POST', body: 'smoke_types.h' }).then(r => r.status)`);
        const viewer = () => [...windows].find(([, state]) => state.viewer === safeRealPath(header))?.[0];
        await until('navigation: no viewer window for the header', () => !!viewer());
        const contents = viewer()!.webContents;
        await until('navigation: the viewer does not show the declaration', async () => await inPage<string>(contents,
            "(() => { const t = document.querySelector('.file-viewer-title'); return t ? t.textContent : ''; })()").catch(() => '') === 'smoke_types.h');
        done.push('header');
    }
    return done;
}

/** Waits until a condition holds (smoke test); throws with the description after 15 s. */
async function until(what: string, condition: () => Promise<boolean> | boolean): Promise<void> {
    for (let i = 0; i < 150; i++) {
        if (await condition()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(what);
}

/** Double-clicks the shape of the first instance of the structure diagram matching a selector (smoke test). */
async function doubleClickInstance(contents: WebContents, selector: string): Promise<boolean> {
    return await inPage<boolean>(contents, `(() => {
        const shape = document.querySelector(${JSON.stringify(`#sprotty ${selector} .ibd-instance-shape`)});
        if (!shape) { return false; }
        shape.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
        return true; })()`).catch(() => false);
}

/** The text of the file of a window (smoke test). */
function fileText(win: BrowserWindow): string {
    const session = sessionOf(win);
    return session ? fs.readFileSync(host.fileOf(session), 'utf-8') : '';
}

/**
 * The structure file in the smoke test (examples/device/garage-door.devm): the page shows the structure diagram
 * and validates the file (with the other structure files of the folder) without errors; go to definition on the
 * type of an instance opens the file of the component type with the name selected; a double-click on a
 * subsystem part opens the file of the subsystem showing the breadcrumb of the part ("Part of"), and a
 * double-click on an instance with a behavior there opens its state machine.
 */
async function smokeTestStructure(file: string): Promise<string[]> {
    const done: string[] = [];
    const win = openFile(file);
    const contents = win.webContents;
    let nodes = 0;
    await until('structure: the structure diagram is not shown', async () => {
        nodes = await inPage<number>(contents, `window.devmApp && window.devmApp.diagram && document.getElementById('diagram-area').classList.contains('structure-diagram')
            ? document.querySelectorAll('#sprotty .ibd-node').length : 0`).catch(() => 0);
        return nodes > 0;
    });
    const session = sessionOf(win)!;
    await until('structure: no validation report', () => !!session.problems);
    const errors = session.problems!.filter(problem => problem.severity === 'error');
    if (errors.length > 0) {
        throw new Error(`structure: problems: ${errors.map(problem => `${problem.line}:${problem.column} ${problem.message}`).join('; ')}`);
    }
    done.push(`structure diagram (${nodes} nodes)`);

    // go to definition on the type of an instance (`door : DoorController`)
    const text = fileText(win);
    const instance = /^[ \t]+\w+[ \t]*:[ \t]*(\w+)[ \t]*$/m.exec(text);
    if (!instance) {
        throw new Error('structure: no instance in the file');
    }
    const type = instance[1];
    const offset = instance.index + instance[0].lastIndexOf(type);
    await inPage(contents, `(() => { const e = window.devmApp.editor; e.setPosition(e.getModel().getPositionAt(${offset}));
        e.focus(); e.trigger('smoke', 'editor.action.revealDefinition', null); })()`);
    let typeWindow: BrowserWindow | undefined;
    await until(`structure: the definition of ${type} was not opened`, () => {
        typeWindow = [...windows.keys()].find(other => other !== win && fileText(other).includes(`component ${type}`));
        return !!typeWindow;
    });
    await until(`structure: ${type} is not selected in its file`, async () => await inPage<string>(typeWindow!.webContents,
        '(() => { const e = window.devmApp && window.devmApp.editor; return e && e.getSelection() ? e.getModel().getValueInRange(e.getSelection()) : ""; })()').catch(() => '') === type);
    done.push('structure definition');

    // double-click on a subsystem part: its file with the breadcrumb of the part
    const before = new Set(windows.keys());
    await until('structure: no subsystem part in the diagram', () => doubleClickInstance(contents, '.ibd-node.composite'));
    let part: BrowserWindow | undefined;
    await until('structure: the subsystem of the part was not opened', () => {
        part = [...windows.keys()].find(other => !before.has(other) && sessionOf(other));
        return !!part;
    });
    await until('structure: the subsystem does not show the breadcrumb of the part', async () => (await inPage<string>(part!.webContents,
        "(() => { const b = document.getElementById('diagram-breadcrumb'); return b && !b.hidden ? b.textContent : ''; })()").catch(() => '')).startsWith('Part of'));
    if (await pageText(win) !== text) {
        // (Save would write the other file into this one)
        throw new Error('structure: the window of the structure file shows another file');
    }
    done.push('subsystem part');

    // double-click on an instance with a behavior: its state machine
    const partContents = part!.webContents;
    const opened = new Set(windows.keys());
    await until('structure: no instance with a behavior in the subsystem', () => doubleClickInstance(partContents, '.ibd-node.has-behavior'));
    await until('structure: the state machine of the instance was not opened', () => [...windows.keys()].some(other =>
        !opened.has(other) && /^\s*(\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*statemachine\b/.test(fileText(other))));
    done.push('state machine of an instance');
    return done;
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
            // models (state machines and structure files) in their own window; headers (go to definition) in a read-only viewer window
            openFile: (session, file, position, location) => /\.devm$/i.test(file) ? openFile(file, session.root, position, location) : openViewer(session, file, position),
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
    await inPage(win.webContents, `window.devmApp && window.devmApp.reloadFromHost(${replaceText})`).catch(() => undefined);
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
