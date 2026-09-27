import { HsmModelLoader, type ParsedModel } from 'hsm-language';

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
 */
export class HsmModelService {

    readonly loader = new HsmModelLoader();
    private latest?: ParsedModel;
    private queue: Promise<unknown> = Promise.resolve();

    /** Parses, links and validates the text. Calls are serialized. */
    parse(text: string): Promise<ParsedModel> {
        const result = this.queue.then(async () => {
            if (this.latest?.text === text) {
                return this.latest;
            }
            const parsed = await this.loader.load(text, DOCUMENT_URI);
            this.latest = parsed;
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
