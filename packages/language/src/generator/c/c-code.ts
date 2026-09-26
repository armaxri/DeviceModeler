/**
 * Small helpers to build C source text: statement blocks with indentation, identifiers and literals.
 */

/** A list of C statements; nested blocks are indented by 4 spaces. */
export class CBlock {

    readonly lines: string[] = [];

    get length(): number {
        return this.lines.length;
    }

    get isEmpty(): boolean {
        return this.lines.length === 0;
    }

    add(...lines: string[]): this {
        this.lines.push(...lines);
        return this;
    }

    /** Inserts lines at a position (used to spill a value into a temporary before later statements). */
    insert(position: number, ...lines: string[]): void {
        this.lines.splice(position, 0, ...lines);
    }

    /** Appends a nested block: `header {`, the indented body, `}` (`footer` replaces the closing line). */
    block(header: string, body: CBlock | string[], footer = '}'): this {
        this.lines.push(header ? `${header} {` : '{');
        this.lines.push(...indent(body instanceof CBlock ? body.lines : body));
        this.lines.push(footer);
        return this;
    }

    append(other: CBlock | string[]): this {
        this.lines.push(...(other instanceof CBlock ? other.lines : other));
        return this;
    }
}

export function indent(lines: readonly string[], levels = 1): string[] {
    const prefix = '    '.repeat(levels);
    return lines.map(line => line.length > 0 ? prefix + line : line);
}

export const C_KEYWORDS: ReadonlySet<string> = new Set([
    'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern',
    'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed',
    'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
    '_Bool', '_Complex', '_Imaginary', 'bool', 'true', 'false', 'NULL', 'main', 'errno', 'assert',
    'h', 'handle', 'value'
]);

/** A valid C identifier derived from a text (invalid characters become `_`). */
export function cIdentifier(text: string): string {
    const id = text.replace(/[^A-Za-z0-9_]/g, '_');
    return /^[0-9]/.test(id) ? `_${id}` : id;
}

/** `CdPlayer` -> `cd_player`, `TrafficLight2` -> `traffic_light2`, `M` -> `m`. */
export function snakeCase(text: string): string {
    return cIdentifier(text)
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase();
}

/** Allocates unique identifiers: `name`, `name_2`, `name_3`, ... */
export class UniqueNames {

    private readonly used: Set<string>;

    constructor(reserved: Iterable<string> = C_KEYWORDS) {
        this.used = new Set(reserved);
    }

    get(base: string): string {
        let name = cIdentifier(base);
        for (let i = 2; this.used.has(name); i++) {
            name = `${cIdentifier(base)}_${i}`;
        }
        this.used.add(name);
        return name;
    }
}

/** A C string literal (UTF-8 is kept, quotes, backslashes, control characters and `??` trigraphs are escaped). */
export function cString(value: string): string {
    let result = '"';
    const bytes = new TextEncoder().encode(value);
    let previous = '';
    for (const byte of bytes) {
        const ch = String.fromCharCode(byte);
        if (ch === '"' || ch === '\\') {
            result += `\\${ch}`;
        } else if (ch === '\n') {
            result += '\\n';
        } else if (ch === '\t') {
            result += '\\t';
        } else if (ch === '\r') {
            result += '\\r';
        } else if (byte < 0x20 || byte === 0x7f || byte >= 0x80) {
            result += `\\${byte.toString(8).padStart(3, '0')}`;
        } else if (ch === '?' && previous === '?') {
            result += '\\?';
        } else {
            result += ch;
        }
        previous = ch;
    }
    return result + '"';
}

/** Escapes text for use in a C comment (`*` + `/` would end the comment). */
export function commentText(text: string): string {
    return text.replace(/\*\//g, '* /').replace(/\/\*/g, '/ *').replace(/\s+/g, ' ').trim();
}

const INT64_MIN = -(2n ** 63n);

/** A C expression for a 64-bit integer constant. */
export function cInteger(value: bigint): string {
    if (value === INT64_MIN) {
        return 'INT64_MIN';
    }
    if (value < 0n) {
        return `(-${cInteger(-value)})`;
    }
    return value > 2147483647n ? `INT64_C(${value})` : value.toString();
}

/** Removes redundant outer parentheses: `(a && b)` -> `a && b` (not `(a) + (b)`). */
export function stripParens(text: string): string {
    while (text.startsWith('(') && text.endsWith(')') && matchingParen(text, 0) === text.length - 1) {
        text = text.substring(1, text.length - 1);
    }
    return text;
}

function matchingParen(text: string, open: number): number {
    let depth = 0;
    let inString = false;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') {
                i++;
            } else if (ch === '"') {
                inString = false;
            }
        } else if (ch === '"') {
            inString = true;
        } else if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}
