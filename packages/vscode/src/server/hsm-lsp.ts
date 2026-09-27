import { GrammarUtils, isReference, type AstNode, type MaybePromise, type Module } from 'langium';
import {
    AbstractSemanticTokenProvider, MultilineCommentHoverProvider, type LangiumServices, type PartialLangiumServices, type SemanticTokenAcceptor
} from 'langium/lsp';
import { SemanticTokenModifiers, SemanticTokenTypes } from 'vscode-languageserver';
import {
    createHsmServices, isEventDeclaration, isInterfaceScope, isOperationDeclaration, isPseudoState, isState, isStateMachine, isVariableDeclaration,
    nodeText, qualifiedName, type HsmServiceExtensions
} from 'hsm-language';
import type { DefaultSharedModuleContext } from 'langium/lsp';

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
        default:
            return undefined;
    }
}

/**
 * Semantic highlighting for both languages: names of declarations and all cross references are
 * highlighted by the kind of the element they declare / refer to (states, events, variables,
 * constants, operations, …), which the TextMate grammar cannot know.
 */
export class HsmSemanticTokenProvider extends AbstractSemanticTokenProvider {

    protected override highlightElement(node: AstNode, acceptor: SemanticTokenAcceptor): void {
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
export class HsmHoverProvider extends MultilineCommentHoverProvider {

    protected override getAstNodeHoverContent(node: AstNode): MaybePromise<string | undefined> {
        const signature = hoverSignature(node);
        const documentation = super.getAstNodeHoverContent(node);
        const combine = (doc: string | undefined) => [signature ? '```hsm\n' + signature + '\n```' : undefined, doc].filter(part => part).join('\n\n') || undefined;
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

/** Language server features added to both languages. */
export const HsmLspModule: Module<LangiumServices, PartialLangiumServices> = {
    lsp: {
        SemanticTokenProvider: services => new HsmSemanticTokenProvider(services),
        HoverProvider: services => new HsmHoverProvider(services)
    }
};

/** The services of the language server: the HSM languages with the additional LSP features. */
export function createHsmLanguageServerServices(context: DefaultSharedModuleContext) {
    const extensions: HsmServiceExtensions = { hsm: HsmLspModule, hsmTest: HsmLspModule };
    return createHsmServices(context, extensions);
}
