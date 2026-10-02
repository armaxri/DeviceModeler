import { AstUtils, UriUtils, type AstNode, type LangiumCoreServices, type LangiumDocuments, type URI } from 'langium';
import * as ast from './generated/ast.js';
import { cppHeaderStore, loadHeaderClosure, resolveHeaderPath, type CppHeaderStore, type CppImportInfo, type LoadedHeader } from './cpp-headers.js';
import { CppTypeIndex } from './cpp-header/type-index.js';
import { HEADER_EXTENSIONS, resolveImportUri, type ResolvedHeader } from './imports.js';

/**
 * Imports of structure files (`.dmf`) and the state machines of components (`behavior "door.hsm"`).
 *
 * A structure file imports other structure files (their structs, interfaces and component types
 * become visible, by simple name and by `package.Name`), state machine files (for `behavior Door`)
 * and C/C++ headers (their types can be used as data types). Paths are resolved relative to the
 * importing file like the imports of state machines (see imports.ts); the imported documents must be
 * loaded into the Langium workspace (the language server loads all files of the workspace,
 * {@link DmfModelLoader} loads imported files transitively).
 *
 * The {@link DmfImportResolver} (service `references.DmfImportResolver`) resolves the imports and the
 * behavior paths of a model before its document is linked and stores the result in a registry, so the
 * scope provider, the validator and the route analysis can use the pure functions of this module.
 */

/** `dmf`: a structure file; `hsm`: a state machine file; `header`: a C/C++ header; `unsupported`: any other file. */
export type DmfImportKind = 'dmf' | 'hsm' | 'header' | 'unsupported';

/** The kind of an import path of a structure file, by its file extension. */
export function dmfImportKind(path: string): DmfImportKind {
    const lower = path.toLowerCase();
    if (lower.endsWith('.dmf')) {
        return 'dmf';
    }
    if (lower.endsWith('.hsm')) {
        return 'hsm';
    }
    return HEADER_EXTENSIONS.some(extension => lower.endsWith(extension)) ? 'header' : 'unsupported';
}

/** The result of resolving one import path of a structure file. */
export interface ResolvedDmfImport {
    readonly node: ast.DmfImportPath;
    readonly path: string;
    readonly kind: DmfImportKind;
    /** URI of the imported file (resolved relative to the importing document). */
    readonly uri?: URI;
    /** `dmf`: the imported model, `undefined` if the file is not loaded. */
    readonly model?: ast.DmfModel;
    /** `hsm`: the imported state machine, `undefined` if the file is not loaded. */
    readonly machine?: ast.StateMachine;
    /** `header`: the result of the header resolution. */
    readonly header?: ResolvedHeader;
}

/** The resolved state machine of a component (`behavior "door.hsm"` or `behavior Door`). */
export interface ResolvedBehavior {
    readonly node: ast.Behavior;
    /** The path of `behavior "door.hsm"`, `undefined` for `behavior Door`. */
    readonly path?: string;
    readonly uri?: URI;
    /** The state machine, `undefined` if the file is not loaded (or the name cannot be resolved). */
    readonly machine?: ast.StateMachine;
}

/** All import paths of a model in text order. */
export function dmfImportPaths(model: ast.DmfModel): ast.DmfImportPath[] {
    return model.imports.flatMap(i => i.paths);
}

// ---------------------------------------------------------------------------------------------
// Registry (filled by the DmfImportResolver before a document is linked)

interface DmfRegistration {
    readonly imports: readonly ResolvedDmfImport[];
    readonly cpp?: CppImportInfo;
    readonly behaviors: ReadonlyMap<ast.Behavior, ResolvedBehavior>;
}

const registry = new WeakMap<ast.DmfModel, DmfRegistration>();
const elementsCache = new WeakMap<DmfRegistration, Map<string, ast.DmfElement>>();
let emptyIndex: CppTypeIndex | undefined;

/** Stores the resolved imports of a model (called by the {@link DmfImportResolver}). */
export function registerDmfImports(model: ast.DmfModel, imports: readonly ResolvedDmfImport[], cpp?: CppImportInfo,
    behaviors: ReadonlyMap<ast.Behavior, ResolvedBehavior> = new Map()): void {
    registry.set(model, { imports, cpp, behaviors });
}

/** Whether the imports of a model were resolved (by the {@link DmfImportResolver}). */
export function hasRegisteredImports(model: ast.DmfModel): boolean {
    return registry.has(model);
}

/** The resolved imports of a model (empty if it has none or they were not resolved yet). */
export function resolvedDmfImports(model: ast.DmfModel): readonly ResolvedDmfImport[] {
    return registry.get(model)?.imports ?? [];
}

/** The C++ types visible in a model: the index over its imported headers (an empty index without header imports). */
export function dmfCppImports(model: ast.DmfModel | undefined): CppImportInfo {
    const info = model ? registry.get(model)?.cpp : undefined;
    return info ?? { index: emptyIndex ??= new CppTypeIndex([]), headers: [] };
}

/** The structure files imported by a model (that could be loaded), in text order, without the model itself. */
export function importedModels(model: ast.DmfModel): ast.DmfModel[] {
    const result: ast.DmfModel[] = [];
    for (const resolved of resolvedDmfImports(model)) {
        if (resolved.model && resolved.model !== model && !result.includes(resolved.model)) {
            result.push(resolved.model);
        }
    }
    return result;
}

/** The state machines of the `.hsm` files imported by a model, in text order. */
export function importedDmfMachines(model: ast.DmfModel): ast.StateMachine[] {
    return resolvedDmfImports(model).flatMap(i => i.machine ? [i.machine] : []);
}

/**
 * The elements (structs, interfaces, component types) visible in a model by the names under which
 * they can be referenced: the own elements by simple name (and `package.Name`), then the elements of
 * the imported files by simple name and `package.Name`. The first element of a name wins (duplicates
 * are reported by the validator).
 */
export function visibleElements(model: ast.DmfModel): Map<string, ast.DmfElement> {
    // cached per resolution of the imports (recomputed when the model is linked again)
    const registration = registry.get(model);
    const cached = registration ? elementsCache.get(registration) : undefined;
    if (cached) {
        return cached;
    }
    const result = new Map<string, ast.DmfElement>();
    const add = (source: ast.DmfModel) => {
        for (const element of source.elements) {
            if (!element.name) {
                continue;
            }
            for (const name of source.package ? [element.name, `${source.package}.${element.name}`] : [element.name]) {
                if (!result.has(name)) {
                    result.set(name, element);
                }
            }
        }
    };
    add(model);
    importedModels(model).forEach(add);
    if (registration) {
        elementsCache.set(registration, result);
    }
    return result;
}

/** The model containing a node. */
export function dmfModelOf(node: AstNode): ast.DmfModel | undefined {
    return AstUtils.getContainerOfType(node, ast.isDmfModel);
}

/**
 * The state machine implementing a component (`behavior "door.hsm"`: the state machine of that file,
 * `behavior Door`: the referenced state machine of an imported `.hsm` file).
 */
export function behaviorMachine(component: ast.Component | undefined): ast.StateMachine | undefined {
    return component?.behavior ? resolvedBehavior(component.behavior).machine : undefined;
}

/** The resolution of a behavior reference. */
export function resolvedBehavior(behavior: ast.Behavior): ResolvedBehavior {
    if (behavior.machine) {
        return { node: behavior, machine: behavior.machine.ref, uri: behavior.machine.ref?.$document?.uri };
    }
    const model = AstUtils.getContainerOfType(behavior, ast.isDmfModel);
    return (model && registry.get(model)?.behaviors.get(behavior)) ?? { node: behavior, path: behavior.path ?? '' };
}

// ---------------------------------------------------------------------------------------------
// Resolution

/** Resolves the imports and behavior paths of structure models against the documents of the Langium workspace. */
export class DmfImportResolver {

    protected readonly documents: LangiumDocuments;
    readonly headerStore: CppHeaderStore;

    constructor(services: LangiumCoreServices) {
        this.documents = services.shared.workspace.LangiumDocuments;
        this.headerStore = cppHeaderStore(services.shared);
    }

    /** Resolves the imports of a model and stores them in the registry. */
    update(model: ast.DmfModel): readonly ResolvedDmfImport[] {
        const imports = this.resolve(model);
        const behaviors = new Map<ast.Behavior, ResolvedBehavior>();
        for (const component of model.elements.filter(ast.isComponent)) {
            if (component.behavior?.path !== undefined) {
                behaviors.set(component.behavior, this.resolveBehavior(component.behavior));
            }
        }
        registerDmfImports(model, imports, this.cppImports(model, imports), behaviors);
        return imports;
    }

    /** Resolves all import paths of a model (without storing the result). */
    resolve(model: ast.DmfModel): ResolvedDmfImport[] {
        const base = model.$document?.uri;
        return dmfImportPaths(model).map(node => this.resolvePath(node, base));
    }

    /** Resolves `behavior "door.hsm"` relative to the model (`behavior Door` is a cross-reference). */
    resolveBehavior(behavior: ast.Behavior): ResolvedBehavior {
        const path = behavior.path ?? '';
        const base = AstUtils.findRootNode(behavior).$document?.uri;
        if (!base || !path) {
            return { node: behavior, path };
        }
        const uri = resolveImportUri(base, path);
        const root = this.documents.getDocument(uri)?.parseResult.value;
        return { node: behavior, path, uri, machine: ast.isStateMachine(root) ? root : undefined };
    }

    /**
     * Whether something the model depends on changed: an imported or behavior file that was not loaded
     * (it may exist now), one of the given changed documents, or an imported header.
     */
    dependenciesChanged(model: ast.DmfModel, changedUris: Set<string>): boolean {
        const imports = resolvedDmfImports(model);
        const changed = (uri: URI | undefined) => uri !== undefined && changedUris.has(uri.toString());
        if (imports.some(i => (i.kind === 'dmf' && (!i.model || changed(i.uri))) || (i.kind === 'hsm' && (!i.machine || changed(i.uri))))) {
            return true;
        }
        for (const resolved of registry.get(model)?.behaviors.values() ?? []) {
            if (!resolved.machine || changed(resolved.uri)) {
                return true;
            }
        }
        const info = registry.get(model)?.cpp;
        if (info && info.settingsVersion !== this.headerStore.settingsVersion) {
            return true;
        }
        return imports.some(i => i.kind === 'header' && i.header !== undefined
            && (!i.header.found || i.header.headers.some(h => this.headerStore.version(h.uri) !== h.version)));
    }

    protected resolvePath(node: ast.DmfImportPath, base: URI | undefined): ResolvedDmfImport {
        const path = node.path ?? '';
        const kind = dmfImportKind(path);
        const uri = base && path ? resolveImportUri(base, path) : undefined;
        if (kind === 'header') {
            return this.resolveHeader(node, path, uri, base);
        }
        if (kind === 'unsupported' || !uri) {
            return { node, path, kind, uri };
        }
        const root = this.documents.getDocument(uri)?.parseResult.value;
        if (kind === 'dmf') {
            return { node, path, kind, uri, model: ast.isDmfModel(root) ? root : undefined };
        }
        return { node, path, kind, uri, machine: ast.isStateMachine(root) ? root : undefined };
    }

    protected resolveHeader(node: ast.DmfImportPath, path: string, uri: URI | undefined, base: URI | undefined): ResolvedDmfImport {
        const settings = this.headerStore.settingsFor(base);
        const found = resolveHeaderPath(this.headerStore, path, base ? UriUtils.dirname(base) : undefined, settings);
        if (!found.uri) {
            return { node, path, kind: 'header', uri: uri ?? found.searched[0], header: { found: false, searched: found.searched, headers: [] } };
        }
        const headers = loadHeaderClosure(this.headerStore, found.uri, settings);
        return { node, path, kind: 'header', uri: found.uri, header: { found: true, searched: found.searched, headers } };
    }

    /** The index over the headers of the resolved imports (`undefined` if there are no header imports). */
    protected cppImports(model: ast.DmfModel, imports: readonly ResolvedDmfImport[]): CppImportInfo | undefined {
        if (!imports.some(i => i.kind === 'header')) {
            return undefined;
        }
        const headers: LoadedHeader[] = [];
        const seen = new Set<string>();
        for (const header of imports.flatMap(i => i.header?.headers ?? [])) {
            if (!seen.has(header.uri.toString())) {
                seen.add(header.uri.toString());
                headers.push(header);
            }
        }
        const settings = this.headerStore.settingsFor(model.$document?.uri);
        return { index: this.headerStore.index(headers, settings), headers, settingsVersion: this.headerStore.settingsVersion };
    }
}
