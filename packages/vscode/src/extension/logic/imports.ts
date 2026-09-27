import { URI } from 'langium';
import { createHsmServices, importKind, importPaths, isStateMachine, resolveImportUri } from 'hsm-language';

/** Reads the text of a file (an open document or the file system); `undefined` if it cannot be read. */
export type TextReader = (uri: string) => Promise<string | undefined>;

let parserServices: ReturnType<typeof createHsmServices> | undefined;

/** The import paths of `.hsm` files in a model text (only the parser is used, works on incomplete texts). */
export function hsmImportPaths(text: string): string[] {
    parserServices ??= createHsmServices();
    const model = parserServices.Hsm.parser.LangiumParser.parse(text).value;
    return isStateMachine(model) ? importPaths(model).map(p => p.path).filter(path => path && importKind(path) === 'hsm') : [];
}

/**
 * The texts of the `.hsm` files imported (transitively) by a model, by URI. The webview has no file
 * system: the extension sends these texts along with the text of the document, so that the diagram
 * and the simulation of the webview can resolve the imports (see `HsmModelService.setWorkspace`).
 * Files that cannot be read are left out (the webview reports "file not found").
 */
export async function collectImportedFiles(uri: string, text: string, read: TextReader, limit = 100): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const visited = new Set<string>([URI.parse(uri).toString()]);
    const queue: Array<{ uri: string, text: string }> = [{ uri, text }];
    while (queue.length > 0 && visited.size <= limit) {
        const current = queue.shift()!;
        for (const path of hsmImportPaths(current.text)) {
            const imported = resolveImportUri(URI.parse(current.uri), path).toString();
            if (visited.has(imported)) {
                continue;
            }
            visited.add(imported);
            const importedText = await read(imported);
            if (importedText !== undefined) {
                files[imported] = importedText;
                queue.push({ uri: imported, text: importedText });
            }
        }
    }
    return files;
}
