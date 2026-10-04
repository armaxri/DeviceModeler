import { GrammarUtils, isReference, type AstNode } from 'langium';
import { AbstractSemanticTokenProvider, type SemanticTokenAcceptor } from 'langium/lsp';
import { SemanticTokenModifiers, SemanticTokenTypes } from 'vscode-languageserver-types';
import * as ast from '../generated/ast.js';
import { cppTypeOfReference, resolveCppValue } from '../cpp-types.js';

/**
 * Semantic highlighting of models for editors without a language server (the Monaco editor of the web
 * app, also embedded in Eclipse, CLion and the desktop app): the same tokens as the language server of
 * the VS Code extension (`HsmSemanticTokenProvider` in `packages/vscode/src/server/hsm-lsp.ts`). Names of
 * declarations and cross references get the kind of the element (state, event, variable, constant,
 * operation, …), C++ names of imported headers are types, enums, enumerators and constants, which a
 * TextMate / Monarch grammar cannot know.
 */

interface TokenKind {
    type: string;
    modifier?: string[];
}

/** Semantic token type of a declaration (or of the target of a reference). */
export function semanticTokenKind(node: AstNode | undefined): TokenKind | undefined {
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
            return ast.isVariableDeclaration(node) && (node.const || node.readonly)
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

export class ModelSemanticTokenProvider extends AbstractSemanticTokenProvider {

    protected override highlightElement(node: AstNode, acceptor: SemanticTokenAcceptor): void {
        // C++ names of imported headers: types, enumerators and constants
        const cppType = ast.isTypeReference(node) && node.$cstNode ? cppTypeOfReference(node) : undefined;
        if (cppType && node.$cstNode) {
            acceptor({ cst: node.$cstNode, type: cppType.resolved.kind === 'enum' ? SemanticTokenTypes.enum : SemanticTokenTypes.type });
        } else if (ast.isCppReference(node) && node.$cstNode) {
            const resolved = resolveCppValue(node);
            const enumerator = resolved.info?.declaration.kind === 'enumerator';
            acceptor({ cst: node.$cstNode, type: enumerator ? SemanticTokenTypes.enumMember : SemanticTokenTypes.variable, modifier: enumerator ? [] : [SemanticTokenModifiers.readonly] });
        }
        const own = semanticTokenKind(node);
        if (own && node.$cstNode && GrammarUtils.findNodeForProperty(node.$cstNode, 'name')) {
            acceptor({ node, property: 'name' as never, type: own.type, modifier: [SemanticTokenModifiers.declaration, ...own.modifier ?? []] });
        }
        for (const [property, value] of Object.entries(node)) {
            if (property.startsWith('$') || !isReference(value)) {
                continue;
            }
            const target = semanticTokenKind(value.ref);
            if (target && value.$refNode) {
                acceptor({ cst: value.$refNode, type: target.type, modifier: target.modifier });
            }
        }
    }
}
