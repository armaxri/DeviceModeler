import { URI, UriUtils } from 'langium';
import {
    createHsmServices, cppHeaderStore, DmfModelLoader, DmfWorkspace, HsmModelLoader, importKind, isModelPath, isStructureText,
    type CppHeaderSettings, type DmfServices, type ParsedDmfModel, type ParsedModel
} from 'hsm-language';

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

const DOCUMENT_URI = 'memory:///model.devm';

/**
 * Parses, links and validates the model text with the Langium services of the `.devm` language running
 * directly in the browser (no editor dependencies: used by the web app and the VS Code webview).
 *
 * Imports (`import "motor.devm"`) are resolved relative to the URI of the edited document against
 * the texts of the other files given with {@link setWorkspace} (the browser has no file system): the
 * web app passes its examples and opened files, the VS Code webview the imported files read by the
 * extension. Imports of other files are reported as "file not found".
 */
export class HsmModelService {

    private readonly services = createHsmServices();
    readonly loader = new HsmModelLoader(this.services);
    /** Loads structure files; shares the services (and documents) of {@link loader}. */
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
    /** All structure files of the workspace, loaded together (separate services): queries across files. */
    private readonly structures = new DmfWorkspace();
    private structuresQueue: Promise<unknown> = Promise.resolve();

    /** The URI of the edited document. */
    get uri(): string {
        return this.documentUri;
    }

    /**
     * Sets the URI of the edited document (imports are resolved relative to it) and the texts of the
     * other files it may import, by URI (or by path relative to the document): model files (`.devm`)
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

    /**
     * The structure files of the workspace – the files given with {@link setWorkspace} and the
     * edited file with the given text – loaded together, for queries across files (navigation, renames,
     * the structures using a state machine). The hosts pass all structure files of the workspace for this.
     */
    structureWorkspace(currentText: string): Promise<DmfWorkspace> {
        const files: Record<string, string> = {};
        const base = URI.parse(this.documentUri);
        for (const [key, text] of Object.entries(this.files)) {
            const uri = /^[a-zA-Z][\w+.-]*:/.test(key) && !/^[a-zA-Z]:[\\/]/.test(key) ? URI.parse(key) : UriUtils.resolvePath(UriUtils.dirname(base), key);
            files[uri.toString()] = text;
        }
        files[base.toString()] = currentText;
        const result = this.structuresQueue.then(async () => {
            await this.structures.update(files);
            return this.structures;
        });
        this.structuresQueue = result.catch(() => undefined);
        return result;
    }

    /**
     * The names of the other files of the workspace (relative to the edited file if they are in its
     * directory); `machines`: only the state machine files.
     */
    workspaceFileNames(machines = false): string[] {
        const base = UriUtils.dirname(URI.parse(this.documentUri)).toString();
        const keys = Object.keys(this.files).filter(key => !machines || (isModelPath(key) && !isStructureText(this.files[key])));
        return keys.map(key => {
            const uri = /^[a-zA-Z][\w+.-]*:/.test(key) ? URI.parse(key).toString() : key;
            return uri.startsWith(base + '/') ? decodeURIComponent(uri.substring(base.length + 1)) : uri;
        }).sort();
    }

    /** The services of the `.devm` language (state machines and structure files). */
    get structureServices(): DmfServices {
        return this.services.Dmf;
    }

    /** Parses, links and validates the text of a structure file. Calls are serialized (also with {@link parse}). */
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
        const parser = this.services.Hsm.parser.LangiumParser;
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

