import {
    AstUtils, Cancellation, EMPTY_SCOPE, MapScope,
    type AstNode, type AstNodeDescription, type LangiumDocument, type LinkingError, type ReferenceInfo, type Scope
} from 'langium';
import * as ast from './generated/ast.js';
import { hasRegisteredImports, importedStructureMachines, visibleElements } from './structure-imports.js';
import type { DevmServices } from './devm-module.js';
import { enclosingComposite, instanceType, compositeInstances } from './structure-model.js';
import { StateMachineLinker } from './statemachine-linker.js';
import { StateMachineScopeProvider } from './statemachine-scope.js';

/**
 * Name resolution of the structure language.
 *
 * - Component types (`door : DoorController`) are looked up in the model and in the imported
 *   structure files, by simple name or by `package.Name` (see `visibleElements` in structure-imports.ts).
 *   Elements of files that are not imported are not visible.
 * - Instances (`door` in `connect door.motor -> ...`, `thread T { door }`) are the instances of the
 *   enclosing structure, including the instances declared in its threads.
 * - Ports: `inst.port` denotes a port of the component type of the instance, `port` (without an
 *   instance) a boundary port of the enclosing structure.
 * - `behavior Door` denotes a state machine of an imported state machine file.
 *
 * The scope provider of the `.devm` language: references in state machine files (and everything not
 * in a structure file) are resolved by the {@link StateMachineScopeProvider}.
 */
export class StructureScopeProvider extends StateMachineScopeProvider {

    constructor(protected readonly services: DevmServices) {
        super(services);
    }

    override getScope(context: ReferenceInfo): Scope {
        const container = context.container;
        const model = AstUtils.getContainerOfType(container, ast.isStructureModel);
        if (!model) {
            return super.getScope(context);
        }
        // references into other documents may be resolved before those documents are linked
        if (!hasRegisteredImports(model)) {
            this.services.references.StructureImportResolver.update(model);
        }
        if (ast.isComponentInstance(container)) {
            return this.elementScope(model, ast.isComponentType);
        }
        if (ast.isBehavior(container)) {
            return new MapScope(importedStructureMachines(model).filter(m => m.name).map(m => this.descriptions.createDescription(m, m.name)));
        }
        if (ast.isThreadMember(container) || (ast.isPortReference(container) && context.property === 'instance')) {
            const structure = enclosingComposite(container);
            return structure ? this.namedScope(compositeInstances(structure)) : EMPTY_SCOPE;
        }
        if (ast.isPortReference(container) && context.property === 'port') {
            if (container.instance) {
                return this.namedScope(instanceType(container.instance.ref)?.ports ?? []);
            }
            return this.namedScope(enclosingComposite(container)?.ports ?? []);
        }
        return EMPTY_SCOPE;
    }

    /** The visible elements of the given kind by their referable names. */
    protected elementScope(model: ast.StructureModel, filter: (element: ast.StructureElement) => boolean): Scope {
        const descriptions: AstNodeDescription[] = [];
        for (const [name, element] of visibleElements(model)) {
            if (filter(element)) {
                descriptions.push(this.descriptions.createDescription(element, name));
            }
        }
        return new MapScope(descriptions);
    }

    /** Named nodes by their names (the first node of a name wins, duplicates are reported by the validator). */
    protected namedScope(nodes: ReadonlyArray<AstNode & { name: string }>): Scope {
        const names = new Set<string>();
        const descriptions: AstNodeDescription[] = [];
        for (const node of nodes) {
            if (node.name && !names.has(node.name)) {
                names.add(node.name);
                descriptions.push(this.descriptions.createDescription(node, node.name));
            }
        }
        return new MapScope(descriptions);
    }
}

/**
 * Linker of the `.devm` language: for structure files, resolves the imports of the model (see
 * structure-imports.ts) before its references are linked and explains unresolved port references; state
 * machine files are linked by the {@link StateMachineLinker}.
 */
export class StructureLinker extends StateMachineLinker {

    constructor(services: DevmServices) {
        super(services);
    }

    override async link(document: LangiumDocument, cancelToken = Cancellation.CancellationToken.None): Promise<void> {
        const root = document.parseResult.value;
        if (ast.isStructureModel(root)) {
            this.services.references.StructureImportResolver.update(root);
        }
        await super.link(document, cancelToken);
    }

    protected override createLinkingError(refInfo: ReferenceInfo, targetDescription?: AstNodeDescription): LinkingError {
        const error = super.createLinkingError(refInfo, targetDescription);
        const container = refInfo.container;
        if (targetDescription || !ast.isPortReference(container) || refInfo.property !== 'port') {
            return error;
        }
        const name = refInfo.reference.$refText;
        if (container.instance) {
            const instance = container.instance.ref;
            const type = instanceType(instance);
            if (!instance || !type) {
                return { ...error, message: `Cannot resolve the port '${container.instance.$refText}.${name}': the instance '${container.instance.$refText}' is unknown.` };
            }
            const ports = type.ports.map(p => p.name);
            return { ...error, message: `The component type '${type.name}' of '${instance.name}' has no port '${name}'${ports.length > 0 ? ` (ports: ${ports.join(', ')})` : ''}.` };
        }
        const structure = enclosingComposite(container);
        return { ...error, message: `'${structure?.name ?? '?'}' has no boundary port '${name}'. Ports of instances are written 'instance.port'.` };
    }
}
