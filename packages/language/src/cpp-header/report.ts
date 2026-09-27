import type { CppDeclaration, CppResolvedType, CppValue } from './model.js';
import type { CppTypeIndex } from './type-index.js';

/**
 * Short description of a resolved type, e.g. `integer (u8)`, `real (f64)`, `enum motor::Mode`,
 * `struct motor::Pos`, `array of 4 integer (i32)`, `unsupported (pointer type)`.
 */
export function describeCppType(type: CppResolvedType): string {
    switch (type.kind) {
        case 'integer':
            return `integer (${type.signed ? 'i' : 'u'}${type.bits}${type.character ? ', character' : ''})`;
        case 'real':
            return `real (f${type.bits})`;
        case 'boolean':
        case 'string':
            return type.kind;
        case 'enum':
            return `enum ${type.cppName}`;
        case 'struct':
            return `struct ${type.cppName}`;
        case 'array':
            return `array of ${type.length ?? '?'} ${describeCppType(type.element)}`;
        case 'unsupported':
            return `unsupported (${type.reason})`;
    }
}

/** A JSON compatible form of a value: integers as numbers (as strings beyond 2^53). */
export function cppValueToJson(value: CppValue): unknown {
    if (typeof value === 'bigint') {
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
    }
    if (Array.isArray(value)) {
        return value.map(cppValueToJson);
    }
    if (typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, cppValueToJson(v)]));
    }
    return value;
}

/**
 * The analyzed and resolved model of the headers of an index as a JSON compatible object (used by
 * `hsm cpp-header`): declarations with their resolved types and values, includes, macros and
 * diagnostics. Lines are 1-based.
 */
export function cppHeaderReport(index: CppTypeIndex): unknown {
    const describe = (declaration: CppDeclaration): unknown => {
        const common = {
            name: declaration.name || undefined,
            qualifiedName: declaration.qualifiedName,
            line: declaration.nameRange.start.line + 1,
            ...(declaration.doc ? { doc: declaration.doc } : {})
        };
        switch (declaration.kind) {
            case 'namespace':
                return {
                    kind: 'namespace', ...common, ...(declaration.inline ? { inline: true } : {}),
                    ...(declaration.anonymous ? { anonymous: true } : {}), members: declaration.members.map(describe)
                };
            case 'namespaceAlias':
                return { kind: 'namespaceAlias', ...common, target: declaration.target.parts.map(p => p.name).join('::') };
            case 'usingDirective':
                return { kind: 'usingDirective', line: common.line, target: declaration.target.parts.map(p => p.name).join('::') };
            case 'enum': {
                const type = index.typeOf(declaration);
                return {
                    kind: declaration.scoped ? 'enum class' : 'enum', ...common,
                    underlying: type.kind === 'enum' ? type.underlying.cppName : undefined,
                    enumerators: type.kind === 'enum' ? type.enumerators.map(e => ({
                        name: e.name, value: cppValueToJson(e.value), ...(e.valid ? {} : { valid: false }),
                        ...(e.declaration.doc ? { doc: e.declaration.doc } : {})
                    })) : []
                };
            }
            case 'record': {
                const type = index.typeOf(declaration);
                return {
                    kind: declaration.key, ...common, type: describeCppType(type),
                    ...(type.kind === 'struct' ? {
                        aggregate: type.aggregate,
                        fields: type.fields.map(f => ({
                            name: f.name, type: f.declaration.type.spelling, resolved: describeCppType(f.type),
                            ...(f.bitWidth !== undefined ? { bitWidth: f.bitWidth } : {}),
                            ...(f.defaultValue !== undefined ? { default: cppValueToJson(f.defaultValue) } : {}),
                            ...(f.inheritedFrom ? { inheritedFrom: f.inheritedFrom } : {}),
                            ...(f.declaration.doc ? { doc: f.declaration.doc } : {})
                        }))
                    } : {}),
                    ...(declaration.fields.some(f => f.access !== 'public') ? { nonPublicFields: declaration.fields.filter(f => f.access !== 'public').map(f => f.name) } : {}),
                    ...(declaration.members.length > 0 ? { members: declaration.members.map(describe) } : {})
                };
            }
            case 'alias':
                return { kind: 'alias', ...common, type: declaration.type.spelling, resolved: describeCppType(index.typeOf(declaration)) };
            case 'constant': {
                const info = index.constant(declaration);
                return {
                    kind: 'constant', ...common, type: declaration.type.spelling,
                    resolved: info ? describeCppType(info.type) : undefined,
                    ...(info?.value !== undefined ? { value: cppValueToJson(info.value) } : {}),
                    ...(info?.error ? { error: info.error } : {})
                };
            }
            default:
                return { kind: declaration.kind, ...common };
        }
    };
    return {
        headers: index.headers.map(header => ({
            fileName: header.fileName,
            includes: header.includes.map(i => i.system ? `<${i.path}>` : `"${i.path}"`),
            macros: header.macros.map(m => m.parameters ? `${m.name}(${m.parameters.join(', ')})` : m.name),
            declarations: header.declarations.map(describe)
        })),
        diagnostics: index.diagnostics.map(d => `${d.fileName}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${d.severity}: ${d.message}`)
    };
}
