import type { CppPosition, CppRange } from './model.js';

/**
 * Tokenizer of the C++ header analyzer.
 *
 * Produces identifiers, pp-numbers, string / character literals (with prefixes and raw strings),
 * punctuators (longest match) and one `directive` token per preprocessor line (with line splices
 * joined and comments removed). Comments are dropped; documentation comments are attached to the
 * following token (`doc`) or, for the trailing forms `///<`, `//!<`, `/**<`, `/*!<`, to the
 * preceding token (`trailingDoc`).
 *
 * @module
 * @internal
 */

export type TokenKind = 'identifier' | 'number' | 'string' | 'char' | 'punctuator' | 'directive' | 'eof';

export interface Token {
    readonly kind: TokenKind;
    /** Source text (for directives: the directive without `#`, splices joined, comments removed). */
    readonly text: string;
    readonly offset: number;
    readonly end: number;
    /** Whether the token is the first token on its line. */
    readonly lineStart: boolean;
    /** Decoded value of string and character literals (code points). */
    readonly codes?: readonly number[];
    /** Encoding prefix of string and character literals (`''`, `u8`, `u`, `U`, `L`). */
    readonly prefix?: string;
    /** Documentation comment directly before the token. */
    doc?: string;
    /** Trailing documentation comment (`///<`) after the token. */
    trailingDoc?: string;
    /** Set on tokens produced by macro expansion that must not be expanded again. */
    noExpand?: boolean;
}

export interface LexProblem {
    readonly message: string;
    readonly offset: number;
    readonly end: number;
}

/** Punctuators, longest first per first character (checked in order). */
const PUNCTUATORS = [
    '<=>', '<<=', '>>=', '->*', '...',
    '::', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=',
    '&=', '|=', '^=', '.*', '##',
    '{', '}', '[', ']', '(', ')', ';', ':', '?', ',', '.', '+', '-', '*', '/', '%', '^', '&', '|', '~',
    '!', '=', '<', '>', '#'
];

const STRING_PREFIXES = new Set(['L', 'u', 'U', 'u8', 'R', 'LR', 'uR', 'UR', 'u8R']);

/** Maps offsets to 0-based line / character positions. */
export class LineMap {
    private readonly lineStarts: number[] = [0];

    constructor(readonly text: string) {
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (c === 10) {
                this.lineStarts.push(i + 1);
            } else if (c === 13) {
                if (text.charCodeAt(i + 1) === 10) {
                    i++;
                }
                this.lineStarts.push(i + 1);
            }
        }
    }

    position(offset: number): CppPosition {
        let low = 0;
        let high = this.lineStarts.length - 1;
        while (low < high) {
            const mid = (low + high + 1) >> 1;
            if (this.lineStarts[mid] <= offset) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return { line: low, character: offset - this.lineStarts[low] };
    }

    range(offset: number, end: number): CppRange {
        return { start: this.position(offset), end: this.position(Math.max(offset, end)) };
    }
}

function isIdentifierStart(c: string): boolean {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$' || c > '\x7f';
}

function isIdentifierPart(c: string): boolean {
    return isIdentifierStart(c) || (c >= '0' && c <= '9');
}

function isDigit(c: string): boolean {
    return c >= '0' && c <= '9';
}

/** Removes comment markers and Doxygen `@brief` from a documentation comment. */
export function cleanDocComment(comment: string): string {
    let lines: string[];
    if (comment.startsWith('/*')) {
        const body = comment.replace(/^\/\*[*!]<?/, '').replace(/\*\/$/, '');
        lines = body.split(/\r?\n/).map(line => line.replace(/^\s*\*(?!\/)\s?/, ''));
    } else {
        lines = comment.split(/\r?\n/).map(line => line.replace(/^\s*\/\/[/!]<?\s?/, ''));
    }
    const text = lines.map(line => line.trimEnd()).join('\n')
        .replace(/^\s*[@\\]brief\s+/gm, '')
        .trim();
    return text;
}

/** Whether a comment is a documentation comment and whether it is a trailing one (`///<`). */
function docKind(comment: string): 'leading' | 'trailing' | undefined {
    if (comment.startsWith('//')) {
        if (/^\/\/[/!]</.test(comment)) {
            return 'trailing';
        }
        return /^\/\/(\/(?!\/)|!)/.test(comment) ? 'leading' : undefined;
    }
    if (/^\/\*[*!]</.test(comment)) {
        return 'trailing';
    }
    return /^\/\*(\*(?![*/])|!)/.test(comment) ? 'leading' : undefined;
}

/** Decodes the characters of a (non-raw) string or character literal body. */
export function decodeEscapes(body: string): number[] {
    const codes: number[] = [];
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c !== '\\') {
            const code = body.codePointAt(i)!;
            codes.push(code);
            if (code > 0xffff) {
                i++;
            }
            continue;
        }
        const e = body[++i];
        switch (e) {
            case 'n': codes.push(10); break;
            case 't': codes.push(9); break;
            case 'r': codes.push(13); break;
            case 'a': codes.push(7); break;
            case 'b': codes.push(8); break;
            case 'f': codes.push(12); break;
            case 'v': codes.push(11); break;
            case 'e': codes.push(27); break;
            case 'x': {
                const match = /^[0-9a-fA-F]+/.exec(body.slice(i + 1));
                codes.push(match ? parseInt(match[0], 16) : 0);
                i += match ? match[0].length : 0;
                break;
            }
            case 'u':
            case 'U': {
                const length = e === 'u' ? 4 : 8;
                const hex = body.slice(i + 1, i + 1 + length);
                codes.push(parseInt(hex, 16) || 0);
                i += hex.length;
                break;
            }
            default:
                if (e !== undefined && e >= '0' && e <= '7') {
                    const match = /^[0-7]{1,3}/.exec(body.slice(i))!;
                    codes.push(parseInt(match[0], 8));
                    i += match[0].length - 1;
                } else if (e !== undefined) {
                    codes.push(e.codePointAt(0)!);
                }
        }
    }
    return codes;
}

export interface LexResult {
    readonly tokens: Token[];
    readonly problems: LexProblem[];
}

/**
 * Tokenizes C++ source text. Never throws; unterminated comments and literals are reported as
 * problems. The last token is always `eof`.
 *
 * @param text the source text
 * @param base offset added to all token offsets (for tokenizing a part of a larger text)
 * @param directives whether `#` at the start of a line starts a preprocessor directive
 */
export function tokenize(text: string, base = 0, directives = true): LexResult {
    const tokens: Token[] = [];
    const problems: LexProblem[] = [];
    let pendingDoc: string[] = [];
    let lineStart = true;
    let i = 0;
    const n = text.length;

    const push = (kind: TokenKind, start: number, end: number, extra?: Partial<Token>) => {
        const token: Token = { kind, text: text.slice(start, end), offset: base + start, end: base + end, lineStart, ...extra };
        if (pendingDoc.length > 0 && kind !== 'directive') {
            token.doc = pendingDoc.join('\n');
        }
        pendingDoc = [];
        tokens.push(token);
        lineStart = false;
    };

    const addDoc = (comment: string) => {
        const kind = docKind(comment);
        if (kind === 'trailing') {
            const last = tokens[tokens.length - 1];
            if (last && last.kind !== 'directive') {
                const doc = cleanDocComment(comment);
                last.trailingDoc = last.trailingDoc ? `${last.trailingDoc}\n${doc}` : doc;
            }
        } else if (kind === 'leading') {
            pendingDoc.push(cleanDocComment(comment));
        }
    };

    while (i < n) {
        const c = text[i];
        // whitespace and line splices
        if (c === '\n' || c === '\r') {
            lineStart = true;
            i++;
            continue;
        }
        if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === '﻿') {
            i++;
            continue;
        }
        if (c === '\\' && (text[i + 1] === '\n' || text[i + 1] === '\r')) {
            i += text[i + 1] === '\r' && text[i + 2] === '\n' ? 3 : 2;
            continue;
        }
        // comments
        if (c === '/' && text[i + 1] === '/') {
            let end = i;
            while (end < n && text[end] !== '\n' && text[end] !== '\r') {
                end++;
            }
            // consecutive `///` lines form one comment: handled by joining pending docs
            addDoc(text.slice(i, end));
            i = end;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            if (end < 0) {
                problems.push({ message: 'unterminated comment', offset: base + i, end: base + i + 2 });
                i = n;
                continue;
            }
            addDoc(text.slice(i, end + 2));
            i = end + 2;
            continue;
        }
        // preprocessor directive
        if (c === '#' && lineStart && directives) {
            const start = i;
            let body = '';
            i++;
            while (i < n) {
                const d = text[i];
                if (d === '\n' || d === '\r') {
                    break;
                }
                if (d === '\\' && (text[i + 1] === '\n' || text[i + 1] === '\r')) {
                    i += text[i + 1] === '\r' && text[i + 2] === '\n' ? 3 : 2;
                    body += ' ';
                    continue;
                }
                if (d === '/' && text[i + 1] === '/') {
                    while (i < n && text[i] !== '\n' && text[i] !== '\r') {
                        i++;
                    }
                    break;
                }
                if (d === '/' && text[i + 1] === '*') {
                    const end = text.indexOf('*/', i + 2);
                    i = end < 0 ? n : end + 2;
                    body += ' ';
                    continue;
                }
                if (d === '"' || d === '\'') {
                    // keep literals intact (they may contain `//`)
                    let j = i + 1;
                    while (j < n && text[j] !== d && text[j] !== '\n') {
                        j += text[j] === '\\' ? 2 : 1;
                    }
                    body += text.slice(i, j + 1);
                    i = j + 1;
                    continue;
                }
                body += d;
                i++;
            }
            body = body.trim();
            if (!/^(if|ifdef|ifndef|elif|elifdef|elifndef|else|endif)\b/.test(body)) {
                // a documentation comment before `#define` etc. documents the macro
                pendingDoc = [];
            }
            tokens.push({ kind: 'directive', text: body, offset: base + start, end: base + i, lineStart: true });
            lineStart = false;
            continue;
        }
        // identifiers and prefixed literals
        if (isIdentifierStart(c)) {
            let end = i + 1;
            while (end < n && isIdentifierPart(text[end])) {
                end++;
            }
            const word = text.slice(i, end);
            if (STRING_PREFIXES.has(word) && (text[end] === '"' || (text[end] === '\'' && !word.endsWith('R')))) {
                i = lexLiteral(i, end, word);
                continue;
            }
            push('identifier', i, end);
            i = end;
            continue;
        }
        // numbers (pp-number)
        if (isDigit(c) || (c === '.' && isDigit(text[i + 1] ?? ''))) {
            let end = i + 1;
            while (end < n) {
                const d = text[end];
                // pp-number: a sign after e, E, p, P belongs to the number (like in the preprocessor)
                if ((d === '+' || d === '-') && /[eEpP]/.test(text[end - 1])) {
                    end++;
                } else if (isIdentifierPart(d) || d === '.' || (d === '\'' && isIdentifierPart(text[end + 1] ?? ''))) {
                    end++;
                } else {
                    break;
                }
            }
            push('number', i, end);
            i = end;
            continue;
        }
        if (c === '"' || c === '\'') {
            i = lexLiteral(i, i, '');
            continue;
        }
        // punctuators
        let matched = false;
        for (const p of PUNCTUATORS) {
            if (text.startsWith(p, i)) {
                push('punctuator', i, i + p.length);
                i += p.length;
                matched = true;
                break;
            }
        }
        if (!matched) {
            push('punctuator', i, i + 1);
            i++;
        }
    }
    tokens.push({ kind: 'eof', text: '', offset: base + n, end: base + n, lineStart: true, doc: pendingDoc.length ? pendingDoc.join('\n') : undefined });
    return { tokens, problems };

    /** Lexes a string or character literal starting at `start` whose quote is at `quote`. */
    function lexLiteral(start: number, quote: number, prefix: string): number {
        const raw = prefix.endsWith('R');
        const encoding = raw ? prefix.slice(0, -1) : prefix;
        if (raw) {
            const open = text.indexOf('(', quote + 1);
            const delimiter = open >= 0 ? text.slice(quote + 1, open) : '';
            const close = open >= 0 && delimiter.length <= 16 && !/[\s\\]/.test(delimiter) ? text.indexOf(`)${delimiter}"`, open + 1) : -1;
            if (close < 0) {
                problems.push({ message: 'unterminated raw string literal', offset: base + start, end: base + quote + 1 });
                push('string', start, n, { codes: [], prefix: encoding });
                return n;
            }
            const end = close + delimiter.length + 2;
            const value = text.slice(open + 1, close);
            push('string', start, end, { codes: Array.from(value, ch => ch.codePointAt(0)!), prefix: encoding });
            return end;
        }
        const q = text[quote];
        let j = quote + 1;
        while (j < n && text[j] !== q && text[j] !== '\n' && text[j] !== '\r') {
            j += text[j] === '\\' ? 2 : 1;
        }
        if (j >= n || text[j] !== q) {
            problems.push({ message: q === '"' ? 'unterminated string literal' : 'unterminated character literal', offset: base + start, end: base + j });
            push(q === '"' ? 'string' : 'char', start, j, { codes: decodeEscapes(text.slice(quote + 1, j)), prefix: encoding });
            return j;
        }
        push(q === '"' ? 'string' : 'char', start, j + 1, { codes: decodeEscapes(text.slice(quote + 1, j)), prefix: encoding });
        return j + 1;
    }
}
