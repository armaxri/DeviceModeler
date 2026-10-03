import { URI, type LangiumDocument } from 'langium';
import type { LangiumSharedServices } from 'langium/lsp';
import type { Diagnostic } from 'vscode-languageserver-types';
import * as ast from '../generated/ast.js';
import { createHsmServices } from '../hsm-module.js';
import { loadImports, type FileReader, type HsmModelLoaderOptions } from '../hsm-document.js';
import { cppHeaderStore } from '../cpp-headers.js';
import { importKind } from '../imports.js';
import { runTests, type TestResult, type TestRunOptions } from './runner.js';

/** A file of a test workspace: an `.devm` model, an `.devmtest` test file or a C/C++ header imported by a model. */
export interface WorkspaceFile {
    /** URI of the document; the extension selects the language (`.devm` or `.devmtest`) or a header (`.h`, `.hpp`, ...). */
    readonly uri: string;
    readonly text: string;
}

export interface LoadedDocument {
    readonly uri: string;
    readonly document: LangiumDocument;
    readonly diagnostics: Diagnostic[];
    /** Whether the document has errors (syntax, linking or validation). */
    readonly hasErrors: boolean;
}

/**
 * Loads `.devm` models and `.devmtest` test files into one workspace, so that test classes can
 * reference the state machines by name (`testclass T for statemachine M`). Works in Node.js and
 * in the browser. Documents with the same URI replace previously loaded ones.
 */
export class HsmTestWorkspace {

    readonly services: { shared: LangiumSharedServices };
    private readonly readFile: FileReader;

    /** `options.readFile` reads imported `.devm` files that are not among the loaded files (default: the file system provider). */
    constructor(services?: { shared: LangiumSharedServices }, options: HsmModelLoaderOptions = {}) {
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

    async load(files: readonly WorkspaceFile[]): Promise<LoadedDocument[]> {
        const workspace = this.services.shared.workspace;
        // C/C++ headers imported by the models are not documents (see cpp-headers.ts)
        const store = cppHeaderStore(this.services.shared);
        for (const file of files.filter(f => importKind(f.uri) === 'header')) {
            store.setText(URI.parse(file.uri), file.text);
        }
        const documents = files.filter(f => importKind(f.uri) !== 'header').map(file => {
            const uri = URI.parse(file.uri);
            if (workspace.LangiumDocuments.hasDocument(uri)) {
                workspace.LangiumDocuments.deleteDocument(uri);
            }
            const document = workspace.LangiumDocumentFactory.fromString(file.text, uri);
            workspace.LangiumDocuments.addDocument(document);
            return document;
        });
        // imported state machines that are not among the files (loaded transitively, see imports.ts)
        const imported = await loadImports(this.services.shared, documents, {}, this.readFile);
        await workspace.DocumentBuilder.build([...documents, ...imported], { validation: true });
        return documents.map(document => {
            const diagnostics = document.diagnostics ?? [];
            return {
                uri: document.uri.toString(),
                document,
                diagnostics,
                hasErrors: diagnostics.some(d => d.severity === 1)
                    || document.parseResult.lexerErrors.length > 0 || document.parseResult.parserErrors.length > 0
            };
        });
    }

    /** Loads the files and runs the tests of all test documents without errors. */
    async run(files: readonly WorkspaceFile[], options: TestRunOptions = {}): Promise<{ documents: LoadedDocument[], results: TestResult[] }> {
        const documents = await this.load(files);
        return { documents, results: this.runDocuments(documents, options) };
    }

    /** Runs the tests of all loaded test documents without errors. */
    runDocuments(documents: readonly LoadedDocument[], options: TestRunOptions = {}): TestResult[] {
        const results: TestResult[] = [];
        for (const loaded of documents) {
            const root = loaded.document.parseResult.value;
            if (ast.isTestModel(root) && !loaded.hasErrors) {
                results.push(...runTests(loaded.document as LangiumDocument<ast.TestModel>, undefined, options));
            }
        }
        return results;
    }
}
