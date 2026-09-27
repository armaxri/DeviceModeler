/*
 * Manual layout (experimental): the sidecar file `<model>.hsm.layout` next to a model. The webview
 * computes and serializes the layout; the extension reads the file when the diagram is opened, writes
 * it (debounced) when the layout changes in the diagram and reports external changes to the webview.
 * The logic here is independent of the VS Code API (paths are the `path` components of URIs), so it
 * can be unit tested.
 */

/** File name extension of layout sidecar files (`model.hsm` -> `model.hsm.layout`, see `layoutFileName`). */
export const LAYOUT_SUFFIX = '.layout';

/** The path of the layout file of a model. */
export function layoutPathOf(modelPath: string): string {
    return modelPath + LAYOUT_SUFFIX;
}

/** File operations used for layout files (implemented with `vscode.workspace.fs` in the extension). */
export interface LayoutFileSystem {
    /** The content of the file, undefined if it does not exist. */
    read(path: string): Promise<string | undefined>;
    write(path: string, content: string): Promise<void>;
    /** Deletes the file (no error if it does not exist). */
    delete(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    rename(from: string, to: string): Promise<void>;
}

/** A layout sent by the webview: the serialized layout and its mode; undefined: no manual layout. */
export interface LayoutUpdate {
    content: string;
    mode: 'auto' | 'manual';
}

export type LayoutWriteAction = 'write' | 'delete' | 'none';

/**
 * What to do with the layout file for a layout sent by the webview: a manual layout is written; a
 * layout in the automatic mode is only written if the file exists already (the user switched back to
 * Auto: the manual layout is kept for later, but opening a diagram must not create files); no layout
 * (Reset) deletes an existing file.
 */
export function layoutWriteAction(update: LayoutUpdate | undefined, fileExists: boolean, currentContent?: string): LayoutWriteAction {
    if (!update) {
        return fileExists ? 'delete' : 'none';
    }
    if (fileExists && currentContent === update.content) {
        return 'none';
    }
    return update.mode === 'manual' || fileExists ? 'write' : 'none';
}

export interface LayoutFileSyncOptions {
    /** Delay (ms) for writing changes (dragging produces a change per drop; undo sequences several). */
    debounceMs?: number;
    /** Called when writing fails. */
    onError?(error: unknown): void;
}

/**
 * Keeps the layout file of one model in sync with the diagram: {@link load} reads it, {@link update}
 * schedules writes, {@link isExternalChange} tells changes of the file by other tools (or git) apart
 * from our own writes.
 */
export class LayoutFileSync {

    private timer?: ReturnType<typeof setTimeout>;
    private pending?: { update: LayoutUpdate | undefined };
    /** The content of the file as last read or written by us (undefined: no file). */
    private known?: string;
    private writing: Promise<void> = Promise.resolve();

    constructor(private readonly fs: LayoutFileSystem, private modelPath: string, private readonly options: LayoutFileSyncOptions = {}) { }

    get layoutPath(): string {
        return layoutPathOf(this.modelPath);
    }

    /** Reads the layout file (undefined: there is none). */
    async load(): Promise<string | undefined> {
        await this.flush();
        this.known = await this.fs.read(this.layoutPath);
        return this.known;
    }

    /** The layout was changed in the diagram: writes (or deletes) the file after the debounce delay. */
    update(update: LayoutUpdate | undefined): void {
        this.pending = { update };
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.flush().catch(error => this.options.onError?.(error));
        }, this.options.debounceMs ?? 300);
    }

    /** Writes a pending change now. */
    async flush(): Promise<void> {
        clearTimeout(this.timer);
        const pending = this.pending;
        this.pending = undefined;
        if (pending) {
            this.writing = this.writing.catch(() => undefined).then(() => this.write(pending.update));
        }
        await this.writing;
    }

    private async write(update: LayoutUpdate | undefined): Promise<void> {
        const path = this.layoutPath;
        const exists = await this.fs.exists(path);
        const current = exists ? await this.fs.read(path) : undefined;
        const action = layoutWriteAction(update, exists, current);
        if (action === 'write' && update) {
            this.known = update.content;
            await this.fs.write(path, update.content);
        } else if (action === 'delete') {
            this.known = undefined;
            await this.fs.delete(path);
        } else {
            this.known = current;
        }
    }

    /**
     * The layout file was created, changed or deleted (file system watcher): returns the new content to
     * send to the webview (`{ content: undefined }`: the file was deleted), or undefined if the change
     * was made by us (or nothing changed).
     */
    async externalChange(): Promise<{ content: string | undefined } | undefined> {
        await this.writing.catch(() => undefined);
        if (this.pending) {
            // our own change is still to be written; it wins
            return undefined;
        }
        const content = await this.fs.read(this.layoutPath);
        if (content === this.known) {
            return undefined;
        }
        this.known = content;
        return { content };
    }

    /** The model was renamed or moved (the layout file is moved by {@link moveLayoutFile}). */
    async modelRenamed(newModelPath: string): Promise<void> {
        await this.flush();
        this.modelPath = newModelPath;
    }

    dispose(): void {
        // a pending change is still written
        if (this.pending) {
            this.flush().catch(error => this.options.onError?.(error));
        }
    }
}

/**
 * A model was renamed / moved: moves its layout file along, unless the layout file was renamed in the
 * same operation or the target exists already. Returns true if the file was moved.
 */
export async function moveLayoutFile(fs: LayoutFileSystem, oldModelPath: string, newModelPath: string, renamedPaths: ReadonlySet<string> = new Set()): Promise<boolean> {
    const from = layoutPathOf(oldModelPath);
    const to = layoutPathOf(newModelPath);
    if (from === to || renamedPaths.has(from) || !await fs.exists(from) || await fs.exists(to)) {
        return false;
    }
    await fs.rename(from, to);
    return true;
}
