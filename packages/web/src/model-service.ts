import { createHsmServices, cppHeaderStore, DmfModelLoader, HsmModelLoader, importKind, type CppHeaderSettings, type DmfServices, type ParsedDmfModel, type ParsedModel } from 'hsm-language';

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

    private readonly services = createHsmServices();
    readonly loader = new HsmModelLoader(this.services);
    /** Loads structure files (`.dmf`, the Device Modeling Framework); shares the services (and documents) of {@link loader}. */
    readonly structureLoader = new DmfModelLoader(this.services);
    private latest?: ParsedModel;
    private latestVersion = -1;
    private latestStructure?: ParsedDmfModel;
    private latestStructureVersion = -1;
    private latestUri?: string;
    private latestStructureUri?: string;
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

    /** The services of the structure language. */
    get structureServices(): DmfServices {
        return this.services.Dmf;
    }

    /** Whether the edited document is a structure file (`.dmf`) instead of a state machine. */
    get isStructure(): boolean {
        return isStructureFile(this.documentUri);
    }

    /** Parses, links and validates the text of a structure file (`.dmf`). Calls are serialized (also with {@link parse}). */
    parseStructure(text: string): Promise<ParsedDmfModel> {
        const result = this.queue.then(async () => {
            if (this.latestStructure?.text === text && this.latestStructureVersion === this.workspaceVersion
                && this.latestStructureUri === this.documentUri) {
                return this.latestStructure;
            }
            const version = this.workspaceVersion;
            const parsed = await this.structureLoader.load(text, this.documentUri, { files: this.files });
            this.latestStructure = parsed;
            this.latestStructureVersion = version;
            this.latestStructureUri = this.documentUri;
            return parsed;
        });
        this.queue = result.catch(() => undefined);
        return result;
    }

    /** Parses, links and validates the text. Calls are serialized. */
    parse(text: string): Promise<ParsedModel> {
        const result = this.queue.then(async () => {
            if (this.latest?.text === text && this.latestVersion === this.workspaceVersion && this.latestUri === this.documentUri) {
                return this.latest;
            }
            const version = this.workspaceVersion;
            const parsed = await this.loader.load(text, this.documentUri, { files: this.files });
            this.latest = parsed;
            this.latestVersion = version;
            this.latestUri = this.documentUri;
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
        const parser = this.isStructure ? this.services.Dmf.parser.LangiumParser : this.loader.services.Hsm.parser.LangiumParser;
        const result = parser.parse(text);
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

/** Whether a file name or URI is a structure file (`.dmf`). */
export function isStructureFile(name: string): boolean {
    return /\.dmf$/i.test(name);
}
