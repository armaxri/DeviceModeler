import { URI, type LangiumDocument } from 'langium';
import type { LangiumSharedServices } from 'langium/lsp';
import type { Diagnostic } from 'vscode-languageserver-types';
import * as ast from '../generated/ast.js';
import { createHsmServices } from '../hsm-module.js';
import { runTests, type TestResult, type TestRunOptions } from './runner.js';

/** A file of a test workspace: an `.hsm` model or an `.hsmtest` test file. */
export interface WorkspaceFile {
    /** URI of the document; the extension selects the language (`.hsm` or `.hsmtest`). */
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
 * Loads `.hsm` models and `.hsmtest` test files into one workspace, so that test classes can
 * reference the state machines by name (`testclass T for statemachine M`). Works in Node.js and
 * in the browser. Documents with the same URI replace previously loaded ones.
 */
export class HsmTestWorkspace {

    readonly services: { shared: LangiumSharedServices };

    constructor(services?: { shared: LangiumSharedServices }) {
        this.services = services ?? createHsmServices();
    }

    async load(files: readonly WorkspaceFile[]): Promise<LoadedDocument[]> {
        const workspace = this.services.shared.workspace;
        const documents = files.map(file => {
            const uri = URI.parse(file.uri);
            if (workspace.LangiumDocuments.hasDocument(uri)) {
                workspace.LangiumDocuments.deleteDocument(uri);
            }
            const document = workspace.LangiumDocumentFactory.fromString(file.text, uri);
            workspace.LangiumDocuments.addDocument(document);
            return document;
        });
        await workspace.DocumentBuilder.build(documents, { validation: true });
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
