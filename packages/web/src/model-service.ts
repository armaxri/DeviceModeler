import { cppHeaderStore, HsmModelLoader, importKind, type CppHeaderSettings, type ParsedModel } from 'hsm-language';

export interface SyntaxProblem {
    message: string;
    /** Offset of the offending token (the length of the text at the end of the input). */
    offset: number;
    /** Text of the offending token. */
    found?: string;
}

/**
 * A short description of a syntax error in the text inserted at `[start, end)`,
 * e.g. `incomplete – ']' expected` or `unexpected '/'`.
 */
export function describeSyntaxProblem(problem: SyntaxProblem, start: number, end: number): string {
    const expected = /Expecting token of type --> (.*?) <--/.exec(problem.message)?.[1];
    const suffix = expected ? ` – ${expected} expected` : '';
    if (problem.found === undefined && !/but found/.test(problem.message)) {
        return problem.message;
    }
    if (problem.offset >= end || problem.found === undefined) {
        return `incomplete${suffix || ' – an expression is expected'}`;
    }
    if (problem.offset < start) {
        return problem.message;
    }
    return `unexpected '${problem.found}'${suffix}`;
}

const DOCUMENT_URI = 'memory:///model.hsm';

/**
 * Parses, links and validates the model text with the Langium services of the HSM language running
 * directly in the browser (no editor dependencies: used by the web app and the VS Code webview).
 *
 * Imports (`import "motor.hsm"`) are resolved relative to the URI of the edited document against
 * the texts of the other files given with {@link setWorkspace} (the browser has no file system): the
 * web app passes its examples and opened files, the VS Code webview the imported files read by the
 * extension. Imports of other files are reported as "file not found".
 */
export class HsmModelService {

    readonly loader = new HsmModelLoader();
    private latest?: ParsedModel;
    private latestVersion = -1;
    private queue: Promise<unknown> = Promise.resolve();
    private documentUri = DOCUMENT_URI;
    private files: Record<string, string> = {};
    private workspaceVersion = 0;

    /** The URI of the edited document. */
    get uri(): string {
        return this.documentUri;
    }

    /**
     * Sets the URI of the edited document (imports are resolved relative to it) and the texts of the
     * other files it may import, by URI (or by path relative to the document): state machines (`.hsm`)
     * and C/C++ headers (`.h`, `.hpp`, ...; `headers`: include paths and defines of their analysis).
     */
    setWorkspace(documentUri: string, files: Record<string, string>, headers: CppHeaderSettings = {}): void {
        this.documentUri = documentUri;
        this.files = { ...files };
        const store = cppHeaderStore(this.loader.services.shared);
        for (const uri of store.uris) {
            if (!(uri in files)) {
                store.delete(uri);
            }
        }
        for (const [uri, text] of Object.entries(files)) {
            if (importKind(uri) === 'header' && /^[a-zA-Z][\w+.-]*:/.test(uri)) {
                store.setText(uri, text);
            }
        }
        if (JSON.stringify(headers) !== JSON.stringify(store.settings)) {
            store.updateSettings(headers);
        }
        this.workspaceVersion++;
    }

    /** The text of another file of the workspace (given with {@link setWorkspace}) by URI. */
    fileText(uri: string): string | undefined {
        if (uri in this.files) {
            return this.files[uri];
        }
        try {
            // URIs of the language services are encoded (`my%20file.h`), the keys may not be
            return this.files[decodeURIComponent(uri)];
        } catch {
            return undefined;
        }
    }

    /** Parses, links and validates the text. Calls are serialized. */
    parse(text: string): Promise<ParsedModel> {
        const result = this.queue.then(async () => {
            if (this.latest?.text === text && this.latestVersion === this.workspaceVersion) {
                return this.latest;
            }
            const version = this.workspaceVersion;
            const parsed = await this.loader.load(text, this.documentUri, { files: this.files });
            this.latest = parsed;
            this.latestVersion = version;
            return parsed;
        });
        this.queue = result.catch(() => undefined);
        return result;
    }

    /**
     * Messages of the lexer and parser errors of the given text (empty if it is syntactically valid).
     * Only the parser is used: no document is created and the linked model is not affected.
     */
    syntaxErrors(text: string): SyntaxProblem[] {
        const result = this.loader.services.Hsm.parser.LangiumParser.parse(text);
        return [
            ...result.lexerErrors.map(e => ({ message: e.message, offset: e.offset })),
            ...result.parserErrors.map(e => {
                const token = e.token;
                const eof = token.tokenType?.name === 'EOF' || Number.isNaN(token.startOffset);
                return { message: e.message, offset: eof ? text.length : token.startOffset, found: eof ? undefined : token.image };
            })
        ];
    }
}
