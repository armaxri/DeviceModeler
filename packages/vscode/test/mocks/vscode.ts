/*
 * A minimal stand-in for the `vscode` module (only what the diagram panel and the commands under test
 * use), for unit tests of the extension host code outside VS Code. `workspace.fs` works on the real file
 * system (file URIs); documents are read from it, positions are plain offsets and `applyEdit` writes the
 * edited text back to the file.
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

/** Collects replacements (ranges of offsets, see `openTextDocument`). */
export class WorkspaceEdit {
    readonly replacements: Array<{ uri: Uri, range: Range, text: string }> = [];

    replace(uri: Uri, range: Range, text: string): void {
        this.replacements.push({ uri, range, text });
    }
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
        }
    },
    getConfiguration: () => ({ get: <T>(_key: string, fallback?: T) => fallback, update: async () => undefined }),
    async openTextDocument(uri: Uri) {
        const text = await fs.readFile(uri.fsPath, 'utf-8');
        return { uri, version: 1, isDirty: false, getText: () => text, positionAt: (offset: number) => offset };
    },
    /** Applies the replacements of each file to its content on disk (from the end, ranges are offsets). */
    async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
        const byFile = new Map<string, Array<{ start: number, end: number, text: string }>>();
        for (const { uri, range, text } of edit.replacements) {
            byFile.set(uri.fsPath, [...byFile.get(uri.fsPath) ?? [], { start: range.start as number, end: range.end as number, text }]);
        }
        for (const [file, replacements] of byFile) {
            let content = await fs.readFile(file, 'utf-8');
            for (const r of replacements.sort((a, b) => b.start - a.start)) {
                content = content.slice(0, r.start) + r.text + content.slice(r.end);
            }
            await fs.writeFile(file, content);
        }
        return true;
    }
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
