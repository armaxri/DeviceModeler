import { evaluateExpression, EvaluationError, DEFAULT_DATA_MODEL, truthy, type EvaluationContext } from './evaluator.js';
import { joinTokens, SyntaxError, TokenCursor } from './syntax.js';
import { tokenize, type LineMap, type Token } from './lexer.js';
import type { CppDiagnosticSeverity, CppInclude, CppMacro, CppParseOptions } from './model.js';

/**
 * A small preprocessor for the header analyzer:
 * - evaluates conditional directives (`#if`, `#ifdef`, `#ifndef`, `#elif`, `#elifdef`, `#elifndef`,
 *   `#else`, `#endif`) with the macros defined in the header (and the predefined ones) – undefined
 *   identifiers are `0`, `__has_include(…)` and friends are `0`; a condition that cannot be evaluated
 *   is reported and treated as false,
 * - records `#include` and `#define` / `#undef`,
 * - expands object-like and function-like macros defined in the header (including `#`, `##` and
 *   `__VA_ARGS__`), so e.g. `#define BIT(n) (1u << (n))` can be used in enumerator values.
 *
 * Macros of included headers are unknown (headers are analyzed one by one).
 *
 * @module
 * @internal
 */

export interface PreprocessProblem {
    readonly severity: CppDiagnosticSeverity;
    readonly message: string;
    readonly offset: number;
    readonly end: number;
}

export interface PreprocessResult {
    /** The tokens of the active branches (directives removed, macros expanded), ending with `eof`. */
    readonly tokens: Token[];
    readonly includes: CppInclude[];
    readonly macros: CppMacro[];
    readonly problems: PreprocessProblem[];
}

interface MacroDefinition {
    readonly name: string;
    readonly parameters?: readonly string[];
    readonly variadic: boolean;
    readonly body: readonly Token[];
}

interface Conditional {
    readonly parentActive: boolean;
    active: boolean;
    taken: boolean;
    readonly directive: Token;
}

const HAS_CHECKS = new Set([
    '__has_include', '__has_include_next', '__has_cpp_attribute', '__has_attribute', '__has_builtin', '__has_feature',
    '__has_extension', '__has_c_attribute', '__has_warning', '__has_declspec_attribute', '__is_identifier'
]);

/** Appends tokens (without spreading, which fails for very long arrays). */
function append(target: Token[], tokens: readonly Token[]): void {
    for (const token of tokens) {
        target.push(token);
    }
}

/** Maximum number of tokens produced by macro expansion (protection against exponential macros). */
const EXPANSION_LIMIT = 2_000_000;

export function preprocess(input: readonly Token[], lines: LineMap, options: CppParseOptions = {}): PreprocessResult {
    const macros = new Map<string, MacroDefinition>();
    const recorded: CppMacro[] = [];
    const includes: CppInclude[] = [];
    const problems: PreprocessProblem[] = [];
    const output: Token[] = [];
    const stack: Conditional[] = [];
    let pending: Token[] = [];
    let expanded = 0;

    const define = (name: string, value: string) => {
        const body = tokenize(value, 0, false).tokens.filter(t => t.kind !== 'eof');
        macros.set(name, { name, variadic: false, body });
    };
    define('__cplusplus', '201703L');
    for (const [name, value] of Object.entries(options.defines ?? {})) {
        define(name, value);
    }

    const active = () => stack.length === 0 || stack[stack.length - 1].active;

    const flush = () => {
        if (pending.length > 0) {
            append(output, expand(pending, new Set()));
            pending = [];
        }
    };

    for (const token of input) {
        if (token.kind === 'eof') {
            flush();
            output.push(token);
            break;
        }
        if (token.kind !== 'directive') {
            if (active()) {
                pending.push(token);
            }
            continue;
        }
        const match = /^(\w*)\s*([\s\S]*)$/.exec(token.text)!;
        const directive = match[1];
        const rest = match[2];
        const problem = (severity: CppDiagnosticSeverity, message: string) =>
            problems.push({ severity, message, offset: token.offset, end: token.end });
        switch (directive) {
            case 'if':
            case 'ifdef':
            case 'ifndef': {
                const parentActive = active();
                const condition = parentActive && condition_(directive, rest, token, problem);
                stack.push({ parentActive, active: condition, taken: condition, directive: token });
                continue;
            }
            case 'elif':
            case 'elifdef':
            case 'elifndef': {
                const top = stack[stack.length - 1];
                if (!top) {
                    problem('error', `#${directive} without #if`);
                    continue;
                }
                if (top.taken || !top.parentActive) {
                    top.active = false;
                } else {
                    top.active = condition_(directive === 'elif' ? 'if' : directive.slice(2), rest, token, problem);
                    top.taken = top.active;
                }
                continue;
            }
            case 'else': {
                const top = stack[stack.length - 1];
                if (!top) {
                    problem('error', '#else without #if');
                    continue;
                }
                top.active = top.parentActive && !top.taken;
                top.taken = true;
                continue;
            }
            case 'endif':
                if (!stack.pop()) {
                    problem('error', '#endif without #if');
                }
                continue;
        }
        if (!active()) {
            continue;
        }
        flush();
        switch (directive) {
            case 'define':
                defineMacro(rest, token, problem);
                break;
            case 'undef':
                macros.delete(rest.trim());
                break;
            case 'include':
            case 'include_next':
            case 'import': {
                const include = /^(?:"([^"]*)"|<([^>]*)>)/.exec(rest.trim());
                if (include) {
                    includes.push({ path: include[1] ?? include[2], system: include[2] !== undefined, range: lines.range(token.offset, token.end) });
                }
                break;
            }
            case 'error':
                problem('warning', `#error ${rest}`);
                break;
            default:
                // #pragma, #line, #warning, #ident, null directive: ignored
                break;
        }
    }
    for (const open of stack) {
        problems.push({ severity: 'error', message: `unterminated #${/^\w+/.exec(open.directive.text)?.[0] ?? 'if'}`, offset: open.directive.offset, end: open.directive.end });
    }
    return { tokens: output, includes, macros: recorded, problems };

    function defineMacro(text: string, token: Token, problem: (severity: CppDiagnosticSeverity, message: string) => void): void {
        const base = token.offset + token.text.indexOf(text) + 1;
        const tokens = tokenize(text, base, false).tokens.filter(t => t.kind !== 'eof');
        const nameToken = tokens[0];
        if (!nameToken || nameToken.kind !== 'identifier') {
            problem('warning', 'invalid #define');
            return;
        }
        let bodyStart = 1;
        let parameters: string[] | undefined;
        let variadic = false;
        if (tokens[1]?.text === '(' && tokens[1].offset === nameToken.end) {
            parameters = [];
            let i = 2;
            for (; i < tokens.length && tokens[i].text !== ')'; i++) {
                const t = tokens[i];
                if (t.text === '...') {
                    variadic = true;
                    parameters.push('__VA_ARGS__');
                } else if (t.kind === 'identifier') {
                    if (tokens[i + 1]?.text === '...') {
                        variadic = true;
                        i++;
                    }
                    parameters.push(t.text);
                }
            }
            bodyStart = i + 1;
        }
        const body = tokens.slice(bodyStart);
        macros.set(nameToken.text, { name: nameToken.text, parameters, variadic, body });
        recorded.push({
            name: nameToken.text,
            ...(parameters ? { parameters } : {}),
            body: joinTokens(body),
            range: lines.range(token.offset, token.end)
        });
    }

    function condition_(directive: string, text: string, token: Token, problem: (severity: CppDiagnosticSeverity, message: string) => void): boolean {
        if (directive === 'ifdef') {
            return macros.has(text.trim().split(/\s/)[0]);
        }
        if (directive === 'ifndef') {
            return !macros.has(text.trim().split(/\s/)[0]);
        }
        try {
            return evaluateCondition(text, token.offset + 1);
        } catch (error) {
            if (error instanceof EvaluationError || error instanceof SyntaxError) {
                problem('warning', `cannot evaluate '#${directive} ${text}' (${error.message}); the condition is treated as false`);
                return false;
            }
            throw error;
        }
    }

    function evaluateCondition(text: string, base: number): boolean {
        const raw = tokenize(text, base, false).tokens.filter(t => t.kind !== 'eof');
        const replaced: Token[] = [];
        const number = (value: boolean, at: Token): Token => ({ kind: 'number', text: value ? '1' : '0', offset: at.offset, end: at.end, lineStart: false, noExpand: true });
        for (let i = 0; i < raw.length; i++) {
            const t = raw[i];
            if (t.kind === 'identifier' && t.text === 'defined') {
                let name: Token | undefined;
                if (raw[i + 1]?.text === '(') {
                    name = raw[i + 2];
                    i += 3;
                } else {
                    name = raw[i + 1];
                    i += 1;
                }
                replaced.push(number(name !== undefined && macros.has(name.text), t));
            } else if (t.kind === 'identifier' && HAS_CHECKS.has(t.text) && raw[i + 1]?.text === '(') {
                let depth = 0;
                let j = i + 1;
                for (; j < raw.length; j++) {
                    if (raw[j].text === '(') {
                        depth++;
                    } else if (raw[j].text === ')' && --depth === 0) {
                        break;
                    }
                }
                replaced.push(number(false, t));
                i = j;
            } else {
                replaced.push(t);
            }
        }
        const tokens = expand(replaced, new Set()).map((t, i, all): Token => {
            if (t.kind !== 'identifier') {
                return t;
            }
            if (all[i + 1]?.text === '(' && t.text !== 'sizeof') {
                throw new EvaluationError(`'${t.text}' is not a defined function-like macro`);
            }
            return number(t.text === 'true', t);
        });
        const last = tokens[tokens.length - 1];
        tokens.push({ kind: 'eof', text: '', offset: last?.end ?? base, end: last?.end ?? base, lineStart: true });
        const cursor = new TokenCursor(tokens, lines);
        const node = cursor.parseConditional(false);
        if (!cursor.atEnd()) {
            throw new EvaluationError(`unexpected '${cursor.peek().text}'`);
        }
        const context: EvaluationContext = {
            dataModel: DEFAULT_DATA_MODEL,
            resolveValue: () => {
                throw new EvaluationError('unexpected name');
            },
            resolveType: () => {
                throw new EvaluationError('casts are not allowed in #if');
            },
            resolveTypeName: () => undefined
        };
        return truthy(evaluateExpression(node, context), node.range);
    }

    /** Expands the macros in `tokens`; macros in `hide` are not expanded (they are being expanded). */
    function expand(tokens: readonly Token[], hide: ReadonlySet<string>): Token[] {
        const out: Token[] = [];
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            const macro = token.kind === 'identifier' && !token.noExpand ? macros.get(token.text) : undefined;
            if (!macro) {
                out.push(token);
                continue;
            }
            if (hide.has(macro.name)) {
                out.push({ ...token, noExpand: true });
                continue;
            }
            if (expanded > EXPANSION_LIMIT) {
                out.push(token);
                continue;
            }
            const inner = new Set(hide).add(macro.name);
            if (!macro.parameters) {
                const body = instantiate(macro.body, token);
                expanded += body.length;
                append(out, expand(body, inner));
                continue;
            }
            if (tokens[i + 1]?.text !== '(') {
                out.push(token);
                continue;
            }
            const call = collectArguments(tokens, i + 1);
            if (!call) {
                out.push(token);
                continue;
            }
            const close = tokens[call.end];
            const use: Token = { ...token, end: close.end, trailingDoc: close.trailingDoc };
            const body = substitute(macro, call.args, use, hide);
            expanded += body.length;
            append(out, expand(body, inner));
            i = call.end;
        }
        return out;
    }

    /** Copies macro body tokens to the location of the macro use. */
    function instantiate(body: readonly Token[], use: Token): Token[] {
        return body.map((t, index): Token => ({
            ...t, offset: use.offset, end: use.end, lineStart: index === 0 && use.lineStart,
            doc: index === 0 ? use.doc : undefined, trailingDoc: index === body.length - 1 ? use.trailingDoc : undefined
        }));
    }

    function collectArguments(tokens: readonly Token[], open: number): { args: Token[][], end: number } | undefined {
        const args: Token[][] = [[]];
        let depth = 0;
        for (let j = open; j < tokens.length; j++) {
            const t = tokens[j];
            if (t.kind === 'punctuator' && t.text === '(') {
                if (depth++ === 0) {
                    continue;
                }
            } else if (t.kind === 'punctuator' && t.text === ')') {
                if (--depth === 0) {
                    return { args, end: j };
                }
            } else if (t.kind === 'punctuator' && t.text === ',' && depth === 1) {
                args.push([]);
                continue;
            }
            args[args.length - 1].push(t);
        }
        return undefined;
    }

    function substitute(macro: MacroDefinition, args: Token[][], use: Token, hide: ReadonlySet<string>): Token[] {
        const parameters = macro.parameters ?? [];
        const argumentOf = (name: string): Token[] | undefined => {
            const index = parameters.indexOf(name);
            if (index < 0) {
                return undefined;
            }
            if (macro.variadic && index === parameters.length - 1) {
                const rest = args.slice(index);
                return rest.flatMap((arg, k) => k === 0 ? arg : [{ kind: 'punctuator', text: ',', offset: use.offset, end: use.end, lineStart: false } as Token, ...arg]);
            }
            return args[index] ?? [];
        };
        const body = instantiate(macro.body, use);
        const result: Token[] = [];
        for (let k = 0; k < body.length; k++) {
            const t = body[k];
            if (t.text === '#' && t.kind === 'punctuator' && body[k + 1] && argumentOf(body[k + 1].text)) {
                const text = joinTokens(argumentOf(body[k + 1].text)!);
                result.push({ kind: 'string', text: JSON.stringify(text), offset: use.offset, end: use.end, lineStart: false, codes: Array.from(text, ch => ch.codePointAt(0)!), prefix: '' });
                k++;
                continue;
            }
            if (t.text === '##' && t.kind === 'punctuator') {
                const next = body[k + 1];
                k++;
                if (!next) {
                    continue;
                }
                const right = argumentOf(next.text) ?? [next];
                const left = result.pop();
                if (!left) {
                    append(result, right);
                    continue;
                }
                const [first, ...others] = right;
                if (!first) {
                    result.push(left);
                    continue;
                }
                const pasted = tokenize(left.text + first.text, 0, false).tokens.filter(p => p.kind !== 'eof');
                if (pasted.length === 1) {
                    result.push({ ...pasted[0], offset: use.offset, end: use.end, lineStart: false });
                } else {
                    result.push(left, first);
                }
                append(result, others);
                continue;
            }
            if (t.kind === 'identifier' && t.text === '__VA_OPT__' && body[k + 1]?.text === '(') {
                // __VA_OPT__(x): x if there are variadic arguments
                let depth = 0;
                let j = k + 1;
                for (; j < body.length; j++) {
                    if (body[j].text === '(') {
                        depth++;
                    } else if (body[j].text === ')' && --depth === 0) {
                        break;
                    }
                }
                const hasVarArgs = (argumentOf('__VA_ARGS__') ?? []).length > 0;
                if (hasVarArgs) {
                    append(result, body.slice(k + 2, j));
                }
                k = j;
                continue;
            }
            const arg = t.kind === 'identifier' ? argumentOf(t.text) : undefined;
            if (arg) {
                const pastedNext = body[k + 1]?.text === '##';
                const argTokens = pastedNext ? arg : expand(arg, hide);
                append(result, argTokens.map(a => ({ ...a, offset: use.offset, end: use.end, lineStart: false, doc: undefined })));
                continue;
            }
            result.push(t);
        }
        return result;
    }
}
