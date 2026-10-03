import * as vscode from 'vscode';

/** The files sent to the diagrams: the state machines and structure files of the workspace. */
const PATTERN = '**/*.devm';
const EXCLUDE = '**/{node_modules,.git}/**';
/** The most files read (larger workspaces: the first ones found, plus the open documents). */
const MAX_FILES = 1000;

/** Whether a URI is a model file (`.devm`: state machine or structure file, the files of {@link WorkspaceFiles}). */
export function isModelFile(uri: vscode.Uri): boolean {
    return /\.devm$/i.test(uri.path);
}

/**
 * The texts of all `.devm` files of the workspace (open documents with their unsaved changes,
 * the others read from disk and cached until they change). The diagrams need them for queries across
 * files: the structures using a state machine, routes and providers in other files, renames updating the
 * files referencing an element. {@link onDidChange} fires when a file is created, deleted or changed (on
 * disk or in an editor).
 */
export class WorkspaceFiles implements vscode.Disposable {

    private uris?: Promise<Set<string>>;
    private readonly cache = new Map<string, string>();
    private readonly changed = new vscode.EventEmitter<string>();
    private readonly disposables: vscode.Disposable[] = [this.changed];
    /** Fires with the URI of a changed, created or deleted file. */
    readonly onDidChange = this.changed.event;

    constructor() {
        const watcher = vscode.workspace.createFileSystemWatcher(PATTERN);
        this.disposables.push(
            watcher,
            watcher.onDidCreate(uri => this.update(uri, true)),
            watcher.onDidDelete(uri => this.update(uri, false)),
            watcher.onDidChange(uri => this.update(uri, true)),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (isModelFile(event.document.uri) && event.contentChanges.length > 0) {
                    this.changed.fire(event.document.uri.toString());
                }
            }),
            // closing a document with unsaved changes: back to the text on disk
            vscode.workspace.onDidCloseTextDocument(document => {
                if (isModelFile(document.uri)) {
                    this.cache.delete(document.uri.toString());
                    this.changed.fire(document.uri.toString());
                }
            })
        );
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }

    /** The texts by URI (`uri.toString()`). */
    async texts(): Promise<Record<string, string>> {
        const uris = new Set(await this.list());
        for (const document of vscode.workspace.textDocuments) {
            if (isModelFile(document.uri) && !document.isClosed) {
                uris.add(document.uri.toString());
            }
        }
        const result: Record<string, string> = {};
        await Promise.all([...uris].map(async uri => {
            const text = await this.read(uri);
            if (text !== undefined) {
                result[uri] = text;
            }
        }));
        return result;
    }

    private list(): Promise<Set<string>> {
        this.uris ??= Promise.resolve(vscode.workspace.findFiles(PATTERN, EXCLUDE, MAX_FILES))
            .then(found => new Set(found.map(uri => uri.toString())), () => new Set<string>());
        return this.uris;
    }

    private async read(uri: string): Promise<string | undefined> {
        const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri);
        if (open) {
            return open.getText();
        }
        const cached = this.cache.get(uri);
        if (cached !== undefined) {
            return cached;
        }
        try {
            const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri)));
            this.cache.set(uri, text);
            return text;
        } catch {
            return undefined;
        }
    }

    private async update(uri: vscode.Uri, exists: boolean): Promise<void> {
        const key = uri.toString();
        this.cache.delete(key);
        const uris = await this.list();
        if (exists) {
            uris.add(key);
        } else {
            uris.delete(key);
        }
        this.changed.fire(key);
    }
}
