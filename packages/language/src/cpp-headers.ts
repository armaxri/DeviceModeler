import { URI, UriUtils } from 'langium';
import type { LangiumSharedCoreServices } from 'langium';
import { parseCppHeader } from './cpp-header/parser.js';
import { CppTypeIndex } from './cpp-header/type-index.js';
import type { CppDataModel, CppDiagnostic, CppHeader } from './cpp-header/model.js';

/**
 * C/C++ header imports (`import "motor_types.h"`): the texts of the headers, the settings of the
 * analysis (include paths, predefined macros, data model) and the resolution of header paths.
 *
 * Header texts are not Langium documents. Every host puts them into the {@link CppHeaderStore} of
 * its services ({@link cppHeaderStore}):
 * - `HsmModelLoader.load` / `HsmTestWorkspace` / `loadImports` load them from the given `files`
 *   or with the (async) `readFile` function before the documents are built,
 * - the language server and the CLI install a synchronous {@link CppHeaderStore.reader} (Node `fs`),
 *   so headers are read on demand; the language server invalidates changed files,
 * - the web app and the VS Code webview set the texts of their virtual files.
 *
 * Resolution is synchronous: when a state machine is linked, the `HsmImportResolver` looks up the
 * imported headers in the store ({@link resolveHeaderPath}), follows their `#include`s and builds one
 * `CppTypeIndex` for the machine (cached by the versions of the headers and the settings).
 */

/** Settings of the header analysis (the `headers` block of `hsm.gen.json`, CLI `-I` / `-D`, VS Code settings). */
export interface CppHeaderSettings {
    /**
     * Include directories, searched (in order) after the directory of the importing file for
     * `import "x.h"` and for the `#include`s of headers. URIs (`file:///...`) or absolute paths.
     */
    readonly includePaths?: readonly string[];
    /** Predefined macros (`NAME` -> value, `''` for a macro without value), like `-D` of a compiler. */
    readonly defines?: Readonly<Record<string, string>>;
    /** Data model of the target: widths of `long` and `size_t` / pointers, signedness of `char` (default: LP64, signed char). */
    readonly dataModel?: Partial<CppDataModel>;
}

/** A header found for an import or `#include`. */
export interface LoadedHeader {
    readonly uri: URI;
    /** Version of the text in the store (changes when the text changes). */
    readonly version: number;
    readonly header: CppHeader;
}

/** The headers imported by a state machine and the index over them. */
export interface CppImportInfo {
    readonly index: CppTypeIndex;
    /** The imported headers and the headers they include (transitively), without duplicates. */
    readonly headers: readonly LoadedHeader[];
}

interface StoredText {
    readonly text: string;
    readonly version: number;
}

let versionCounter = 0;

/** Texts of C/C++ headers by URI, analysis settings and caches of parsed headers / indexes. */
export class CppHeaderStore {

    private readonly texts = new Map<string, StoredText>();
    /** Texts read by the {@link reader} (`undefined`: the file does not exist). */
    private readonly readTexts = new Map<string, StoredText | undefined>();
    private readonly parsed = new Map<string, { version: number, defines: string, header: CppHeader }>();
    private readonly indexes = new Map<string, CppTypeIndex>();

    /** Reads a header synchronously if its text was not set (Node hosts: `fs.readFileSync`); `undefined` if it does not exist. */
    reader?: (uri: URI) => string | undefined;

    /** Settings used for all documents (unless {@link settingsProvider} gives settings for a document). */
    settings: CppHeaderSettings = {};

    /** Settings for a document, e.g. from the `hsm.gen.json` next to it (merged over {@link settings}). */
    settingsProvider?: (documentUri: URI) => CppHeaderSettings | undefined;

    /** Sets the text of a header (replaces a text read before). */
    setText(uri: URI | string, text: string): void {
        const key = uri.toString();
        if (this.texts.get(key)?.text !== text) {
            this.texts.set(key, { text, version: ++versionCounter });
        }
    }

    /** Removes the text of a header set with {@link setText} and forgets a text read before. */
    delete(uri: URI | string): void {
        const key = uri.toString();
        this.texts.delete(key);
        this.readTexts.delete(key);
    }

    /** Forgets the texts read by the {@link reader} (all, or those of the given URIs), e.g. when files changed on disk. */
    invalidate(uris?: ReadonlyArray<URI | string>): void {
        if (!uris) {
            this.readTexts.clear();
            return;
        }
        for (const uri of uris) {
            this.readTexts.delete(uri.toString());
        }
    }

    /** Whether a text is known for the URI (set, or read before). */
    has(uri: URI | string): boolean {
        return this.texts.has(uri.toString()) || this.readTexts.get(uri.toString()) !== undefined;
    }

    /** The URIs of all texts set with {@link setText}. */
    get uris(): string[] {
        return [...this.texts.keys()];
    }

    /** The text of a header: set with {@link setText}, else read with the {@link reader}. */
    get(uri: URI): StoredText | undefined {
        const key = uri.toString();
        const set = this.texts.get(key);
        if (set) {
            return set;
        }
        if (this.readTexts.has(key)) {
            return this.readTexts.get(key);
        }
        if (!this.reader) {
            return undefined;
        }
        let text: string | undefined;
        try {
            text = this.reader(uri);
        } catch {
            text = undefined;
        }
        const stored = text === undefined ? undefined : { text, version: ++versionCounter };
        this.readTexts.set(key, stored);
        return stored;
    }

    /** The current version of the text of a header (`undefined` if it is unknown), without reading it. */
    version(uri: URI | string): number | undefined {
        const key = uri.toString();
        return (this.texts.get(key) ?? this.readTexts.get(key))?.version;
    }

    /** The effective settings for a document. */
    settingsFor(documentUri: URI | undefined): CppHeaderSettings {
        const own = documentUri ? this.settingsProvider?.(documentUri) : undefined;
        if (!own) {
            return this.settings;
        }
        return {
            includePaths: [...own.includePaths ?? [], ...this.settings.includePaths ?? []],
            defines: { ...this.settings.defines, ...own.defines },
            dataModel: { ...this.settings.dataModel, ...own.dataModel }
        };
    }

    /** Loads (and parses) the header at `uri`; `undefined` if there is no text for it. */
    load(uri: URI, settings: CppHeaderSettings): LoadedHeader | undefined {
        const stored = this.get(uri);
        if (!stored) {
            return undefined;
        }
        const key = uri.toString();
        const defines = JSON.stringify(settings.defines ?? {});
        const cached = this.parsed.get(key);
        if (cached && cached.version === stored.version && cached.defines === defines) {
            return { uri, version: stored.version, header: cached.header };
        }
        const header = parseCppHeader(stored.text, key, { defines: settings.defines });
        this.parsed.set(key, { version: stored.version, defines, header });
        return { uri, version: stored.version, header };
    }

    /** The index over the given headers (cached by their versions and the data model). */
    index(headers: readonly LoadedHeader[], settings: CppHeaderSettings): CppTypeIndex {
        const key = JSON.stringify([headers.map(h => [h.uri.toString(), h.version]), settings.defines ?? {}, settings.dataModel ?? {}]);
        let index = this.indexes.get(key);
        if (!index) {
            if (this.indexes.size > 64) {
                this.indexes.clear();
            }
            index = new CppTypeIndex(headers.map(h => h.header), { dataModel: settings.dataModel });
            this.indexes.set(key, index);
        }
        return index;
    }
}

const stores = new WeakMap<object, CppHeaderStore>();

/** The header store of a set of (shared) services. */
export function cppHeaderStore(shared: LangiumSharedCoreServices): CppHeaderStore {
    let store = stores.get(shared);
    if (!store) {
        store = new CppHeaderStore();
        stores.set(shared, store);
    }
    return store;
}

/** An include path as URI (`file:///...`, other URIs, or absolute paths). */
export function includePathUri(path: string, base?: URI): URI {
    if (/^[a-zA-Z][\w+.-]+:\/\//.test(path)) {
        return URI.parse(path);
    }
    const normalized = path.replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')) {
        return base && base.scheme !== 'file' ? base.with({ path: normalized.startsWith('/') ? normalized : `/${normalized}` }) : URI.file(normalized);
    }
    return base ? UriUtils.resolvePath(base, normalized) : URI.file(normalized);
}

/**
 * The candidate locations of a header path: relative to the directory `directory` of the including
 * file (not for `<...>` includes), then relative to each include path. Absolute paths are used as they are.
 */
export function headerCandidates(path: string, directory: URI | undefined, settings: CppHeaderSettings, system = false): URI[] {
    const normalized = path.replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')) {
        return [includePathUri(normalized, directory)];
    }
    const result: URI[] = [];
    if (directory && !system) {
        result.push(UriUtils.resolvePath(directory, normalized));
    }
    for (const includePath of settings.includePaths ?? []) {
        result.push(UriUtils.resolvePath(includePathUri(includePath, directory), normalized));
    }
    const seen = new Set<string>();
    return result.filter(uri => !seen.has(uri.toString()) && seen.add(uri.toString()));
}

/** Finds a header in the store: the first candidate location with a text (see {@link headerCandidates}). */
export function resolveHeaderPath(store: CppHeaderStore, path: string, directory: URI | undefined, settings: CppHeaderSettings, system = false): { uri?: URI, searched: URI[] } {
    const searched = headerCandidates(path, directory, settings, system);
    return { uri: searched.find(uri => store.get(uri) !== undefined), searched };
}

/**
 * Loads a header and (transitively) the headers it includes that can be found (`#include "x.h"`
 * relative to the header and the include paths, `#include <x.h>` in the include paths; missing
 * includes like `<cstdint>` are ignored). The result starts with the header itself.
 */
export function loadHeaderClosure(store: CppHeaderStore, uri: URI, settings: CppHeaderSettings, seen = new Set<string>()): LoadedHeader[] {
    const result: LoadedHeader[] = [];
    const visit = (current: URI) => {
        const key = current.toString();
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        const loaded = store.load(current, settings);
        if (!loaded) {
            return;
        }
        result.push(loaded);
        for (const include of loaded.header.includes) {
            const found = resolveHeaderPath(store, include.path, UriUtils.dirname(current), settings, include.system).uri;
            if (found) {
                visit(found);
            }
        }
    };
    visit(uri);
    return result;
}

/** Candidate URIs of the `#include`s of a header text (used to load headers asynchronously before they are resolved). */
export function includeCandidates(header: CppHeader, uri: URI, settings: CppHeaderSettings): URI[][] {
    return header.includes.map(include => headerCandidates(include.path, UriUtils.dirname(uri), settings, include.system));
}

/** `file.h:12:5` (1-based) for a position in a header, with the path relative to `base` if possible. */
export function headerLocation(fileName: string, line: number, character: number, base?: URI): string {
    return `${displayPath(fileName, base)}:${line + 1}:${character + 1}`;
}

/** A header URI for messages: relative to the directory `base` if it is below it, the file system path otherwise. */
export function displayPath(fileName: string, base?: URI): string {
    let uri: URI;
    try {
        uri = URI.parse(fileName);
    } catch {
        return fileName;
    }
    if (base) {
        const prefix = base.toString().replace(/\/?$/, '/');
        if (uri.toString().startsWith(prefix)) {
            return decodeURIComponent(uri.toString().slice(prefix.length));
        }
    }
    return uri.scheme === 'file' ? uri.fsPath : uri.path;
}

/** Message for a diagnostic of a header, e.g. `motor.h:3:7: unknown type 'Foo'`. */
export function headerDiagnosticMessage(diagnostic: CppDiagnostic, base?: URI): string {
    return `${headerLocation(diagnostic.fileName, diagnostic.range.start.line, diagnostic.range.start.character, base)}: ${diagnostic.message}`;
}
