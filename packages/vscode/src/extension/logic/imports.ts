import { URI, UriUtils } from 'langium';
import {
    createHsmServices, headerCandidates, importKind, importPaths, isStateMachine, parseCppHeader, resolveImportUri, type CppHeaderSettings
} from 'hsm-language';

/** Reads the text of a file (an open document or the file system); `undefined` if it cannot be read. */
export type TextReader = (uri: string) => Promise<string | undefined>;

let parserServices: ReturnType<typeof createHsmServices> | undefined;

/** The import paths of `.hsm` files in a model text (only the parser is used, works on incomplete texts). */
export function hsmImportPaths(text: string): string[] {
    return importPathsOf(text, 'hsm');
}

/** The import paths of C/C++ headers in a model text. */
export function headerImportPaths(text: string): string[] {
    return importPathsOf(text, 'header');
}

function importPathsOf(text: string, kind: 'hsm' | 'header'): string[] {
    parserServices ??= createHsmServices();
    const model = parserServices.Hsm.parser.LangiumParser.parse(text).value;
    return isStateMachine(model) ? importPaths(model).map(p => p.path).filter(path => path && importKind(path) === kind) : [];
}

/**
 * The texts of the `.hsm` files imported (transitively) by a model and of the imported C/C++ headers
 * (with the headers they include, searched like the language does: relative to the including file,
 * then in the include paths of `headers`), by URI. The webview has no file system: the extension
 * sends these texts along with the text of the document, so that the diagram and the simulation of
 * the webview can resolve the imports (see `HsmModelService.setWorkspace`). Files that cannot be
 * read are left out (the webview reports "file not found").
 */
export async function collectImportedFiles(uri: string, text: string, read: TextReader, limit = 100, headers: CppHeaderSettings = {}): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const visited = new Set<string>([URI.parse(uri).toString()]);
    const queue: Array<{ uri: string, text: string }> = [{ uri, text }];
    const readHeader = async (candidates: URI[]): Promise<void> => {
        for (const candidate of candidates) {
            const key = candidate.toString();
            if (visited.has(key)) {
                return;
            }
            const headerText = await read(key);
            if (headerText === undefined) {
                continue;
            }
            visited.add(key);
            files[key] = headerText;
            for (const include of parseCppHeader(headerText, key, { defines: headers.defines }).includes) {
                if (visited.size <= limit) {
                    await readHeader(headerCandidates(include.path, UriUtils.dirname(candidate), headers, include.system));
                }
            }
            return;
        }
    };
    while (queue.length > 0 && visited.size <= limit) {
        const current = queue.shift()!;
        for (const path of headerImportPaths(current.text)) {
            await readHeader(headerCandidates(path, UriUtils.dirname(URI.parse(current.uri)), headers));
        }
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
