import {
    AstUtils, Cancellation, DefaultLinker, DefaultScopeProvider, EMPTY_SCOPE, MapScope,
    type AstNode, type AstNodeDescription, type LangiumDocument, type LinkingError, type ReferenceInfo, type Scope
} from 'langium';
import * as ast from './generated/ast.js';
import { hasRegisteredImports, importedDmfMachines, visibleElements } from './dmf-imports.js';
import type { DmfServices } from './dmf-module.js';
import { enclosingStructure, instanceType, structureInstances } from './dmf-model.js';

/**
 * Name resolution of the structure language.
 *
 * - Component types (`door : DoorController`) are looked up in the model and in the imported
 *   structure files, by simple name or by `package.Name` (see `visibleElements` in dmf-imports.ts).
 *   Elements of files that are not imported are not visible.
 * - Instances (`door` in `connect door.motor -> ...`, `thread T { door }`) are the instances of the
 *   enclosing structure, including the instances declared in its threads.
 * - Ports: `inst.port` denotes a port of the component type of the instance, `port` (without an
 *   instance) a boundary port of the enclosing structure.
 * - `behavior Door` denotes a state machine of an imported `.hsm` file.
 */
export class DmfScopeProvider extends DefaultScopeProvider {

    constructor(protected readonly services: DmfServices) {
        super(services);
    }

    override getScope(context: ReferenceInfo): Scope {
        const container = context.container;
        const model = AstUtils.getContainerOfType(container, ast.isDmfModel);
        if (!model) {
            return EMPTY_SCOPE;
        }
        // references into other documents may be resolved before those documents are linked
        if (!hasRegisteredImports(model)) {
            this.services.references.DmfImportResolver.update(model);
        }
        if (ast.isComponentInstance(container)) {
            return this.elementScope(model, ast.isComponentType);
        }
        if (ast.isBehavior(container)) {
            return new MapScope(importedDmfMachines(model).filter(m => m.name).map(m => this.descriptions.createDescription(m, m.name)));
        }
        if (ast.isThreadMember(container) || (ast.isPortReference(container) && context.property === 'instance')) {
            const structure = enclosingStructure(container);
            return structure ? this.namedScope(structureInstances(structure)) : EMPTY_SCOPE;
        }
        if (ast.isPortReference(container) && context.property === 'port') {
            if (container.instance) {
                return this.namedScope(instanceType(container.instance.ref)?.ports ?? []);
            }
            return this.namedScope(enclosingStructure(container)?.ports ?? []);
        }
        return EMPTY_SCOPE;
    }

    /** The visible elements of the given kind by their referable names. */
    protected elementScope(model: ast.DmfModel, filter: (element: ast.DmfElement) => boolean): Scope {
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
 * Linker of the structure language: resolves the imports of the model (see dmf-imports.ts) before its
 * references are linked and explains unresolved port references.
 */
export class DmfLinker extends DefaultLinker {

    constructor(protected readonly services: DmfServices) {
        super(services);
    }

    override async link(document: LangiumDocument, cancelToken = Cancellation.CancellationToken.None): Promise<void> {
        const root = document.parseResult.value;
        if (ast.isDmfModel(root)) {
            this.services.references.DmfImportResolver.update(root);
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
        const structure = enclosingStructure(container);
        return { ...error, message: `'${structure?.name ?? '?'}' has no boundary port '${name}'. Ports of instances are written 'instance.port'.` };
    }
}
