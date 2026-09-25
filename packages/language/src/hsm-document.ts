import { URI, type LangiumDocument } from 'langium';
import type { Diagnostic } from 'vscode-languageserver-types';
import type { StateMachine } from './generated/ast.js';
import { createHsmServices, type HsmServices } from './hsm-module.js';
import type { LangiumSharedServices } from 'langium/lsp';

export interface ParsedModel {
    text: string;
    document: LangiumDocument<StateMachine>;
    /** Root of the AST. May be incomplete if the text contains syntax errors. */
    model: StateMachine;
    diagnostics: Diagnostic[];
    /** True if the text contains lexer or parser errors. */
    hasSyntaxErrors: boolean;
}

/**
 * Parses, links and validates HSM texts outside of a language server,
 * e.g. directly in the browser or in a command line tool.
 */
export class HsmModelLoader {

    readonly services: { shared: LangiumSharedServices, Hsm: HsmServices };
    private counter = 0;

    constructor(services?: { shared: LangiumSharedServices, Hsm: HsmServices }) {
        this.services = services ?? createHsmServices();
    }

    /**
     * Loads the given text. If a URI is given, a previously loaded document with the same
     * URI is replaced, otherwise a fresh in-memory document is created.
     */
    async load(text: string, uri?: string): Promise<ParsedModel> {
        const workspace = this.services.shared.workspace;
        const documentUri = URI.parse(uri ?? `memory:///model-${this.counter++}.hsm`);
        if (workspace.LangiumDocuments.hasDocument(documentUri)) {
            workspace.LangiumDocuments.deleteDocument(documentUri);
        }
        const document = workspace.LangiumDocumentFactory.fromString<StateMachine>(text, documentUri);
        workspace.LangiumDocuments.addDocument(document);
        await workspace.DocumentBuilder.build([document], { validation: true });
        const hasSyntaxErrors = document.parseResult.lexerErrors.length > 0 || document.parseResult.parserErrors.length > 0;
        return {
            text,
            document,
            model: document.parseResult.value,
            diagnostics: document.diagnostics ?? [],
            hasSyntaxErrors
        };
    }
}
