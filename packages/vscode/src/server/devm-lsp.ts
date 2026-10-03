import { GrammarUtils, isReference, URI, type AstNode, type LangiumDocument, type MaybePromise, type Module } from 'langium';
import {
    AbstractSemanticTokenProvider, MultilineCommentHoverProvider,
    type LangiumServices, type PartialLangiumServices, type SemanticTokenAcceptor
} from 'langium/lsp';
import { SemanticTokenModifiers, SemanticTokenTypes, type Hover, type HoverParams } from 'vscode-languageserver';
import {
    cppHover, cppHeaderStore, cppTypeOfReference, createDevmServices, StateMachineDefinitionProvider, importKind, isCppReference, isEventDeclaration,
    isInterfaceScope, isOperationDeclaration, isPseudoState, isState, isStateMachine, isTypeReference, isVariableDeclaration, nodeText,
    qualifiedName, resolveCppValue, type DevmServiceExtensions
} from 'devm-language';
import type { DefaultSharedModuleContext, LangiumSharedServices } from 'langium/lsp';
// Node-only part of the language package (not exported from its index because the web app bundles the index)
import {
    headerSettingsFromSection, installNodeHeaderSupport, type HeaderConfigFinder, type HeaderSettingsSection
} from '../../../language/src/node/cpp-headers-node.js';

interface TokenKind {
    type: string;
    modifier?: string[];
}

/** Semantic token type of a declaration (or of the target of a reference). */
export function tokenKind(node: AstNode | undefined): TokenKind | undefined {
    switch (node?.$type) {
        case 'StateMachine':
        case 'TestClass':
            return { type: SemanticTokenTypes.class };
        case 'State':
            return { type: SemanticTokenTypes.type };
        case 'PseudoState':
            return { type: SemanticTokenTypes.enumMember };
        case 'EventDeclaration':
            return { type: SemanticTokenTypes.event };
        case 'VariableDeclaration':
            return isVariableDeclaration(node) && (node.const || node.readonly)
                ? { type: SemanticTokenTypes.variable, modifier: [SemanticTokenModifiers.readonly] }
                : { type: SemanticTokenTypes.variable };
        case 'OperationDeclaration':
            return { type: SemanticTokenTypes.function };
        case 'TestOperation':
            return { type: SemanticTokenTypes.method };
        case 'Parameter':
            return { type: SemanticTokenTypes.parameter };
        case 'InterfaceScope':
            return { type: SemanticTokenTypes.namespace };
        // structure files
        case 'Component':
        case 'CompositeType':
            return { type: SemanticTokenTypes.class };
        case 'StructDeclaration':
            return { type: SemanticTokenTypes.struct };
        case 'StructField':
        case 'Port':
            return { type: SemanticTokenTypes.property };
        case 'ComponentInstance':
            return { type: SemanticTokenTypes.variable };
        case 'Thread':
            return { type: SemanticTokenTypes.namespace };
        default:
            return undefined;
    }
}

/**
 * Semantic highlighting of both languages (`.devm`, `.devmtest`): names of declarations and all cross
 * references are highlighted by the kind of the element they declare / refer to (states, events,
 * variables, constants, operations, components, ports, …), which the TextMate grammar cannot know
 * (it also highlights the keywords of one kind of `.devm` files that are names in the other kind).
 */
export class DevmSemanticTokenProvider extends AbstractSemanticTokenProvider {

    protected override highlightElement(node: AstNode, acceptor: SemanticTokenAcceptor): void {
        // C++ names of imported headers: types, enumerators and constants
        if (isTypeReference(node) && node.$cstNode && cppTypeOfReference(node)) {
            acceptor({ cst: node.$cstNode, type: SemanticTokenTypes.type });
        } else if (isCppReference(node) && node.$cstNode) {
            const resolved = resolveCppValue(node);
            const enumerator = resolved.info?.declaration.kind === 'enumerator';
            acceptor({ cst: node.$cstNode, type: enumerator ? SemanticTokenTypes.enumMember : SemanticTokenTypes.variable, modifier: enumerator ? [] : [SemanticTokenModifiers.readonly] });
        }
        const own = tokenKind(node);
        if (own && node.$cstNode && GrammarUtils.findNodeForProperty(node.$cstNode, 'name')) {
            acceptor({ node, property: 'name' as never, type: own.type, modifier: [SemanticTokenModifiers.declaration, ...own.modifier ?? []] });
        }
        for (const [property, value] of Object.entries(node)) {
            if (property.startsWith('$') || !isReference(value)) {
                continue;
            }
            const target = tokenKind(value.ref);
            if (target && value.$refNode) {
                acceptor({ cst: value.$refNode, type: target.type, modifier: target.modifier });
            }
        }
    }
}

/**
 * Hover: a short signature of the declaration (e.g. `in event request : integer` or
 * `state Operating.Red`) followed by its documentation comment.
 */
export class DevmHoverProvider extends MultilineCommentHoverProvider {

    /** C++ names, struct members and header imports: the declaration of the header (see `cpp-lsp.ts`). */
    override async getHoverContent(document: LangiumDocument, params: HoverParams): Promise<Hover | undefined> {
        const cpp = cppHover(document, document.textDocument.offsetAt(params.position));
        if (cpp) {
            return { contents: { kind: 'markdown', value: cpp } };
        }
        return super.getHoverContent(document, params);
    }

    protected override getAstNodeHoverContent(node: AstNode): MaybePromise<string | undefined> {
        const signature = hoverSignature(node);
        const documentation = super.getAstNodeHoverContent(node);
        const combine = (doc: string | undefined) => [signature ? '```devm\n' + signature + '\n```' : undefined, doc].filter(part => part).join('\n\n') || undefined;
        return documentation instanceof Promise ? documentation.then(combine) : combine(documentation);
    }
}

/** The signature shown in the hover of a declaration. */
export function hoverSignature(node: AstNode): string | undefined {
    if (isState(node)) {
        return `state ${qualifiedName(node)}`;
    }
    if (isPseudoState(node)) {
        return `${node.kind} ${qualifiedName(node)}`;
    }
    if (isStateMachine(node)) {
        return `statemachine ${node.name}`;
    }
    if (isEventDeclaration(node) || isVariableDeclaration(node) || isOperationDeclaration(node)) {
        const text = nodeText(node).replace(/\s+/g, ' ');
        const scope = node.$container;
        const prefix = isInterfaceScope(scope) ? (scope.name ? `interface ${scope.name}: ` : 'interface: ') : scope?.$type === 'InternalScope' ? 'internal: ' : '';
        return prefix + text;
    }
    if (node.$type === 'TestClass' || node.$type === 'TestOperation') {
        return nodeText(node).split('\n')[0].replace(/\s*\{\s*$/, '');
    }
    return undefined;
}

/**
 * Language server features added to the `.devm` language (state machines and structure files): semantic
 * highlighting and hover. Go to definition, go to implementation, completion and formatting are the
 * services of the language package, which dispatch on the kind of the file or node (devm-module.ts there).
 */
export const DevmLspModule: Module<LangiumServices, PartialLangiumServices> = {
    lsp: {
        SemanticTokenProvider: services => new DevmSemanticTokenProvider(services),
        HoverProvider: services => new DevmHoverProvider(services)
    }
};

/** The features added to the test language (`.devmtest`): also go to definition of C++ names and imported machines. */
export const DevmTestLspModule: Module<LangiumServices, PartialLangiumServices> = {
    lsp: {
        ...DevmLspModule.lsp,
        DefinitionProvider: services => new StateMachineDefinitionProvider(services)
    }
};

/** The services of the language server: the languages of the Device Modeler with the additional LSP features. */
export function createDevmLanguageServerServices(context: DefaultSharedModuleContext) {
    const extensions: DevmServiceExtensions = { devm: DevmLspModule, devmTest: DevmTestLspModule };
    return createDevmServices(context, extensions);
}

/**
 * Imported C/C++ headers in the language server: headers are read from the file system (changed files
 * are re-read: file watcher events), the settings come from the `headers` block of the nearest
 * `devm.gen.json` and from the VS Code settings `devm.headers.*` (include paths relative to the first
 * workspace folder, `${workspaceFolder}`). Documents importing a changed header are validated again.
 */
export function installHeaderSupport(shared: LangiumSharedServices): HeaderConfigFinder {
    const finder = installNodeHeaderSupport(shared);
    const store = cppHeaderStore(shared);
    let workspaceFolder: string | undefined;
    shared.lsp.LanguageServer.onInitialize(params => {
        const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? undefined;
        workspaceFolder = folder ? URI.parse(folder).fsPath : undefined;
    });
    const rebuild = () => {
        void shared.workspace.WorkspaceLock.write(token => shared.workspace.DocumentBuilder.update([], [], token));
    };
    const applySettings = async () => {
        const section = await shared.workspace.ConfigurationProvider.getConfiguration('devm', 'headers') as HeaderSettingsSection | undefined;
        store.updateSettings(headerSettingsFromSection(section, workspaceFolder));
        rebuild();
    };
    shared.workspace.ConfigurationProvider.onConfigurationSectionUpdate(update => {
        if (update.section === 'devm') {
            void applySettings();
        }
    });
    void shared.workspace.ConfigurationProvider.ready.then(applySettings);
    // header and configuration files changed on disk (the document builder ignores them, but relinks the importing documents)
    shared.lsp.DocumentUpdateHandler.onWatchedFilesChange(params => {
        const uris = params.changes.map(change => URI.parse(change.uri));
        const headers = uris.filter(uri => importKind(uri.path) === 'header');
        if (headers.length > 0) {
            store.invalidate(headers);
        }
        if (uris.some(uri => /(^|\/)([^/]+\.)?devm\.gen\.json$/.test(uri.path))) {
            finder.clear();
            store.updateSettings(store.settings);
        }
    });
    return finder;
}
