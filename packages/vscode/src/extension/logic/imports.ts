import { URI, UriUtils } from 'langium';
import {
    createHsmServices, dmfImportKind, dmfImportPaths, headerCandidates, importKind, importPaths, isComponent, isDmfModel, isStateMachine, parseCppHeader,
    resolveImportUri, type CppHeaderSettings
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
 * The files a structure file (`.dmf`) refers to: imported structure files and state machines (`import`,
 * `behavior "door.hsm"`) and imported C/C++ headers (only the parser is used).
 */
export function dmfReferencedPaths(text: string): { models: string[], headers: string[] } {
    parserServices ??= createHsmServices();
    const model = parserServices.Dmf.parser.LangiumParser.parse(text).value;
    if (!isDmfModel(model)) {
        return { models: [], headers: [] };
    }
    const paths = dmfImportPaths(model).map(p => p.path).filter(path => path);
    const behaviors = model.elements.filter(isComponent).map(c => c.behavior?.path).filter((path): path is string => !!path);
    return {
        models: [...paths.filter(path => dmfImportKind(path) === 'dmf' || dmfImportKind(path) === 'hsm'), ...behaviors],
        headers: paths.filter(path => dmfImportKind(path) === 'header')
    };
}

/** The files a model (`.hsm`) or structure file (`.dmf`, by the extension of its URI) refers to. */
function referencedPaths(uri: string, text: string): { models: string[], headers: string[] } {
    return /\.dmf$/i.test(uri) ? dmfReferencedPaths(text) : { models: hsmImportPaths(text), headers: headerImportPaths(text) };
}

/**
 * The texts of the `.hsm` (and `.dmf`) files imported (transitively) by a model or structure file and of
 * the imported C/C++ headers
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
        const referenced = referencedPaths(current.uri, current.text);
        for (const path of referenced.headers) {
            await readHeader(headerCandidates(path, UriUtils.dirname(URI.parse(current.uri)), headers));
        }
        for (const path of referenced.models) {
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
