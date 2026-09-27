import { URI, type LangiumDocument } from 'langium';
import type { Diagnostic } from 'vscode-languageserver-types';
import { isStateMachine, type StateMachine } from './generated/ast.js';
import { createHsmServices, type HsmServices } from './hsm-module.js';
import type { LangiumSharedServices } from 'langium/lsp';
import { importKind, importPaths, resolveImportUri } from './imports.js';

export interface ParsedModel {
    text: string;
    document: LangiumDocument<StateMachine>;
    /** Root of the AST. May be incomplete if the text contains syntax errors. */
    model: StateMachine;
    diagnostics: Diagnostic[];
    /** True if the text contains lexer or parser errors. */
    hasSyntaxErrors: boolean;
    /** The `.hsm` files imported (transitively) by the model that could be loaded. */
    imported: ImportedModel[];
}

/** A file imported by a loaded model. */
export interface ImportedModel {
    uri: string;
    document: LangiumDocument;
    diagnostics: Diagnostic[];
    /** Whether the document has syntax or validation errors. */
    hasErrors: boolean;
}

/** Reads the text of a file, `undefined` if it does not exist or cannot be read. */
export type FileReader = (uri: URI) => Promise<string | undefined> | string | undefined;

export interface HsmModelLoaderOptions {
    /**
     * Reads imported files that are neither given to {@link HsmModelLoader.load} nor loaded before.
     * Default: the file system provider of the services (`NodeFileSystem` in Node.js; the empty file
     * system of the browser cannot read files).
     */
    readFile?: FileReader;
}

export interface LoadOptions {
    /**
     * Texts of other files, by URI or by path relative to the loaded document (`motor.hsm`). Imported
     * files are taken from here first, then read with `readFile`, then from the documents loaded before.
     */
    files?: Record<string, string>;
}

/**
 * Parses, links and validates HSM texts outside of a language server,
 * e.g. directly in the browser or in a command line tool.
 *
 * Imports (`import "motor.hsm"`) are loaded transitively, relative to the URI of the importing
 * document (see imports.ts): from the `files` given to {@link load}, with the `readFile` function of the
 * options or from previously loaded documents. Imports that cannot be loaded are reported by the
 * validator ("file not found").
 */
export class HsmModelLoader {

    readonly services: { shared: LangiumSharedServices, Hsm: HsmServices };
    private readonly readFile: FileReader;
    private counter = 0;

    constructor(services?: { shared: LangiumSharedServices, Hsm: HsmServices }, options: HsmModelLoaderOptions = {}) {
        this.services = services ?? createHsmServices();
        const fileSystem = this.services.shared.workspace.FileSystemProvider;
        this.readFile = options.readFile ?? (async uri => {
            try {
                return await fileSystem.readFile(uri);
            } catch {
                return undefined;
            }
        });
    }

    /**
     * Loads the given text. If a URI is given, a previously loaded document with the same
     * URI is replaced, otherwise a fresh in-memory document is created.
     */
    async load(text: string, uri?: string, options: LoadOptions = {}): Promise<ParsedModel> {
        const workspace = this.services.shared.workspace;
        const documentUri = URI.parse(uri ?? `memory:///model-${this.counter++}.hsm`);
        const document = this.replace(documentUri, text) as LangiumDocument<StateMachine>;
        const imported = await loadImports(this.services.shared, [document], options.files ?? {}, this.readFile);
        await workspace.DocumentBuilder.build([document, ...imported], { validation: true });
        const hasSyntaxErrors = document.parseResult.lexerErrors.length > 0 || document.parseResult.parserErrors.length > 0;
        return {
            text,
            document,
            model: document.parseResult.value,
            diagnostics: document.diagnostics ?? [],
            hasSyntaxErrors,
            imported: imported.map(importedModel)
        };
    }

    private replace(uri: URI, text: string): LangiumDocument {
        return replaceDocument(this.services.shared, uri, text);
    }
}

/** Creates a document for the text; a loaded document with the same URI is replaced. */
export function replaceDocument(shared: LangiumSharedServices, uri: URI, text: string): LangiumDocument {
    const documents = shared.workspace.LangiumDocuments;
    if (documents.hasDocument(uri)) {
        documents.deleteDocument(uri);
    }
    const document = shared.workspace.LangiumDocumentFactory.fromString(text, uri);
    documents.addDocument(document);
    return document;
}

/**
 * Loads the `.hsm` files imported (transitively) by the given documents that are not among them:
 * from `files` (by URI or by path relative to the first document), else with `readFile`, else the
 * text of an already loaded document. The documents are created anew (and replace loaded ones), so that they
 * can be built together with the importing documents. Returns the new documents (not built yet).
 */
export async function loadImports(shared: LangiumSharedServices, roots: LangiumDocument[], files: Record<string, string>, readFile: FileReader): Promise<LangiumDocument[]> {
    const documents = shared.workspace.LangiumDocuments;
    const base = roots[0]?.uri;
    const given = new Map<string, string>();
    for (const [key, text] of Object.entries(files)) {
        const uri = /^[a-zA-Z][\w+.-]*:/.test(key) && !/^[a-zA-Z]:[\\/]/.test(key) ? URI.parse(key) : base ? resolveImportUri(base, key) : URI.file(key);
        given.set(uri.toString(), text);
    }
    const seen = new Set(roots.map(d => d.uri.toString()));
    const result: LangiumDocument[] = [];
    const queue = [...roots];
    while (queue.length > 0) {
        const document = queue.shift()!;
        const root = document.parseResult.value;
        if (!isStateMachine(root)) {
            continue;
        }
        for (const path of importPaths(root)) {
            if (!path.path || importKind(path.path) !== 'hsm') {
                continue;
            }
            const uri = resolveImportUri(document.uri, path.path);
            const key = uri.toString();
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            let text = given.get(key);
            if (text === undefined) {
                text = await readFile(uri);
            }
            if (text === undefined && documents.hasDocument(uri)) {
                text = documents.getDocument(uri)!.textDocument.getText();
            }
            if (text === undefined) {
                continue;
            }
            const imported = replaceDocument(shared, uri, text);
            result.push(imported);
            queue.push(imported);
        }
    }
    return result;
}

function importedModel(document: LangiumDocument): ImportedModel {
    const diagnostics = document.diagnostics ?? [];
    return {
        uri: document.uri.toString(),
        document,
        diagnostics,
        hasErrors: diagnostics.some(d => d.severity === 1)
            || document.parseResult.lexerErrors.length > 0 || document.parseResult.parserErrors.length > 0
    };
}
