import { AstUtils, CstUtils, GrammarAST, GrammarUtils, type CstNode, type LangiumDocument, type MaybePromise } from 'langium';
import { DefaultCompletionProvider, DefaultDefinitionProvider, type CompletionContext, type LangiumServices } from 'langium/lsp';
import { CompletionItemKind, LocationLink, type CompletionItem, type CompletionList, type Range } from 'vscode-languageserver-types';

type CompletionParams = Parameters<DefaultCompletionProvider['getCompletion']>[1];
type DefinitionParams = Parameters<DefaultDefinitionProvider['getDefinition']>[1];
import * as ast from '../generated/ast.js';
import type { CppDeclaration, CppRange, CppResolvedField } from '../cpp-header/model.js';
import type { CppTypeIndex } from '../cpp-header/type-index.js';
import { cppValueToJson, describeCppType } from '../cpp-header/report.js';
import { displayPath } from '../cpp-headers.js';
import { contextMachine, cppIndexAt, cppTypeOfReference, isStructType, memberOf, referenceMembers } from '../cpp-types.js';
import { cppImports, machineType, resolvedImports } from '../imports.js';
import { inferType, typeName, typeOfDeclaration, type HsmType } from '../hsm-typesystem.js';

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
                signature = `enum ${declaration.scoped ? 'class ' : ''}${declaration.qualifiedName}`;
                if (type.kind === 'enum') {
                    lines.push(type.enumerators.map(e => `\`${e.name} = ${e.value}\``).join(', '));
                }
                break;
            }
            case 'enumerator': {
                const info = index.constant(declaration);
                signature = `${declaration.qualifiedName}${info?.value !== undefined ? ` = ${formatCppValue(info.value)}` : ''}`;
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

function formatCppValue(value: unknown): string {
    return JSON.stringify(cppValueToJson(value as never));
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
        return index.members(scope).filter(d => d.name && d.kind !== 'usingDirective').map(d => cppCompletionItem(d, index));
    }
    if (/(^|[^:\w])::(\w*)$/.test(before)) {
        return index.members('').filter(d => d.name && d.kind !== 'usingDirective').map(d => cppCompletionItem(d, index));
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

function cppCompletionItem(declaration: CppDeclaration, index: CppTypeIndex): CompletionItem {
    const kinds: Partial<Record<CppDeclaration['kind'], CompletionItemKind>> = {
        namespace: CompletionItemKind.Module, namespaceAlias: CompletionItemKind.Module, enum: CompletionItemKind.Enum,
        enumerator: CompletionItemKind.EnumMember, record: CompletionItemKind.Struct, alias: CompletionItemKind.TypeParameter,
        constant: CompletionItemKind.Constant, field: CompletionItemKind.Field
    };
    let detail: string | undefined;
    if (declaration.kind === 'constant' || declaration.kind === 'enumerator') {
        const info = index.constant(declaration);
        detail = info ? `${info.type.cppName}${info.value !== undefined ? ` = ${formatCppValue(info.value)}` : ''}` : undefined;
    } else if (declaration.kind === 'alias') {
        detail = index.typeOf(declaration).cppName;
    } else {
        detail = declaration.kind === 'record' ? 'struct' : declaration.kind;
    }
    return { label: declaration.name, kind: kinds[declaration.kind] ?? CompletionItemKind.Text, detail, documentation: declaration.doc };
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
        const cpp = ast.isDmfModel(document.parseResult.value) ? undefined : cppCompletionItems(document, offset);
        if (cpp && cpp.length > 0) {
            return { isIncomplete: false, items: cpp };
        }
        return super.getCompletion(document, params);
    }

    /** The keywords of the other kind of `.devm` files, which are accepted as names, are not proposed. */
    protected override filterKeyword(context: CompletionContext, keyword: GrammarAST.Keyword): boolean {
        return !isSoftKeyword(keyword) && super.filterKeyword(context, keyword);
    }
}

/**
 * Whether a keyword of the grammar is an alternative of a name rule (`HsmId`, `DmfId`): a keyword of
 * one kind of `.devm` files accepted as a name in the other kind.
 */
export function isSoftKeyword(keyword: GrammarAST.Keyword): boolean {
    const rule = AstUtils.getContainerOfType(keyword, GrammarAST.isParserRule);
    return rule?.name === 'HsmId' || rule?.name === 'DmfId';
}

/**
 * Go to definition in state machine (and test) files: C++ names and header imports into the header,
 * the name of an imported state machine used as a type (`var motor : Motor`) and an import path
 * (`import "motor.devm"`) to the imported state machine, otherwise the default (cross-references).
 */
export class HsmDefinitionProvider extends DefaultDefinitionProvider {

    override getDefinition(document: LangiumDocument, params: DefinitionParams): MaybePromise<LocationLink[] | undefined> {
        const offset = document.textDocument.offsetAt(params.position);
        const cpp = cppDefinition(document, offset);
        if (cpp) {
            return [LocationLink.create(cpp.uri, cpp.range, cpp.selection, cpp.origin)];
        }
        const root = document.parseResult.value.$cstNode;
        const leaf = root ? CstUtils.findLeafNodeAtOffset(root, offset) : undefined;
        const node = leaf?.astNode;
        let machine: ast.StateMachine | undefined;
        if (ast.isTypeReference(node)) {
            machine = machineType(node);
        } else if (ast.isImportPath(node)) {
            const owner = AstUtils.getContainerOfType(node, ast.isStateMachine);
            machine = owner ? resolvedImports(owner).find(i => i.node === node)?.machine : undefined;
        }
        const target = machine?.$cstNode;
        const targetDocument = machine?.$document;
        if (leaf && target && targetDocument) {
            const name = GrammarUtils.findNodeForProperty(target, 'name') ?? target;
            return [LocationLink.create(targetDocument.textDocument.uri, target.range, name.range, leaf.range)];
        }
        return super.getDefinition(document, params);
    }
}
