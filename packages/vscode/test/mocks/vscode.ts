/*
 * A minimal stand-in for the `vscode` module (only what the diagram panel uses), for unit tests of the
 * extension host code outside VS Code. `workspace.fs` works on the real file system (file URIs).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export class Uri {
    private constructor(readonly scheme: string, readonly authority: string, readonly path: string) { }

    static file(fsPath: string): Uri {
        return new Uri('file', '', fsPath.split(path.sep).join('/'));
    }

    static parse(value: string): Uri {
        const url = new URL(value);
        return new Uri(url.protocol.replace(/:$/, ''), url.host, decodeURIComponent(url.pathname));
    }

    static joinPath(base: Uri, ...segments: string[]): Uri {
        return base.with({ path: path.posix.join(base.path, ...segments) });
    }

    get fsPath(): string {
        return this.path;
    }

    with(change: { path?: string, scheme?: string }): Uri {
        return new Uri(change.scheme ?? this.scheme, this.authority, change.path ?? this.path);
    }

    toString(): string {
        return `${this.scheme}://${this.authority}${this.path}`;
    }
}

export class Range {
    constructor(readonly start: unknown, readonly end: unknown) { }
}

export class RelativePattern {
    constructor(readonly base: Uri, readonly pattern: string) { }
}

export enum TextDocumentChangeReason {
    Undo = 1,
    Redo = 2
}

export enum ViewColumn {
    One = 1,
    Two = 2,
    Beside = -2
}

export enum ColorThemeKind {
    Light = 1,
    Dark = 2,
    HighContrast = 3
}

type Listener = () => void;

/** File system watchers created by the panel (tests trigger their events). */
export const watchers: Array<{ pattern: RelativePattern, fire(): void, disposed: boolean }> = [];

export const workspace = {
    textDocuments: [] as unknown[],
    getWorkspaceFolder(_uri: Uri): undefined {
        return undefined;
    },
    fs: {
        async readFile(uri: Uri): Promise<Uint8Array> {
            return fs.readFile(uri.fsPath);
        },
        async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
            await fs.writeFile(uri.fsPath, content);
        },
        async stat(uri: Uri): Promise<unknown> {
            return fs.stat(uri.fsPath);
        },
        async delete(uri: Uri): Promise<void> {
            await fs.rm(uri.fsPath);
        },
        async rename(from: Uri, to: Uri): Promise<void> {
            await fs.rename(from.fsPath, to.fsPath);
        }
    },
    createFileSystemWatcher(pattern: RelativePattern) {
        const listeners: Listener[] = [];
        const watcher = {
            pattern,
            disposed: false,
            fire: () => listeners.forEach(l => l()),
            onDidCreate: (l: Listener) => listeners.push(l),
            onDidChange: (l: Listener) => listeners.push(l),
            onDidDelete: (l: Listener) => listeners.push(l),
            dispose: () => {
                watcher.disposed = true;
            }
        };
        watchers.push(watcher);
        return watcher;
    },
    getConfiguration: () => ({ get: <T>(_key: string, fallback?: T) => fallback, update: async () => undefined }),
    openTextDocument: async () => {
        throw new Error('not available in the mock');
    },
    applyEdit: async () => true
};

export const window = {
    visibleTextEditors: [],
    activeColorTheme: { kind: ColorThemeKind.Light },
    showErrorMessage: (message: string) => {
        errors.push(message);
        return Promise.resolve(undefined);
    },
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: (message: string) => {
        infos.push(message);
        return Promise.resolve(undefined);
    },
    showTextDocument: async () => undefined,
    setStatusBarMessage: () => undefined
};

/** Error messages shown by the code under test. */
export const errors: string[] = [];
/** Information messages shown by the code under test. */
export const infos: string[] = [];

export const commands = {
    executeCommand: async () => undefined
};
