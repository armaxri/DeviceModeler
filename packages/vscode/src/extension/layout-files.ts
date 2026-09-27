import * as vscode from 'vscode';
import { moveLayoutFile, type LayoutFileSystem } from './logic/layout-file.js';

/*
 * Manual layout (experimental): `vscode.workspace.fs` access to the sidecar files `<model>.hsm.layout`.
 */

/** File operations on the files of the same file system (scheme / authority) as `base`. */
export function workspaceLayoutFs(base: vscode.Uri): LayoutFileSystem {
    const uri = (path: string) => base.with({ path });
    const exists = async (path: string) => {
        try {
            await vscode.workspace.fs.stat(uri(path));
            return true;
        } catch {
            return false;
        }
    };
    return {
        read: async path => {
            try {
                return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri(path)));
            } catch {
                return undefined;
            }
        },
        write: async (path, content) => {
            await vscode.workspace.fs.writeFile(uri(path), new TextEncoder().encode(content));
        },
        delete: async path => {
            if (await exists(path)) {
                await vscode.workspace.fs.delete(uri(path), { useTrash: false });
            }
        },
        exists,
        rename: async (from, to) => {
            await vscode.workspace.fs.rename(uri(from), uri(to), { overwrite: false });
        }
    };
}

/** Whether a document can have a layout file (untitled documents keep the layout in the webview only). */
export function hasLayoutFile(uri: vscode.Uri): boolean {
    return uri.scheme !== 'untitled';
}

/** Moves the layout files of renamed / moved models along (`workspace.onDidRenameFiles`). */
export async function moveLayoutFiles(files: ReadonlyArray<{ oldUri: vscode.Uri, newUri: vscode.Uri }>): Promise<void> {
    const renamed = new Set(files.map(f => f.oldUri.path));
    for (const { oldUri, newUri } of files) {
        if (!/\.hsm$/i.test(oldUri.path) || !/\.hsm$/i.test(newUri.path) || !hasLayoutFile(oldUri)
            || oldUri.scheme !== newUri.scheme || oldUri.authority !== newUri.authority) {
            continue;
        }
        await moveLayoutFile(workspaceLayoutFs(oldUri), oldUri.path, newUri.path, renamed);
    }
}
