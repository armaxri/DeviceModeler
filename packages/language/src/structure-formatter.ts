import type { AstNode } from 'langium';
import { Formatting } from 'langium/lsp';
import * as ast from './generated/ast.js';
import { StateMachineFormatter } from './statemachine-formatter.js';

/**
 * Formatter of the `.devm` language. Structure files: one member per line, bodies indented, `a : T`,
 * `a -> b`, `inst.port`, annotations of threads and type declarations on the line before them. The nodes
 * of state machine files are formatted by the {@link StateMachineFormatter} (the AST types of the two kinds are disjoint).
 */
export class StructureFormatter extends StateMachineFormatter {

    protected override format(node: AstNode): void {
        if (ast.isStructDeclaration(node) || ast.isPortInterface(node) || ast.isComponent(node) || ast.isCompositeType(node) || ast.isThread(node)) {
            const formatter = this.getNodeFormatter(node);
            const open = formatter.keyword('{');
            const close = formatter.keyword('}');
            if (open.nodes.length > 0 && close.nodes.length > 0) {
                open.prepend(Formatting.oneSpace());
                formatter.interior(open, close).prepend(Formatting.indent({ allowMore: true }));
                close.prepend(Formatting.newLine());
            }
            formatter.property('name').prepend(Formatting.oneSpace());
            formatter.property('description').prepend(Formatting.oneSpace());
            if (ast.isStructDeclaration(node) || ast.isPortInterface(node)) {
                // optional separators of fields and events: `x : real;`
                this.getNodeFormatter<ast.StructDeclaration | ast.PortInterface>(node).keywords(',', ';').prepend(Formatting.noSpace());
            }
            this.formatAnnotations(node, true);
        } else if (ast.isPort(node) || ast.isComponentInstance(node) || ast.isConnection(node) || ast.isDelegation(node)) {
            const formatter = this.getNodeFormatter<ast.Port | ast.ComponentInstance | ast.Connection | ast.Delegation>(node);
            formatter.keyword(':').prepend(Formatting.oneSpace()).append(Formatting.oneSpace());
            formatter.keyword('->').surround(Formatting.oneSpace());
            formatter.keywords(',').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
            if (ast.isPort(node)) {
                const port = this.getNodeFormatter(node);
                port.property('kind').prepend(Formatting.oneSpace());
                port.property('name').prepend(Formatting.oneSpace());
            }
            if (ast.isComponentInstance(node)) {
                this.getNodeFormatter(node).property('description').prepend(Formatting.oneSpace());
            }
            this.formatAnnotations(node, false);
        } else if (ast.isPortEvent(node) || ast.isStructField(node)) {
            const formatter = this.getNodeFormatter<ast.PortEvent | ast.StructField>(node);
            formatter.keyword(':').prepend(Formatting.oneSpace()).append(Formatting.oneSpace());
        } else if (ast.isPortReference(node)) {
            this.getNodeFormatter(node).keyword('.').surround(Formatting.noSpace());
        } else if (ast.isDataTypeReference(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keywords('::').surround(Formatting.noSpace());
            formatter.keywords('.').surround(Formatting.noSpace());
        } else if (ast.isStructureImport(node)) {
            this.getNodeFormatter(node).properties('paths').prepend(Formatting.oneSpace());
        } else if (ast.isBehavior(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.property('path').prepend(Formatting.oneSpace());
            formatter.property('machine').prepend(Formatting.oneSpace());
        } else if (ast.isStructureAnnotation(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword('@').append(Formatting.noSpace());
            formatter.keyword('(').prepend(Formatting.noSpace()).append(Formatting.noSpace());
            formatter.keyword(')').prepend(Formatting.noSpace());
            formatter.keywords(',').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
        } else if (ast.isAnnotationArgument(node)) {
            this.getNodeFormatter(node).property('unit').prepend(Formatting.oneSpace());
        } else if (ast.isStructureModel(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.property('package').prepend(Formatting.oneSpace());
            const members = [...node.imports, ...node.elements];
            if (node.package !== undefined || members.length > 1) {
                formatter.nodes(...(node.package !== undefined ? members : members.slice(1))).prepend(Formatting.newLine({ allowMore: true }));
            }
        } else {
            super.format(node);
        }
    }

    /**
     * The annotations of an element on one line, followed by the element on the next line
     * (`newLine`, threads and type declarations) or on the same line.
     */
    protected formatAnnotations(node: AstNode & { annotations: ast.StructureAnnotation[] }, newLine: boolean): void {
        if (node.annotations.length === 0) {
            return;
        }
        node.annotations.slice(1).forEach(annotation => this.getNodeFormatter(annotation).keyword('@').prepend(Formatting.oneSpace()));
        const first = ast.isPort(node) ? this.getNodeFormatter(node).property('direction')
            : ast.isComponentInstance(node) ? this.getNodeFormatter(node).property('name')
                : ast.isCompositeType(node) ? this.getNodeFormatter(node).property('kind')
                    : this.getNodeFormatter(node).keywords('struct', 'interface', 'component', 'thread', 'connect', 'delegate');
        first.prepend(newLine ? Formatting.newLine() : Formatting.oneSpace());
    }
}
