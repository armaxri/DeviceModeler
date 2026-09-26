/**
 * C specific names; the text utilities are shared with the C++ generator (`../common/code.ts`).
 */
export { CBlock, cIdentifier, cInteger, commentText, cString, indent, snakeCase, stripParens, UniqueNames } from '../common/code.js';

/** Identifiers that generated names must not use (C keywords and the parameter names of the generated code). */
export const C_KEYWORDS: ReadonlySet<string> = new Set([
    'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern',
    'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed',
    'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
    '_Bool', '_Complex', '_Imaginary', 'bool', 'true', 'false', 'NULL', 'main', 'errno', 'assert',
    'h', 'handle', 'value'
]);
