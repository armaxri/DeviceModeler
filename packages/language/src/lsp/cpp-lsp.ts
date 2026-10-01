import { AstUtils, CstUtils, type CstNode, type LangiumDocument } from 'langium';
import { DefaultCompletionProvider, type LangiumServices } from 'langium/lsp';
import { CompletionItemKind, MarkupKind, type CompletionItem, type CompletionList, type MarkupContent, type Range } from 'vscode-languageserver-types';

type CompletionParams = Parameters<DefaultCompletionProvider['getCompletion']>[1];
import * as ast from '../generated/ast.js';
import type { CppDeclaration, CppEnumType, CppRange, CppResolvedEnumerator, CppResolvedField } from '../cpp-header/model.js';
import type { CppTypeIndex } from '../cpp-header/type-index.js';
import { describeCppType } from '../cpp-header/report.js';
import { displayPath } from '../cpp-headers.js';
import { contextMachine, cppIndexAt, cppTypeOfReference, hsmTypeOfCpp, isEnumType, isStructType, memberOf, referenceMembers } from '../cpp-types.js';
import { enumeratorListItem, enumeratorSpelling, enumeratorValueMarkdown, enumeratorValueText } from '../cpp-enums.js';
import { cppImports, resolvedImports } from '../imports.js';
import {
    inferType, returnTypeOf, typeAliases, typeName, typeOfAlias, typeOfDeclaration, typeOfEvent, typeOfParameter, type HsmType
} from '../hsm-typesystem.js';

/**
 * Language server features for the C++ names of imported headers, shared by the VS Code language
 * server and the web app: hover (with the documentation comments of the headers), go to definition
 * (into the header) and completion of `ns::` names and struct members.
 */

/** A location in a header (for go to definition). */
export interface CppLocation {
    /** URI of the header. */
    readonly uri: string;
    /** Range of the whole declaration. */
    readonly range: Range;
    /** Range of the name. */
    readonly selection: Range;
    /** Range of the text in the model the location was requested for. */
    readonly origin: Range;
}

/** What a position in a model refers to in the imported headers. */
export interface CppElementAt {
    /** The declaration (namespace, enum, enumerator, struct, field, alias, constant). */
    readonly declaration?: CppDeclaration;
    /** The resolved struct member (for member accesses). */
    readonly field?: CppResolvedField;
    readonly index: CppTypeIndex;
    /** The text range of the name at the position. */
    readonly origin: Range;
}

function toRange(range: CppRange): Range {
    return { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } };
}

/** The C++ declaration (or struct member) at an offset of a model or test document. */
export function cppElementAt(document: LangiumDocument, offset: number): CppElementAt | undefined {
    const root = document.parseResult.value.$cstNode;
    const leaf = root ? CstUtils.findLeafNodeAtOffset(root, offset) : undefined;
    const node = leaf?.astNode;
    if (!leaf || !node) {
        return undefined;
    }
    if (ast.isTypeReference(node) || ast.isCppReference(node)) {
        return qualifiedNameAt(node, leaf);
    }
    if (ast.isMemberAccessExpression(node) && leaf.text === node.member) {
        const member = memberOf(inferType(node.receiver), node.member);
        const type = inferType(node.receiver);
        return member.field && isStructType(type)
            ? { declaration: member.field.declaration, field: member.field, index: type.index, origin: leaf.range }
            : undefined;
    }
    if (ast.isElementReference(node)) {
        return referenceMemberAt(node, leaf);
    }
    return undefined;
}

/** The part of a qualified C++ name up to the segment at the leaf: `motor` in `motor::Mode`, `motor::Mode` at `Mode`. */
function qualifiedNameAt(node: ast.TypeReference | ast.CppReference, leaf: CstNode): CppElementAt | undefined {
    const cst = node.$cstNode;
    if (!cst || !/^\w+$/.test(leaf.text)) {
        return undefined;
    }
    const prefix = cst.text.slice(0, leaf.end - cst.offset).replace(/\s+/g, '');
    if (ast.isTypeReference(node) && prefix.includes('.')) {
        return undefined;
    }
    const index = cppIndexAt(node);
    if (ast.isTypeReference(node) && !prefix.includes('::') && !cppTypeOfReference(node)) {
        return undefined;
    }
    const declaration = index.lookup(prefix);
    return declaration ? { declaration, index, origin: leaf.range } : undefined;
}

/** A struct member in the name of an element reference (`pos.x`). */
function referenceMemberAt(node: ast.ElementReference, leaf: CstNode): CppElementAt | undefined {
    const members = referenceMembers(node);
    const cst = node.element.$refNode;
    const variable = node.element.ref;
    if (members.length === 0 || !cst || !ast.isVariableDeclaration(variable)) {
        return undefined;
    }
    const segments = cst.text.slice(0, leaf.end - cst.offset).replace(/\s+/g, '').split('.');
    const total = node.element.$refText.replace(/\s+/g, '').split('.').length;
    const position = segments.length - 1 - (total - members.length);
    if (position < 0) {
        return undefined;
    }
    let type: HsmType = typeOfDeclaration(variable);
    for (let i = 0; i <= position; i++) {
        const member = memberOf(type, members[i]);
        if (member.error || !isStructType(type)) {
            return undefined;
        }
        if (i === position) {
            return { declaration: member.field!.declaration, field: member.field, index: type.index, origin: leaf.range };
        }
        type = member.type!;
    }
    return undefined;
}

/** Markdown hover of the C++ element at an offset (`undefined` if there is none). */
export function cppHover(document: LangiumDocument, offset: number): string | undefined {
    const element = cppElementAt(document, offset);
    if (element) {
        return describeCppElement(element, document);
    }
    const root = document.parseResult.value.$cstNode;
    const node = root ? CstUtils.findLeafNodeAtOffset(root, offset)?.astNode : undefined;
    if (ast.isImportPath(node)) {
        return headerImportHover(node);
    }
    return undefined;
}

/** Hover of an import path of a header: the location and the number of declarations. */
function headerImportHover(node: ast.ImportPath): string | undefined {
    const machine = AstUtils.getContainerOfType(node, ast.isStateMachine);
    const resolved = machine ? resolvedImports(machine).find(i => i.node === node) : undefined;
    if (!resolved?.header?.found || !resolved.uri) {
        return undefined;
    }
    const base = machine?.$document ? machine.$document.uri : undefined;
    const files = resolved.header.headers.map(h => `\`${displayPath(h.uri.toString(), base ? parentOf(base) : undefined)}\``);
    const namespaces = new Set<string>();
    for (const header of resolved.header.headers) {
        for (const declaration of header.header.declarations) {
            if (declaration.kind === 'namespace' && declaration.name) {
                namespaces.add(declaration.name);
            }
        }
    }
    return [
        `C/C++ header ${files[0]}`,
        files.length > 1 ? `includes ${files.slice(1).join(', ')}` : undefined,
        namespaces.size > 0 ? `namespaces: ${[...namespaces].map(n => `\`${n}\``).join(', ')}` : undefined
    ].filter(line => line).join('\n\n');
}

function parentOf(uri: LangiumDocument['uri']): LangiumDocument['uri'] {
    return uri.with({ path: uri.path.replace(/\/[^/]*$/, '') || '/' });
}

/** Markdown description of a C++ declaration: signature, resolved type / value and documentation. */
export function describeCppElement(element: CppElementAt, document?: LangiumDocument): string {
    const { declaration, index } = element;
    const lines: string[] = [];
    let signature: string;
    if (element.field) {
        const field = element.field;
        signature = `${field.type.cppName} ${field.declaration.qualifiedName}${field.defaultValue !== undefined ? ` = ${formatCppValue(field.defaultValue)}` : ''}`;
        lines.push(`member of type ${describeCppType(field.type)}`);
    } else if (declaration) {
        switch (declaration.kind) {
            case 'namespace':
                signature = `namespace ${declaration.qualifiedName}`;
                break;
            case 'enum': {
                const type = index.typeOf(declaration);
                const underlying = type.kind === 'enum' && (declaration.underlyingType || declaration.opaque) ? ` : ${type.underlying.cppName}` : '';
                signature = `enum ${declaration.scoped ? 'class ' : ''}${declaration.qualifiedName}${underlying}${declaration.opaque ? ';' : ''}`;
                if (type.kind === 'enum') {
                    lines.push(declaration.opaque
                        ? 'opaque declaration: no enumerators are known (values are written `n as ' + declaration.qualifiedName + '`)'
                        : type.enumerators.map(e => `- ${enumeratorListItem(e, type)}`).join('\n'));
                    if (!declaration.scoped) {
                        lines.push(`unscoped: the enumerators are also members of ${declaration.qualifiedName.includes('::') ? `\`${declaration.qualifiedName.slice(0, declaration.qualifiedName.lastIndexOf('::'))}\`` : 'the global namespace'} and convert to \`integer\``);
                    }
                }
                break;
            }
            case 'enumerator': {
                const info = index.constant(declaration);
                const type = info?.type.kind === 'enum' ? info.type : undefined;
                const enumerator = type?.enumerators.find(e => e.declaration === declaration);
                signature = declaration.qualifiedName;
                if (type && enumerator) {
                    // the computed value (unknown values are not shown in the signature)
                    signature += enumerator.valid ? ` = ${enumerator.value}` : '';
                    lines.push(enumeratorValueMarkdown(enumerator, type));
                    lines.push(`enumerator of \`enum ${type.scoped ? 'class ' : ''}${type.cppName}\` (underlying type \`${type.underlying.cppName}\`)`);
                }
                break;
            }
            case 'record': {
                const type = index.typeOf(declaration);
                signature = `struct ${declaration.qualifiedName}`;
                if (type.kind === 'struct') {
                    lines.push(type.fields.map(f => `\`${f.name} : ${f.type.cppName}\``).join(', '));
                } else if (type.kind === 'unsupported') {
                    lines.push(`not supported: ${type.reason}`);
                }
                break;
            }
            case 'alias': {
                const type = index.typeOf(declaration);
                signature = `using ${declaration.qualifiedName} = ${type.cppName}`;
                lines.push(describeCppType(type));
                break;
            }
            case 'constant': {
                const info = index.constant(declaration);
                signature = `constexpr ${info?.type.cppName ?? '?'} ${declaration.qualifiedName}${info?.value !== undefined ? ` = ${formatCppValue(info.value)}` : ''}`;
                if (info?.error) {
                    lines.push(`value unknown: ${info.error}`);
                }
                break;
            }
            default:
                signature = declaration.qualifiedName;
        }
    } else {
        return '';
    }
    const location = declaration ? `${displayPath(declaration.fileName, document ? parentOf(document.uri) : undefined)}:${declaration.nameRange.start.line + 1}` : undefined;
    const doc = declaration?.doc;
    return ['```cpp\n' + signature + '\n```', ...lines, doc, location ? `*${location}*` : undefined].filter(part => part).join('\n\n');
}

/** A constant value in JSON notation; integers (also beyond 2^53) as plain numbers, e.g. `18446744073709551615`. */
function formatCppValue(value: unknown): string {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (Array.isArray(value)) {
        return `[${value.map(formatCppValue).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}:${formatCppValue(v)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/** The location of the C++ declaration at an offset (go to definition into the header). */
export function cppDefinition(document: LangiumDocument, offset: number): CppLocation | undefined {
    const element = cppElementAt(document, offset);
    const declaration = element?.declaration;
    if (!element || !declaration) {
        const root = document.parseResult.value.$cstNode;
        const leaf = root ? CstUtils.findLeafNodeAtOffset(root, offset) : undefined;
        if (ast.isImportPath(leaf?.astNode)) {
            const machine = AstUtils.getContainerOfType(leaf.astNode, ast.isStateMachine);
            const resolved = machine ? resolvedImports(machine).find(i => i.node === leaf.astNode) : undefined;
            if (resolved?.kind === 'header' && resolved.header?.found && resolved.uri) {
                const start = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
                return { uri: resolved.uri.toString(), range: start, selection: start, origin: leaf.range };
            }
        }
        return undefined;
    }
    return { uri: declaration.fileName, range: toRange(declaration.range), selection: toRange(declaration.nameRange), origin: element.origin };
}

// ---------------------------------------------------------------------------------------------
// Completion

/**
 * Completion items for C++ names after `ns::` (members of the namespace, class or enum) and for the
 * members of struct values after `.` (`pos.`, `valueof(e).`); `undefined` if the text before the
 * cursor is neither.
 */
export function cppCompletionItems(document: LangiumDocument, offset: number): CompletionItem[] | undefined {
    const text = document.textDocument.getText();
    const before = text.slice(Math.max(0, offset - 300), offset);
    const machine = machineAt(document, offset);
    const index = cppImports(machine).index;
    const scoped = /(::)?((?:[A-Za-z_]\w*\s*::\s*)+)(\w*)$/.exec(before);
    if (scoped) {
        const scope = scoped[2].replace(/\s+/g, '').replace(/::$/, '');
        const typePosition = isTypePosition(before.slice(0, scoped.index));
        return sortedMembers(index, scope, typePosition).map(d => cppCompletionItem(d, index));
    }
    const global = /(^|[^:\w])::(\w*)$/.exec(before);
    if (global) {
        const typePosition = isTypePosition(before.slice(0, global.index + global[1].length));
        return sortedMembers(index, '', typePosition).map(d => cppCompletionItem(d, index));
    }
    const member = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\.\s*(\w*)$/.exec(before);
    if (member && machine) {
        const type = pathType(machine, member[1].replace(/\s+/g, '').split('.'));
        if (isStructType(type)) {
            return type.resolved.fields.map(field => ({
                label: field.name,
                kind: CompletionItemKind.Field,
                detail: `${field.type.cppName} (${typeName(type)})`,
                documentation: field.declaration.doc
            }));
        }
    }
    return undefined;
}

/** The state machine whose names are visible at an offset (test documents: the tested machine of the test class). */
function machineAt(document: LangiumDocument, offset: number): ast.StateMachine | undefined {
    const root = document.parseResult.value;
    if (ast.isStateMachine(root)) {
        return root;
    }
    const cst = root.$cstNode;
    const leaf = cst ? CstUtils.findLeafNodeAtOffset(cst, offset) : undefined;
    return contextMachine(leaf?.astNode ?? (ast.isTestModel(root) ? root.testClasses[0] : undefined));
}

/** The type of a variable followed by members (`pos`, `cfg.timing`), `undefined` if it is not known. */
function pathType(machine: ast.StateMachine, path: string[]): HsmType | undefined {
    for (let length = path.length; length >= 1; length--) {
        const name = path.slice(0, length).join('.');
        const variable = machine.scopes.flatMap(s => s.declarations.map(d => ({ d, name: ast.isInterfaceScope(s) && s.name ? `${s.name}.${d.name}` : d.name })))
            .find(entry => entry.name === name && ast.isVariableDeclaration(entry.d))?.d;
        if (variable) {
            let type: HsmType = typeOfDeclaration(variable);
            for (const member of path.slice(length)) {
                const resolved = memberOf(type, member);
                if (resolved.error) {
                    return undefined;
                }
                type = resolved.type!;
            }
            return type;
        }
    }
    return undefined;
}

/** Declarations that can be written in a type (`ns::Type`) or are qualifiers of types. */
function isTypeOrScope(declaration: CppDeclaration): boolean {
    return declaration.kind === 'namespace' || declaration.kind === 'namespaceAlias' || declaration.kind === 'enum'
        || declaration.kind === 'record' || (declaration.kind === 'alias' && declaration.syntax !== 'usingDeclaration');
}

/** Declarations that can be used in expressions: values and the scopes containing values. */
function isValueOrScope(declaration: CppDeclaration, index: CppTypeIndex): boolean {
    switch (declaration.kind) {
        case 'enumerator': case 'constant': case 'namespace': case 'namespaceAlias': case 'enum': case 'record':
            return true;
        case 'alias': {
            const type = index.typeOf(declaration);
            return type.kind === 'enum' || type.kind === 'struct' || declaration.syntax === 'usingDeclaration';
        }
        default:
            return false;
    }
}

/**
 * The named members of a namespace / class / enum for completion: in type positions the types and
 * scopes, in expressions the values and scopes. Enumerators come in the order of their values.
 */
function sortedMembers(index: CppTypeIndex, scope: string, typePosition: boolean): CppDeclaration[] {
    return index.members(scope)
        .filter(d => d.name && d.kind !== 'usingDirective' && (typePosition ? isTypeOrScope(d) : isValueOrScope(d, index)));
}

/**
 * Whether the text before a name is followed by a type: the type of an event, variable, parameter,
 * operation or type alias declaration, or the target type of a cast (`x as `).
 */
export function isTypePosition(before: string): boolean {
    return /\b(?:event|var|const|readonly)\s+[A-Za-z_]\w*\s*:\s*$/.test(before)
        || /\balias\s+[A-Za-z_]\w*\s*:\s*$/.test(before)
        || /\bas\s+$/.test(before)
        || /\boperation\s+[A-Za-z_]\w*\s*\([^()]*(?:[A-Za-z_]\w*\s*(?:\.\.\.)?\s*:\s*|\)\s*:\s*)$/.test(before);
}

function cppCompletionItem(declaration: CppDeclaration, index: CppTypeIndex): CompletionItem {
    const kinds: Partial<Record<CppDeclaration['kind'], CompletionItemKind>> = {
        namespace: CompletionItemKind.Module, namespaceAlias: CompletionItemKind.Module, enum: CompletionItemKind.Enum,
        enumerator: CompletionItemKind.EnumMember, record: CompletionItemKind.Struct, alias: CompletionItemKind.TypeParameter,
        constant: CompletionItemKind.Constant, field: CompletionItemKind.Field
    };
    let detail: string | undefined;
    let sortText: string | undefined;
    if (declaration.kind === 'constant' || declaration.kind === 'enumerator') {
        const info = index.constant(declaration);
        detail = info ? `${info.type.cppName}${info.value !== undefined ? ` = ${formatCppValue(info.value)}` : ''}` : undefined;
        if (declaration.kind === 'enumerator' && info?.type.kind === 'enum') {
            // enumerators in declaration order, with their computed values
            const enumType = info.type;
            const position = enumType.enumerators.findIndex(e => e.declaration === declaration);
            const enumerator = enumType.enumerators[position];
            if (enumerator) {
                return {
                    label: declaration.name, kind: CompletionItemKind.EnumMember, sortText: `0${String(position).padStart(5, '0')}`,
                    ...enumeratorCompletionDetails(enumerator, enumType)
                };
            }
        }
    } else if (declaration.kind === 'alias') {
        detail = index.typeOf(declaration).cppName;
    } else if (declaration.kind === 'enum') {
        const type = index.typeOf(declaration);
        detail = `enum ${declaration.scoped ? 'class ' : ''}: ${type.kind === 'enum' ? type.underlying.cppName : '?'}${declaration.opaque ? ' (opaque)' : ''}`;
    } else {
        detail = declaration.kind === 'record' ? 'struct' : declaration.kind;
    }
    return { label: declaration.name, kind: kinds[declaration.kind] ?? CompletionItemKind.Text, detail, documentation: declaration.doc, ...(sortText ? { sortText } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Context sensitive completion: enumerators where an enum value is expected, C++ types in type positions

/**
 * The type of the value expected at the end of `before`: the left operand of a comparison or
 * assignment (`mode == `, `cfg.mode = `, `valueof(e) != `), the type of a variable with initial value
 * (`var m : motor::Mode = `), the value of a raised event (`raise e : `), an argument of an operation
 * call (`drive(1, `) or the return value of a mocked operation (`mock op returns (`).
 */
export function expectedTypeAt(machine: ast.StateMachine, before: string): HsmType | undefined {
    const index = cppImports(machine).index;
    const name = '[A-Za-z_]\\w*(?:\\s*\\.\\s*[A-Za-z_]\\w*)*';
    const path = (text: string) => text.replace(/\s+/g, '').split('.');
    let match = new RegExp(`\\b(?:var|const)\\s+[A-Za-z_]\\w*\\s*:\\s*((?:::)?[A-Za-z_][\\w:.\\t ]*?)\\s*=\\s*$`).exec(before);
    if (match) {
        const typeText = match[1].replace(/\s+/g, '');
        const alias = typeAliases(machine).get(typeText);
        if (alias) {
            return typeOfAlias(alias);
        }
        const resolved = typeText.includes('.') ? undefined : index.resolveType(typeText);
        return resolved ? hsmTypeOfCpp(resolved, index).type : undefined;
    }
    match = new RegExp(`\\bvalueof\\s*\\(\\s*(${name})\\s*\\)\\s*(?:==|!=|<=|>=|<|>)\\s*$`).exec(before);
    if (match) {
        const event = findDeclaration(machine, path(match[1]), ast.isEventDeclaration);
        return event ? typeOfEvent(event) : undefined;
    }
    match = new RegExp(`\\braise\\s+(${name})\\s*:\\s*$`).exec(before);
    if (match) {
        const event = findDeclaration(machine, path(match[1]), ast.isEventDeclaration);
        return event ? typeOfEvent(event) : undefined;
    }
    match = new RegExp(`\\bmock\\s+(${name})\\s+returns\\s*\\(([^()]*)$`).exec(before);
    if (match) {
        const operation = findDeclaration(machine, path(match[1]), ast.isOperationDeclaration);
        return operation ? returnTypeOf(operation) : undefined;
    }
    match = new RegExp(`(?:^|[^\\w.])(${name})\\s*\\(([^()]*)$`).exec(before);
    const operation = match ? findDeclaration(machine, path(match[1]), ast.isOperationDeclaration) : undefined;
    if (match && operation) {
        const position = match[2].split(',').length - 1;
        const parameter = operation.parameters[Math.min(position, operation.parameters.length - 1)];
        return parameter && (position < operation.parameters.length || parameter.varArgs) ? typeOfParameter(parameter) : undefined;
    }
    match = new RegExp(`(?:^|[^\\w.:])(${name})\\s*(?:==|!=|<=|>=|<|>|(?<![=!<>+\\-*/%&|^])=)\\s*$`).exec(before);
    if (match) {
        return pathType(machine, path(match[1]));
    }
    return undefined;
}

/** A declaration of the interface / internal scopes of a machine by its (`Iface.`-qualified) name. */
function findDeclaration<T extends ast.Declaration>(machine: ast.StateMachine, path: string[], is: (d: unknown) => d is T): T | undefined {
    const name = path.join('.');
    for (const scope of machine.scopes) {
        for (const declaration of scope.declarations) {
            const qualified = ast.isInterfaceScope(scope) && scope.name ? `${scope.name}.${declaration.name}` : declaration.name;
            if (qualified === name && is(declaration)) {
                return declaration;
            }
        }
    }
    return undefined;
}

/**
 * The documentation of an enumerator in completion items: its computed value (see
 * {@link enumeratorValueMarkdown}) and the doc comment of the header. Kept in one place so that the
 * doc comment can be rendered like the other documentation comments (e.g. Doxygen to Markdown).
 */
function enumeratorDocumentation(enumerator: CppResolvedEnumerator, type: CppEnumType): MarkupContent {
    const doc = enumerator.declaration.doc;
    return { kind: MarkupKind.Markdown, value: [enumeratorValueMarkdown(enumerator, type), doc].filter(part => part).join('\n\n') };
}

/**
 * Detail, label description (shown next to the label) and documentation of the completion item of an
 * enumerator: `motor::Mode = 3 (0x3)`, `= 3 (0x3)`, the value with its derivation and the doc comment.
 */
function enumeratorCompletionDetails(enumerator: CppResolvedEnumerator, type: CppEnumType): Pick<CompletionItem, 'detail' | 'labelDetails' | 'documentation'> {
    const value = enumeratorValueText(enumerator, type);
    const text = enumerator.valid ? `= ${value}` : `value ${value}`;
    return { detail: `${type.cppName} ${text}`, labelDetails: { description: text }, documentation: enumeratorDocumentation(enumerator, type) };
}

/**
 * Completion items of the enumerators of an enum type, written as in models (`motor::Mode::Fast`,
 * `::RED`), replacing `range`.
 */
export function enumeratorCompletionItems(type: HsmType, range: Range, typed: string): CompletionItem[] {
    if (!isEnumType(type)) {
        return [];
    }
    const enumType = type.resolved;
    return enumType.enumerators.map((enumerator, position) => {
        const spelling = enumeratorSpelling(enumType, enumerator, type.index);
        return {
            label: spelling,
            kind: CompletionItemKind.EnumMember,
            ...enumeratorCompletionDetails(enumerator, enumType),
            sortText: `!${String(position).padStart(5, '0')}`,
            filterText: typed && !spelling.startsWith(typed) ? enumerator.name : spelling,
            textEdit: { range, newText: spelling }
        };
    });
}

/**
 * Completion items of the C++ types and namespaces of the global namespace for a type position
 * (`var mode : `), with the `<cstdint>` typedefs.
 */
function typeCompletionItems(index: CppTypeIndex): CompletionItem[] {
    const items = sortedMembers(index, '', true).map(d => cppCompletionItem(d, index));
    for (const name of CSTDINT_TYPES) {
        items.push({ label: name, kind: CompletionItemKind.TypeParameter, detail: '<cstdint>', sortText: `~${name}` });
    }
    return items;
}

const CSTDINT_TYPES = ['int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'size_t'];

/**
 * Context sensitive completion items that are added to the default completion: the enumerators of
 * the expected enum type in expressions (`mode == `, `raise setMode : `, `drive(`) and the C++
 * types of the global namespace in type positions (`var mode : `).
 */
export function cppContextCompletionItems(document: LangiumDocument, offset: number): CompletionItem[] {
    const text = document.textDocument.getText();
    const before = text.slice(Math.max(0, offset - 300), offset);
    const machine = machineAt(document, offset);
    if (!machine) {
        return [];
    }
    const partial = /(?:::)?\w*$/.exec(before)![0];
    const prefix = before.slice(0, before.length - partial.length);
    if (isTypePosition(prefix) && !partial.startsWith('::')) {
        return typeCompletionItems(cppImports(machine).index);
    }
    const expected = expectedTypeAt(machine, prefix);
    if (!expected) {
        return [];
    }
    const end = document.textDocument.positionAt(offset);
    const range = { start: document.textDocument.positionAt(offset - partial.length), end };
    return enumeratorCompletionItems(expected, range, partial);
}

/**
 * Completion of both languages: C++ names after `ns::` and struct members after `.` (see
 * {@link cppCompletionItems}), otherwise the default completion of Langium (for `.`, the members of
 * submachine instances and named interfaces are added).
 */
export class HsmCompletionProvider extends DefaultCompletionProvider {

    constructor(services: LangiumServices) {
        super(services);
    }

    override readonly completionOptions = { triggerCharacters: ['.', ':'] };

    override async getCompletion(document: LangiumDocument, params: CompletionParams): Promise<CompletionList | undefined> {
        const offset = document.textDocument.offsetAt(params.position);
        const cpp = cppCompletionItems(document, offset);
        if (cpp && cpp.length > 0) {
            return { isIncomplete: false, items: cpp };
        }
        const context = cppContextCompletionItems(document, offset);
        const list = await super.getCompletion(document, params);
        if (context.length === 0) {
            return list;
        }
        const labels = new Set(context.map(item => item.label));
        return { isIncomplete: true, items: [...context, ...(list?.items ?? []).filter(item => !labels.has(item.label))] };
    }
}
