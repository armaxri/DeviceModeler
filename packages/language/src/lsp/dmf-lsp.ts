import {
    AstUtils, CstUtils, GrammarAST, GrammarUtils, JSDocDocumentationProvider,
    type AstNode, type AstNodeDescription, type CstNode, type LangiumDocument, type MaybePromise, type ReferenceInfo, type Stream
} from 'langium';
import {
    DefaultCompletionProvider, DefaultDefinitionProvider,
    type CompletionAcceptor, type CompletionContext, type ImplementationProvider, type LangiumServices, type NextFeature
} from 'langium/lsp';
import { CompletionItemKind, LocationLink, type Range } from 'vscode-languageserver-types';

type DefinitionParams = Parameters<DefaultDefinitionProvider['getDefinition']>[1];
type ImplementationParams = Parameters<ImplementationProvider['getImplementation']>[1];
import * as ast from '../generated/ast.js';
import type { CppRange } from '../cpp-header/model.js';
import { resolvedBehavior, resolvedDmfImports, visibleElements } from '../dmf-imports.js';
import { instanceType, threadOf, threadSettings } from '../dmf-model.js';
import { providersOf, type PortEndpoint } from '../dmf-routes.js';
import { portTypeLabel, resolveDataType } from '../dmf-types.js';
import { BUILTIN_TYPES } from '../hsm-typesystem.js';

/**
 * Language server features of the structure language (`.dmf`): go to definition (also for type names,
 * import paths and the behavior file), go to implementation ("go to provider" of required ports, see
 * dmf-routes.ts), hover (signature and documentation comment) and completion of type names.
 */

/** The leaf CST node and its AST node at an offset. */
function leafAt(document: LangiumDocument, offset: number): CstNode | undefined {
    const root = document.parseResult.value.$cstNode;
    return root ? CstUtils.findLeafNodeAtOffset(root, offset) : undefined;
}

function toRange(range: CppRange): Range {
    return { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } };
}

/** A location link to the name of a model element. */
function nodeLink(target: AstNode | undefined, origin: CstNode): LocationLink | undefined {
    const cst = target?.$cstNode;
    const document = target ? AstUtils.findRootNode(target).$document : undefined;
    if (!cst || !document) {
        return undefined;
    }
    const name = GrammarUtils.findNodeForProperty(cst, 'name') ?? cst;
    return LocationLink.create(document.textDocument.uri, cst.range, name.range, origin.range);
}

const FILE_START: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

/**
 * Go to definition: the default (cross-references: component types, instances, ports, `behavior Door`),
 * and for type names the struct or interface (or the declaration in a C++ header), for import paths
 * and `behavior "door.hsm"` the file.
 */
export class DmfDefinitionProvider extends DefaultDefinitionProvider {

    override getDefinition(document: LangiumDocument, params: DefinitionParams): MaybePromise<LocationLink[] | undefined> {
        const leaf = leafAt(document, document.textDocument.offsetAt(params.position));
        const node = leaf?.astNode;
        if (leaf && ast.isDataTypeReference(node)) {
            const resolution = resolveDataType(node);
            if (resolution.kind === 'interface') {
                const link = nodeLink(resolution.interface, leaf);
                return link ? [link] : undefined;
            }
            if (resolution.kind === 'data' && resolution.struct) {
                const link = nodeLink(resolution.struct, leaf);
                return link ? [link] : undefined;
            }
            const cpp = resolution.kind === 'data' ? resolution.cpp : undefined;
            return cpp ? [LocationLink.create(cpp.fileName, toRange(cpp.range), toRange(cpp.nameRange), leaf.range)] : undefined;
        }
        if (leaf && ast.isDmfImportPath(node)) {
            const model = AstUtils.getContainerOfType(node, ast.isDmfModel);
            const resolved = model ? resolvedDmfImports(model).find(i => i.node === node) : undefined;
            const target = resolved?.model ?? resolved?.machine;
            const link = target ? fileLink(target, leaf) : undefined;
            if (link) {
                return [link];
            }
            if (resolved?.kind === 'header' && resolved.header?.found && resolved.uri) {
                return [LocationLink.create(resolved.uri.toString(), FILE_START, FILE_START, leaf.range)];
            }
            return undefined;
        }
        if (leaf && ast.isBehavior(node) && node.path !== undefined) {
            const link = nodeLink(resolvedBehavior(node).machine, leaf);
            return link ? [link] : undefined;
        }
        return super.getDefinition(document, params);
    }
}

/** A link to the root of a file (state machine: its name). */
function fileLink(target: ast.DmfModel | ast.StateMachine, origin: CstNode): LocationLink | undefined {
    if (ast.isStateMachine(target)) {
        return nodeLink(target, origin);
    }
    const document = target.$document;
    return document ? LocationLink.create(document.textDocument.uri, FILE_START, FILE_START, origin.range) : undefined;
}

/**
 * Go to implementation = "go to provider": on a port reference (`door.motor` in a connection), an
 * instance or a port, the instances (or boundary ports) providing the required ports, across
 * connections and delegations of all levels below the enclosing structure (see `providersOf` in dmf-routes.ts).
 */
export class DmfImplementationProvider implements ImplementationProvider {

    getImplementation(document: LangiumDocument, params: ImplementationParams): MaybePromise<LocationLink[] | undefined> {
        const leaf = leafAt(document, document.textDocument.offsetAt(params.position));
        const node = leaf?.astNode;
        if (!leaf || !node) {
            return undefined;
        }
        const element = ast.isPortReference(node) || ast.isComponentInstance(node) || ast.isPort(node) || ast.isThreadMember(node) ? node : undefined;
        if (!element) {
            return undefined;
        }
        const links = providersOf(element).map(provider => nodeLink(providerNode(provider), leaf)).filter((l): l is LocationLink => l !== undefined);
        return links.length > 0 ? links : undefined;
    }
}

/** The element a provider is shown at: the instance providing the port, or the boundary port (provided by the environment). */
function providerNode(provider: PortEndpoint): AstNode {
    return provider.instance ?? provider.port;
}

/** Hover documentation: a signature line and the documentation comment of structure elements. */
export class DmfDocumentationProvider extends JSDocDocumentationProvider {

    override getDocumentation(node: AstNode): string | undefined {
        const parts: string[] = [];
        const signature = dmfSignature(node);
        if (signature) {
            parts.push('```dmf\n' + signature + '\n```');
        }
        const description = (node as { description?: string }).description;
        if (description) {
            parts.push(description);
        }
        const comment = super.getDocumentation(node);
        if (comment) {
            parts.push(comment);
        }
        return parts.length > 0 ? parts.join('\n\n') : undefined;
    }
}

/** A one-line signature of a structure element, e.g. `requires async motor : event start : integer`. */
export function dmfSignature(node: AstNode): string | undefined {
    if (ast.isPort(node)) {
        return `${node.direction} ${node.kind} ${node.name} : ${portTypeLabel(node)}`;
    }
    if (ast.isComponent(node)) {
        const behavior = node.behavior ? ` (behavior ${node.behavior.path !== undefined ? `"${node.behavior.path}"` : node.behavior.machine?.$refText})` : '';
        return `component ${node.name}${behavior}`;
    }
    if (ast.isStructure(node)) {
        return `${node.kind} ${node.name}`;
    }
    if (ast.isComponentInstance(node)) {
        const type = instanceType(node);
        const thread = threadOf(node);
        return `${node.name} : ${type ? `${ast.isStructure(type) ? type.kind : 'component'} ${type.name}` : node.type?.$refText}${thread ? ` (thread ${thread.name})` : ''}`;
    }
    if (ast.isThread(node)) {
        const settings = threadSettings(node);
        const details = [
            settings.priority !== undefined ? `priority ${settings.priority}` : undefined,
            settings.period ? `period ${settings.period}` : undefined,
            settings.stack !== undefined ? `stack ${settings.stack}` : undefined
        ].filter(d => d);
        return `thread ${node.name}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
    }
    if (ast.isStructDeclaration(node)) {
        return `struct ${node.name} { ${node.fields.map(f => `${f.name} : ${f.type?.name ?? '?'}`).join(', ')} }`;
    }
    if (ast.isPortInterface(node)) {
        return `interface ${node.name} { ${node.events.map(e => `event ${e.name}${e.type ? ` : ${e.type.name}` : ''}`).join(', ')} }`;
    }
    if (ast.isPortEvent(node)) {
        return `event ${node.name}${node.type ? ` : ${node.type.name}` : ''}`;
    }
    return undefined;
}

/**
 * Completion: the default completion, and for type names the built-in types, structs and interfaces.
 * The type of an instance in a thread is a component, outside of the threads a subsystem (see
 * docs/structure-language.md#threads); threads are assigned instances of components only.
 */
export class DmfCompletionProvider extends DefaultCompletionProvider {

    constructor(services: LangiumServices) {
        super(services);
    }

    override readonly completionOptions = { triggerCharacters: ['.', ':'] };

    protected override completionFor(context: CompletionContext, next: NextFeature, acceptor: CompletionAcceptor): MaybePromise<void> {
        const rule = AstUtils.getContainerOfType(next.feature, GrammarAST.isParserRule);
        if (rule?.name === 'DataTypeReference' || rule?.name === 'TypeReferenceName') {
            const model = context.node ? AstUtils.getContainerOfType(context.node, ast.isDmfModel) : undefined;
            for (const name of BUILTIN_TYPES.filter(t => t !== 'void')) {
                acceptor(context, { label: name, kind: CompletionItemKind.Keyword, detail: 'built-in type' });
            }
            for (const [name, element] of model ? visibleElements(model) : []) {
                if (ast.isStructDeclaration(element) || ast.isPortInterface(element)) {
                    acceptor(context, {
                        label: name, kind: ast.isStructDeclaration(element) ? CompletionItemKind.Struct : CompletionItemKind.Interface,
                        detail: dmfSignature(element)
                    });
                }
            }
            return;
        }
        return super.completionFor(context, next, acceptor);
    }

    protected override getReferenceCandidates(refInfo: ReferenceInfo, context: CompletionContext): Stream<AstNodeDescription> {
        const candidates = super.getReferenceCandidates(refInfo, context);
        const container = refInfo.container;
        if (refInfo.property === 'type' && ast.isComponentInstance(container)) {
            const inThread = ast.isThread(container.$container);
            return candidates.filter(d => inThread
                ? d.type === ast.Component.$type
                : d.type === ast.Structure.$type && !(ast.isStructure(d.node) && d.node.kind === 'system'));
        }
        if (refInfo.property === 'instance' && ast.isThreadMember(container)) {
            return candidates.filter(d => !ast.isComponentInstance(d.node) || !ast.isStructure(instanceType(d.node)));
        }
        return candidates;
    }
}
