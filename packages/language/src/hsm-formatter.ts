import { isLeafCstNode, type AstNode, type CstNode } from 'langium';
import { AbstractFormatter, Formatting } from 'langium/lsp';
import * as ast from './generated/ast.js';
import { elementAnnotations, type AnnotatedElement } from './model-annotations.js';

export class HsmFormatter extends AbstractFormatter {

    protected override format(node: AstNode): void {
        if (ast.isStateMachine(node) || ast.isState(node) || ast.isRegion(node)) {
            const formatter = this.getNodeFormatter(node);
            const open = formatter.keyword('{');
            const close = formatter.keyword('}');
            if (open.nodes.length > 0 && close.nodes.length > 0) {
                open.prepend(Formatting.oneSpace());
                formatter.interior(open, close).prepend(Formatting.indent({ allowMore: true }));
                close.prepend(Formatting.newLine());
            }
            // the element annotations of an element on one line before it: `@at(10, 20) @size(100, 60)`
            const elements: AnnotatedElement[] = [...node.vertices, ...node.transitions, ...(ast.isState(node) ? node.regions : [])];
            for (const element of elements) {
                elementAnnotations(element).slice(1).forEach(annotation => {
                    this.getNodeFormatter(annotation).keyword('@').prepend(Formatting.oneSpace());
                });
            }
            formatter.property('name').prepend(Formatting.oneSpace());
            if (ast.isState(node) || ast.isStateMachine(node)) {
                this.getNodeFormatter<ast.State | ast.StateMachine>(node).property('description').prepend(Formatting.oneSpace());
            }
            if (ast.isState(node)) {
                // submachine binding: `state Moving : motor`
                this.getNodeFormatter(node).keyword(':').surround(Formatting.oneSpace());
            }
        } else if (ast.isImport(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword(':').prepend(Formatting.noSpace());
            formatter.properties('paths').prepend(Formatting.oneSpace());
        } else if (ast.isPseudoState(node)) {
            this.getNodeFormatter(node).property('name').prepend(Formatting.oneSpace());
        } else if (ast.isInterfaceScope(node) || ast.isInternalScope(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword(':').prepend(Formatting.noSpace());
            formatter.properties('declarations').prepend(Formatting.indent({ allowMore: true }));
            // doc comments of the declarations are indented like them (otherwise they keep the indentation
            // of the scope keyword)
            const comments = node.declarations.flatMap(declaration => precedingComments(declaration.$cstNode));
            if (comments.length > 0) {
                formatter.cst(comments).prepend(Formatting.indent({ allowMore: true }));
            }
        } else if (ast.isEventDeclaration(node) || ast.isVariableDeclaration(node) || ast.isParameter(node) || ast.isTypeAliasDeclaration(node)) {
            const formatter = this.getNodeFormatter<ast.EventDeclaration | ast.VariableDeclaration | ast.Parameter | ast.TypeAliasDeclaration>(node);
            formatter.keyword(':').surround(Formatting.oneSpace());
            formatter.keyword('=').surround(Formatting.oneSpace());
        } else if (ast.isOperationDeclaration(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword('(').prepend(Formatting.noSpace()).append(Formatting.noSpace());
            formatter.keyword(')').prepend(Formatting.noSpace());
            formatter.keyword(':').surround(Formatting.oneSpace());
            formatter.keywords(',').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
        } else if (ast.isTransition(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword('->').surround(Formatting.oneSpace());
            formatter.keyword(':').prepend(Formatting.oneSpace()).append(Formatting.oneSpace());
            formatter.keyword('#').prepend(Formatting.oneSpace());
        } else if (ast.isTypeReference(node) || ast.isCppReference(node)) {
            // C++ names: `motor::Mode::Fast`
            const formatter = this.getNodeFormatter<ast.TypeReference | ast.CppReference>(node);
            formatter.keywords('::').surround(Formatting.noSpace());
            formatter.keywords('.').surround(Formatting.noSpace());
        } else if (ast.isMemberAccessExpression(node) || ast.isElementReference(node)) {
            // `valueof(e).x`, `pos.x`, `Iface.x`
            this.getNodeFormatter<ast.MemberAccessExpression | ast.ElementReference>(node).keywords('.').surround(Formatting.noSpace());
        } else if (ast.isAnnotation(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword('@').append(Formatting.noSpace());
            formatter.keyword('(').prepend(Formatting.noSpace()).append(Formatting.noSpace());
            formatter.keyword(')').prepend(Formatting.noSpace());
            formatter.keywords(',').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
        } else if (ast.isReactionSpec(node) || ast.isLocalReaction(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword('[').prepend(Formatting.oneSpace()).append(Formatting.noSpace());
            formatter.keyword(']').prepend(Formatting.noSpace());
            formatter.keyword('/').surround(Formatting.oneSpace());
            formatter.keywords(',').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
        }
    }
}

/** The comments directly before a CST node (between it and the previous non-hidden node). */
function precedingComments(node: CstNode | undefined): CstNode[] {
    const result: CstNode[] = [];
    const container = node?.container;
    if (!node || !container) {
        return result;
    }
    const siblings = container.content;
    for (let i = siblings.indexOf(node) - 1; i >= 0 && siblings[i].hidden; i--) {
        if (isLeafCstNode(siblings[i]) && /^\/[*/]/.test(siblings[i].text)) {
            result.unshift(siblings[i]);
        }
    }
    return result;
}
