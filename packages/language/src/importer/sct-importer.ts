/**
 * Importer for itemis CREATE / YAKINDU Statechart Tools models (`.sct` files).
 *
 * An `.sct` file is an EMF XMI document which contains the statechart (`sgraph:Statechart`) and
 * its diagram (`notation:Diagram`). The statechart is converted into HSM text, the positions and sizes
 * of the diagram are converted into a manual layout (`.hsm.layout`, see `diagram/manual-layout.ts`).
 * The definition section and all reactions use the same syntax as the HSM language, so they are
 * copied (re-indented and slightly normalized). The structure is translated as follows:
 *
 * | itemis CREATE                        | HSM                                   |
 * |--------------------------------------|---------------------------------------|
 * | statechart                           | `statemachine Name`                   |
 * | several top-level regions            | `state Main { region r1 {} ... }`     |
 * | region (single / orthogonal)         | dropped / `region name { }`           |
 * | state (+ local reactions)            | `state Name { reactions ... }`        |
 * | entry (default)                      | `[*] -> Target`                       |
 * | entry (named) / exit                 | `entry Name` / `exit Name`            |
 * | shallow / deep history entry         | `history H` / `deephistory H`         |
 * | choice (dynamic / static)            | `choice` / `junction`                 |
 * | synchronization                      | `sync`                                |
 * | final state                          | `Source -> [*]`                       |
 */
import { HSM_KEYWORDS } from '../edit/model-edits.js';
import { DEFINITION_ID, DiagramMetrics, MACHINE_ID } from '../diagram/layout.js';
import { createManualLayout, type ManualLayout, type NodeLayout } from '../diagram/manual-layout.js';
import type { Point } from '../diagram/diagram-model.js';
import { parseXml, type XmlElement } from './xml.js';

export interface SctImportOptions {
    /** Name of the composite state which wraps several top-level regions (default `Main`). */
    mainStateName?: string;
    /** Indentation unit of the generated text (default four spaces). */
    indent?: string;
    /** Convert the diagram (`notation:Diagram`) into a manual layout (default true). */
    layout?: boolean;
}

export interface SctImportResult {
    /** The generated HSM text. */
    text: string;
    /** Everything that could not be imported 1:1 (renamed states, unsupported features, ...). */
    warnings: string[];
    /** Positions and sizes of the itemis diagram (if the file contains one), to be stored as `<model>.hsm.layout`. */
    layout?: ManualLayout;
}

/** Converts the content of an itemis CREATE `.sct` file into HSM text. */
export function importSct(xml: string, options: SctImportOptions = {}): SctImportResult {
    return new SctImporter(options).run(xml);
}

// ---------------------------------------------------------------------------------------------
// Intermediate model (mirrors the structure of the HSM language)

type Container = MachineNode | StateNode | RegionNode;

interface ContainerBase {
    vertices: VertexNode[];
    transitions: TransitionNode[];
}

interface MachineNode extends ContainerBase {
    kind: 'machine';
    name: string;
}

interface RegionNode extends ContainerBase {
    kind: 'region';
    name?: string;
    state: StateNode;
    /** `xmi:id` of the region (layout import). */
    id?: string;
}

type PseudoKind = 'choice' | 'junction' | 'history' | 'deephistory' | 'sync' | 'entry' | 'exit';

interface VertexBase {
    /** `xmi:id` of the vertex (empty for generated vertices). */
    id: string;
    name: string;
    /** Name in the itemis model (if the vertex was named there). */
    originalName?: string;
    container: Container;
    /** Path of region and state names in the itemis model, used to resolve `active(...)`. */
    itemisPath: string[];
    /** Position in a depth-first traversal, used to keep the transition priorities. */
    order: number;
    element?: XmlElement;
}

interface StateNode extends VertexBase, ContainerBase {
    kind: 'state';
    regions: RegionNode[];
    /** Local reactions, each given as a list of lines. */
    reactions: string[][];
    comments: string[];
    description?: string;
}

interface PseudoNode extends VertexBase {
    kind: PseudoKind;
}

type VertexNode = StateNode | PseudoNode;

/** Vertices of the itemis model that do not become vertices in HSM. */
interface ImplicitVertex {
    kind: 'initial' | 'final';
    container: Container;
    order: number;
    element: XmlElement;
}

interface TransitionNode {
    source: VertexNode | 'initial';
    target: VertexNode | 'final';
    /** Normalized reaction text (lines), without `# ...` part. */
    spec: string[];
    entryPoint?: string;
    exitPoint?: string;
    container: Container;
    order: [number, number];
    /** `xmi:id` of the itemis transition (layout import). */
    elementId?: string;
}

const TIME_OR_NAME_TRIGGER = String.raw`(?:(?:after|every)\s+[^,\[\]/]+?|[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)`;
const REACTION_PREFIX = new RegExp(String.raw`^\s*(?:${TIME_OR_NAME_TRIGGER}(?:\s*,\s*${TIME_OR_NAME_TRIGGER})*)?\s*(?:\[.*\])?\s*$`);
const DECLARATION_START = /^\s*(in|out|event|var|const|readonly|operation|alias)\b/;
const SCOPE_HEADER = /^\s*(interface\b[^:]*|internal\s*):/;

class SctImporter {

    private readonly warnings: string[] = [];
    private readonly indentUnit: string;
    private readonly mainStateName: string;
    private readonly vertexById = new Map<string, VertexNode>();
    private readonly implicitById = new Map<string, ImplicitVertex>();
    private readonly allVertices: VertexNode[] = [];
    private readonly pending: TransitionNode[] = [];
    private machine!: MachineNode;
    private statechartName = '';
    private orderCounter = 0;
    private topRegions: XmlElement[] = [];

    constructor(private readonly options: SctImportOptions) {
        this.indentUnit = options.indent ?? '    ';
        this.mainStateName = options.mainStateName ?? 'Main';
    }

    run(xml: string): SctImportResult {
        const root = parseXml(xml);
        const statechart = root.name === 'sgraph:Statechart' ? root : root.children.find(c => c.name === 'sgraph:Statechart');
        if (!statechart) {
            throw new Error('The file does not contain an itemis CREATE statechart (sgraph:Statechart).');
        }
        this.statechartName = statechart.attributes['name'] ?? '';
        const machineName = sanitizeName(this.statechartName) || 'Statechart';
        if (machineName !== this.statechartName) {
            this.warn(`Statechart '${this.statechartName}' was renamed to '${machineName}'.`);
        }
        this.machine = { kind: 'machine', name: machineName, vertices: [], transitions: [] };

        this.buildStructure(statechart);
        this.assignNames(this.machine);
        this.buildTransitions();

        const lines: string[] = [];
        lines.push(`statemachine ${machineName}${machineName !== this.statechartName && this.statechartName ? ' ' + quote(this.statechartName) : ''} {`);
        const definition = this.convertSpecification(statechart.attributes['specification'] ?? '', statechart.attributes['namespace']);
        if (definition.length > 0) {
            lines.push(...definition.map(line => line ? this.indentUnit + line : ''));
            lines.push('');
        }
        lines.push(...this.emitBody(this.machine, 1));
        lines.push('}');
        const layout = this.options.layout === false ? undefined : new NotationImporter(this.machine, this.implicitById, this.topRegions).run(root);
        return { text: collapseBlankLines(lines).join('\n') + '\n', warnings: this.warnings, ...(layout ? { layout } : {}) };
    }

    private warn(message: string): void {
        if (!this.warnings.includes(message)) {
            this.warnings.push(message);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Structure

    private buildStructure(statechart: XmlElement): void {
        const regions = statechart.children.filter(c => c.name === 'regions');
        this.topRegions = regions;
        if (regions.length === 1) {
            this.convertRegion(regions[0], this.machine, []);
        } else if (regions.length > 1) {
            const main = this.createState(this.mainStateName, this.machine, [], undefined);
            main.itemisPath = [];
            this.warn(`The statechart has ${regions.length} top-level regions; they were wrapped into the composite state '${this.mainStateName}'.`);
            for (const region of regions) {
                this.convertRegionOf(main, region, regions.length);
            }
            this.machine.transitions.push({ source: 'initial', target: main, spec: [], container: this.machine, order: [-1, 0] });
        }
    }

    private convertRegionOf(state: StateNode, region: XmlElement, count: number): void {
        if (count === 1) {
            this.convertRegion(region, state, [...state.itemisPath]);
            return;
        }
        const originalName = region.attributes['name']?.trim() || undefined;
        const name = originalName ? sanitizeName(originalName) : undefined;
        const node: RegionNode = { kind: 'region', name, state, vertices: [], transitions: [], id: region.attributes['xmi:id'] };
        if (originalName && name !== originalName) {
            this.warn(`Region '${originalName}' of '${state.originalName ?? state.name}' was renamed to '${name}'.`);
        }
        state.regions.push(node);
        this.convertRegion(region, node, [...state.itemisPath]);
    }

    private convertRegion(region: XmlElement, container: Container, parentPath: string[]): void {
        const path = [...parentPath, region.attributes['name'] ?? ''];
        for (const vertex of region.children.filter(c => c.name === 'vertices')) {
            const type = vertex.attributes['xsi:type'] ?? '';
            const id = vertex.attributes['xmi:id'] ?? '';
            const name = vertex.attributes['name']?.trim() ?? '';
            switch (type) {
                case 'sgraph:State': {
                    const state = this.createState(name, container, path, vertex);
                    this.vertexById.set(id, state);
                    const documentation = vertex.attributes['documentation'];
                    if (documentation?.trim()) {
                        state.comments.push(...documentation.trim().split(/\r?\n/).map(line => `// ${line.trim()}`.trimEnd()));
                    }
                    if (vertex.attributes['referencedStatechart'] !== undefined || vertex.children.some(c => c.name === 'referencedStatechart')) {
                        state.comments.push(`// TODO import: submachine state (referenced statechart) is not supported`);
                        this.warn(`State '${name}' is a submachine state; referenced statecharts are not supported and were ignored.`);
                    }
                    state.reactions = this.splitReactions(vertex.attributes['specification'] ?? '', name);
                    const regions = vertex.children.filter(c => c.name === 'regions');
                    for (const child of regions) {
                        this.convertRegionOf(state, child, regions.length);
                    }
                    break;
                }
                case 'sgraph:Entry': {
                    const kind = vertex.attributes['kind'];
                    if (kind === 'SHALLOW_HISTORY' || kind === 'DEEP_HISTORY') {
                        this.createPseudo(kind === 'SHALLOW_HISTORY' ? 'history' : 'deephistory', name, container, path, vertex);
                    } else if (!name || name === 'default') {
                        this.implicitById.set(id, { kind: 'initial', container, order: this.orderCounter++, element: vertex });
                    } else {
                        this.createPseudo('entry', name, container, path, vertex);
                    }
                    break;
                }
                case 'sgraph:Exit':
                    this.createPseudo('exit', name, container, path, vertex);
                    break;
                case 'sgraph:Choice':
                    this.createPseudo((vertex.attributes['kind'] ?? '').toLowerCase() === 'static' ? 'junction' : 'choice', name, container, path, vertex);
                    break;
                case 'sgraph:Synchronization':
                    this.createPseudo('sync', name, container, path, vertex);
                    break;
                case 'sgraph:FinalState':
                    this.implicitById.set(id, { kind: 'final', container, order: this.orderCounter++, element: vertex });
                    break;
                default:
                    this.warn(`Vertex of type '${type}' is not supported and was ignored.`);
            }
        }
        const finals = [...this.implicitById.values()].filter(v => v.kind === 'final' && v.container === container);
        if (finals.length > 1) {
            this.warn(`Region '${region.attributes['name'] ?? ''}' has ${finals.length} final states; they were merged into the single final state '[*]' of the region.`);
        }
    }

    private createState(name: string, container: Container, path: string[], element: XmlElement | undefined): StateNode {
        const state: StateNode = {
            kind: 'state', id: element?.attributes['xmi:id'] ?? '', name: '', originalName: name || undefined, container,
            itemisPath: [...path, name], order: this.orderCounter++, element,
            vertices: [], transitions: [], regions: [], reactions: [], comments: []
        };
        container.vertices.push(state);
        this.allVertices.push(state);
        return state;
    }

    private createPseudo(kind: PseudoKind, name: string, container: Container, path: string[], element: XmlElement): PseudoNode {
        const pseudo: PseudoNode = {
            kind, id: element.attributes['xmi:id'] ?? '', name: '', originalName: name || undefined, container,
            itemisPath: [...path, name], order: this.orderCounter++, element
        };
        container.vertices.push(pseudo);
        this.allVertices.push(pseudo);
        this.vertexById.set(pseudo.id, pseudo);
        return pseudo;
    }

    /** Assigns unique, valid names to all vertices (siblings are the vertices of all regions of a state). */
    private assignNames(owner: MachineNode | StateNode): void {
        const siblings = owner.kind === 'state' && owner.regions.length > 0
            ? owner.regions.flatMap(r => r.vertices)
            : owner.vertices;
        const used = new Set<string>();
        for (const vertex of siblings.filter(v => v.originalName)) {
            const original = vertex.originalName!;
            const base = sanitizeName(original);
            vertex.name = uniqueName(base, used);
            if (vertex.name !== original) {
                const what = vertex.kind === 'state' ? 'State' : `${capitalize(vertex.kind)}`;
                this.warn(`${what} '${original}' was renamed to '${vertex.name}'${base === vertex.name ? '' : ' (duplicate name)'}.`);
                if (vertex.kind === 'state') {
                    vertex.description = original;
                }
            }
        }
        for (const vertex of siblings.filter(v => !v.originalName)) {
            const base = vertex.kind === 'state' ? 'State'
                : vertex.kind === 'history' ? 'H'
                    : vertex.kind === 'deephistory' ? 'DH'
                        : capitalize(vertex.kind);
            vertex.name = uniqueName(base, used, vertex.kind !== 'history' && vertex.kind !== 'deephistory');
            if (vertex.kind === 'state') {
                this.warn(`An unnamed state was named '${vertex.name}'.`);
            }
        }
        for (const vertex of siblings) {
            if (vertex.kind === 'state') {
                this.assignNames(vertex);
            }
        }
    }

    // -----------------------------------------------------------------------------------------
    // Transitions

    private buildTransitions(): void {
        const sources: Array<{ element: XmlElement, source: VertexNode | ImplicitVertex, order: number }> = [];
        for (const vertex of this.allVertices) {
            if (vertex.element) {
                sources.push({ element: vertex.element, source: vertex, order: vertex.order });
            }
        }
        for (const implicit of this.implicitById.values()) {
            sources.push({ element: implicit.element, source: implicit, order: implicit.order });
        }
        sources.sort((a, b) => a.order - b.order);

        for (const { element, source, order } of sources) {
            const outgoing = element.children.filter(c => c.name === 'outgoingTransitions');
            if ('kind' in source && source.kind === 'initial' && outgoing.length === 0) {
                this.warn('A default entry without outgoing transition was ignored.');
            }
            if ('kind' in source && source.kind === 'final' && outgoing.length > 0) {
                this.warn('Transitions leaving a final state were ignored.');
                continue;
            }
            const created: TransitionNode[] = [];
            outgoing.forEach((transition, index) => created.push(...this.convertTransition(transition, source, [order, index])));
            this.placeTransitions(source, created);
        }
        for (const t of this.pending) {
            t.container.transitions.push(t);
        }
    }

    private convertTransition(element: XmlElement, source: VertexNode | ImplicitVertex, order: [number, number]): TransitionNode[] {
        const targetId = element.attributes['target'] ?? '';
        const rawSpec = element.attributes['specification'] ?? '';
        let target: VertexNode | 'final' | undefined = this.vertexById.get(targetId);
        let targetContainer: Container | undefined = this.vertexById.get(targetId)?.container;
        const implicitTarget = this.implicitById.get(targetId);
        if (implicitTarget?.kind === 'final') {
            target = 'final';
            targetContainer = implicitTarget.container;
        }
        const sourceName = isVertexNode(source) ? source.name : source.kind === 'initial' ? '[*]' : 'final state';
        if (!target || !targetContainer) {
            this.warn(`The target of a transition leaving '${sourceName}' could not be found (${targetId || 'no target'}); the transition was ignored.`);
            return [];
        }
        const { reaction, entries, exits } = splitEntryExitSpec(rawSpec);
        const spec = this.normalizeReaction(splitLines(reaction), `transition leaving '${sourceName}'`);

        // a transition to a named entry point enters the composite state through the entry point
        let entryPoint: string | undefined;
        if (target !== 'final' && target.kind === 'entry') {
            const entry = target;
            const owner = ownerState(entry.container);
            if (owner) {
                entryPoint = entry.name;
                target = owner;
                targetContainer = owner.container;
            }
        }
        if (entries.length > 0) {
            if (entries.length > 1) {
                this.warn(`Transition '${sourceName}' -> '${targetName(target)}' selects several entry points (${entries.join(', ')}); only '${entries[0]}' was kept.`);
            }
            const history = this.namedHistory(target, entries[0]);
            if (history) {
                // itemis CREATE can enter a state through a named history entry: HSM targets the history pseudo state
                target = history;
                targetContainer = history.container;
            } else if (entries[0] !== 'default' && this.namedPoints(target, 'entry').some(p => p.originalName === entries[0])) {
                entryPoint = this.resolvePointName(target, 'entry', entries[0]);
            } else if (entries[0] !== 'default') {
                this.warn(`'${targetName(target)}' has no entry point named '${entries[0]}'; the transition from '${sourceName}' enters it by default (like itemis CREATE).`);
            }
        }

        let exitPoints: Array<string | undefined> = [undefined];
        if (isVertexNode(source) && source.kind === 'state') {
            if (exits.length > 0) {
                exitPoints = exits.flatMap(name => name === 'default'
                    ? this.unnamedPoints(source, 'exit')
                    : [this.resolvePointName(source, 'exit', name)]);
                if (exits.length > 1) {
                    this.warn(`Transition '${source.name}' -> '${targetName(target)}' handles several exit nodes (${exits.join(', ')}); it was duplicated for each exit node.`);
                }
            } else {
                const defaultExits = this.unnamedPoints(source, 'exit');
                if (defaultExits.length > 0 && !hasTrigger(reaction)) {
                    exitPoints = defaultExits;
                    if (defaultExits.length > 1) {
                        this.warn(`Transition '${source.name}' -> '${targetName(target)}' handles several default exits; it was duplicated for each exit node.`);
                    }
                }
            }
        } else if (exits.length > 0) {
            this.warn(`Exit node specification '# ${exits.join('> ')}>' on a transition leaving '${sourceName}' was ignored.`);
        }

        let container: Container;
        let transitionSource: VertexNode | 'initial';
        if (isVertexNode(source)) {
            transitionSource = source;
            container = target === 'final' ? targetContainer : commonContainer(source.container, targetContainer);
        } else if (source.kind === 'initial') {
            transitionSource = 'initial';
            container = source.container;
            if (target === 'final') {
                this.warn('A transition from a default entry directly to a final state was ignored.');
                return [];
            }
        } else {
            return [];
        }
        const elementId = element.attributes['xmi:id'];
        return exitPoints.map(exitPoint => ({
            source: transitionSource, target: target!, spec, entryPoint, exitPoint, container, order, elementId
        }));
    }

    /**
     * Places the transitions leaving one vertex. Transitions are declared in the innermost container
     * containing source and target. If the transitions of one vertex end up in different containers,
     * they are all moved to the outermost of them, so that their text order (= priority) is kept.
     */
    private placeTransitions(source: VertexNode | ImplicitVertex, transitions: TransitionNode[]): void {
        const movable = transitions.filter(t => t.target !== 'final' && t.source !== 'initial');
        if (movable.length > 1 && new Set(movable.map(t => t.container)).size > 1) {
            const outermost = movable.map(t => t.container).reduce((a, b) => depth(a) <= depth(b) ? a : b);
            for (const t of movable) {
                t.container = outermost;
            }
        }
        if (new Set(transitions.map(t => t.container)).size > 1 && isVertexNode(source)) {
            this.warn(`The transitions leaving '${source.name}' are declared in different containers; their priority order may differ from the itemis model.`);
        }
        this.pending.push(...transitions);
    }

    private namedPoints(state: VertexNode | 'final', kind: 'entry' | 'exit'): PseudoNode[] {
        if (state === 'final' || state.kind !== 'state') {
            return [];
        }
        const children = state.regions.length > 0 ? state.regions.flatMap(r => r.vertices) : state.vertices;
        return children.filter((v): v is PseudoNode => v.kind === kind);
    }

    private namedHistory(state: VertexNode | 'final', name: string): PseudoNode | undefined {
        if (state === 'final' || state.kind !== 'state') {
            return undefined;
        }
        const children = state.regions.length > 0 ? state.regions.flatMap(r => r.vertices) : state.vertices;
        return children.find((v): v is PseudoNode => (v.kind === 'history' || v.kind === 'deephistory') && v.originalName === name);
    }

    private unnamedPoints(state: StateNode, kind: 'entry' | 'exit'): string[] {
        return this.namedPoints(state, kind).filter(p => !p.originalName).map(p => p.name);
    }

    /** Maps the name of an entry point / exit node used in a transition specification to its HSM name. */
    private resolvePointName(state: VertexNode | 'final', kind: 'entry' | 'exit', name: string): string {
        const matches = this.namedPoints(state, kind).filter(p => p.originalName === name);
        if (matches.length === 0) {
            this.warn(`'${targetName(state)}' has no ${kind === 'entry' ? 'entry point' : 'exit node'} named '${name}'.`);
            return sanitizeName(name);
        }
        if (matches.length > 1) {
            this.warn(`'${targetName(state)}' has ${matches.length} ${kind === 'entry' ? 'entry points' : 'exit nodes'} named '${name}' (in different regions); HSM uses only '${matches[0].name}' for '# ${kind === 'entry' ? '>' + name : name + '>'}'.`);
        }
        return matches[0].name;
    }

    // -----------------------------------------------------------------------------------------
    // Reactions

    /** Splits the specification of a state into local reactions. */
    private splitReactions(specification: string, stateName: string): string[][] {
        const reactions: string[][] = [];
        let current: string[] | undefined;
        let pendingComments: string[] = [];
        let depthLevel = 0;
        let inEffect = false;
        for (const line of splitLines(specification)) {
            const { code, comment } = splitComment(line);
            if (!code.trim()) {
                if (comment) {
                    if (current) {
                        current.push(line.trim());
                    } else {
                        pendingComments.push(line.trim());
                    }
                }
                continue;
            }
            if (current && inEffect && depthLevel === 0 && isReactionStart(code)) {
                reactions.push(current);
                current = undefined;
            }
            if (!current) {
                current = [...pendingComments];
                pendingComments = [];
                depthLevel = 0;
                inEffect = false;
            }
            current.push(line);
            const scan = scanCode(code, depthLevel, inEffect);
            depthLevel = scan.depth;
            inEffect = scan.inEffect;
        }
        if (current) {
            reactions.push(current);
        }
        if (pendingComments.length > 0) {
            reactions.push(pendingComments);
        }
        return reactions.map(lines => this.normalizeReaction(lines, `state '${stateName}'`));
    }

    /**
     * Normalizes the lines of one reaction: statements of multi-line effects are separated by `;`,
     * Returns one line if the reaction has no comments.
     */
    private normalizeReaction(lines: string[], location: string): string[] {
        const parts: Array<{ code: string, comment: string }> = [];
        let depthLevel = 0;
        let inEffect = false;
        for (const line of lines) {
            const split = splitComment(line);
            let code = mapCode(split.code, text => convertNumbers(text));
            const trimmed = code.trim();
            const previous = [...parts].reverse().find(p => p.code.trim());
            if (trimmed && previous && depthLevel === 0 && inEffect && needsSemicolon(previous.code, trimmed)) {
                previous.code = previous.code.trimEnd() + ';';
            }
            if (trimmed) {
                const scan = scanCode(code, depthLevel, inEffect);
                depthLevel = scan.depth;
                inEffect = scan.inEffect;
            }
            code = trimmed;
            parts.push({ code, comment: split.comment.trim() });
        }
        // code lines are joined, a line comment ends a line
        const result: string[] = [];
        let current = '';
        for (const part of parts) {
            if (part.code) {
                current = current ? `${current} ${part.code}` : part.code;
            }
            if (part.comment) {
                result.push(current ? `${current} ${part.comment}` : part.comment);
                current = '';
            }
        }
        if (current) {
            result.push(current);
        }
        return result;
    }

    // -----------------------------------------------------------------------------------------
    // Definition section

    private convertSpecification(specification: string, namespaceAttribute: string | undefined): string[] {
        const lines = splitLines(specification).map(line => line.trimEnd());
        let namespace: string | undefined;
        const preamble: string[] = [];
        const movedAnnotations: string[] = [];
        const scopes: string[] = [];
        const machineReactions: string[] = [];
        let inScope = false;
        let inImport = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (/^namespace\s+/.test(trimmed)) {
                namespace = trimmed;
                continue;
            }
            if (/^import\s*:/.test(trimmed) || (inImport && /^"[^"]*"$/.test(trimmed))) {
                inImport = true;
                this.warn(`Imports are not supported: '${trimmed}' was commented out.`);
                (inScope ? scopes : preamble).push(`// TODO import: ${trimmed}`);
                continue;
            }
            inImport = false;
            let converted = mapCode(trimmed, convertNumbers);
            if (/^@(SuperSteps|EventBuffering)\b/.test(trimmed)) {
                this.warn(`The annotation '${trimmed}' is not supported and was commented out.`);
                converted = `// TODO import: ${trimmed}`;
            }
            if (SCOPE_HEADER.test(trimmed)) {
                inScope = true;
                scopes.push(trimmed);
            } else if (!inScope) {
                preamble.push(converted);
            } else if (trimmed.startsWith('@')) {
                movedAnnotations.push(converted);
            } else if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*')
                && !DECLARATION_START.test(trimmed) && isReactionStart(splitComment(trimmed).code)) {
                // local reactions of the statechart itself are placed after the definition section
                machineReactions.push(...this.normalizeReaction([trimmed], 'the statechart'));
            } else {
                if (/^alias\b/.test(trimmed)) {
                    this.warn(`Type aliases are not supported: '${trimmed}'.`);
                }
                scopes.push(trimmed ? this.indentUnit + converted : '');
            }
        }
        if (!namespace && namespaceAttribute?.trim()) {
            namespace = `namespace ${namespaceAttribute.trim()}`;
        }
        const result = [...(namespace ? [namespace, ''] : []), ...preamble, ...movedAnnotations, '', ...scopes,
            ...(machineReactions.length > 0 ? ['', ...machineReactions] : [])];
        return trimBlankLines(collapseBlankLines(result));
    }

    // -----------------------------------------------------------------------------------------
    // Output

    private emitBody(container: Container, level: number): string[] {
        const indent = this.indentUnit.repeat(level);
        const lines: string[] = [];
        const initials = container.transitions.filter(t => t.source === 'initial');
        const others = container.transitions.filter(t => t.source !== 'initial')
            .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
        for (const t of initials) {
            lines.push(...this.emitTransition(t, indent));
        }
        if (initials.length > 0) {
            lines.push('');
        }
        for (const vertex of container.vertices) {
            if (vertex.kind === 'state') {
                const state = this.emitState(vertex, level);
                if (state.length > 1) {
                    lines.push('');
                }
                lines.push(...state);
                if (state.length > 1) {
                    lines.push('');
                }
            } else {
                lines.push(`${indent}${vertex.kind} ${vertex.name}`);
            }
        }
        if (others.length > 0) {
            lines.push('');
        }
        for (const t of others) {
            lines.push(...this.emitTransition(t, indent));
        }
        return trimBlankLines(collapseBlankLines(lines));
    }

    private emitState(state: StateNode, level: number): string[] {
        const indent = this.indentUnit.repeat(level);
        const inner = indent + this.indentUnit;
        const header = `${indent}state ${state.name}${state.description !== undefined ? ' ' + quote(state.description) : ''}`;
        const body: string[] = [];
        for (const reaction of state.reactions) {
            const rewritten = this.rewriteReaction(reaction, state);
            let continued = false;
            for (const line of rewritten) {
                body.push((continued && !line.startsWith('//') ? inner + this.indentUnit : inner) + line);
                continued ||= splitComment(line).code.trim() !== '';
            }
        }
        if (state.regions.length > 0) {
            for (const region of state.regions) {
                body.push('');
                body.push(`${inner}region${region.name ? ' ' + region.name : ''} {`);
                body.push(...this.emitBody(region, level + 2));
                body.push(`${inner}}`);
            }
            const transitions = this.emitBody({ ...state, vertices: [], regions: [] }, level + 1);
            if (transitions.length > 0) {
                body.push('', ...transitions);
            }
        } else {
            const children = this.emitBody(state, level + 1);
            if (children.length > 0 && body.length > 0) {
                body.push('');
            }
            body.push(...children);
        }
        const comments = state.comments.map(c => indent + c);
        if (body.length === 0) {
            return [...comments, header];
        }
        return [...comments, header + ' {', ...trimBlankLines(body), `${indent}}`];
    }

    private emitTransition(t: TransitionNode, indent: string): string[] {
        const source = t.source === 'initial' ? '[*]' : this.referenceName(t.source, t.container);
        const target = t.target === 'final' ? '[*]' : this.referenceName(t.target, t.container);
        const spec = this.rewriteReaction(t.spec, t.container);
        const suffix = t.entryPoint ? ` # >${t.entryPoint}` : t.exitPoint ? ` # ${t.exitPoint}>` : '';
        if (spec.length === 0) {
            return [`${indent}${source} -> ${target}${suffix}`];
        }
        // a specification which consists of comments only must not produce an empty ': '
        const colon = spec.some(line => splitComment(line).code.trim()) ? ' : ' : ' ';
        const lines = spec.map((line, i) => i === 0 ? `${indent}${source} -> ${target}${colon}${line}` : `${indent}${this.indentUnit}${line}`);
        if (suffix) {
            // an entry / exit specification must not end up in a trailing line comment
            if (splitComment(lines[lines.length - 1]).comment) {
                lines.push(`${indent}${this.indentUnit}${suffix.trim()}`);
            } else {
                lines[lines.length - 1] += suffix;
            }
        }
        return lines;
    }

    /** Rewrites the state references of `active(...)` expressions (itemis: fully qualified including region names). */
    private rewriteReaction(lines: string[], context: Container): string[] {
        return lines.map(line => mapCode(line, code => code.replace(/\bactive\s*\(\s*([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\)/g, (match, reference: string) => {
            const segments = reference.split('.').map(s => s.trim());
            const vertex = this.resolveItemisReference(segments);
            if (!vertex) {
                this.warn(`The state '${segments.join('.')}' referenced in 'active(...)' could not be found.`);
                return match;
            }
            return `active(${this.referenceName(vertex, context)})`;
        })));
    }

    private resolveItemisReference(segments: string[]): VertexNode | undefined {
        const states = this.allVertices.filter(v => v.kind === 'state' && v.id);
        const statePath = (v: VertexNode) => v.itemisPath.filter((_, i) => i % 2 === 1);
        // names with spaces cannot be used in itemis expressions: compare them with `_` instead of spaces
        const normalize = (name: string) => name.trim().replace(/[^A-Za-z0-9_]+/g, '_');
        const equals = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => normalize(s) === normalize(b[i]));
        const endsWith = (path: string[], suffix: string[]) => suffix.length <= path.length && equals(path.slice(path.length - suffix.length), suffix);
        const withoutMachine = normalize(segments[0]) === normalize(this.statechartName) && segments.length > 1 ? segments.slice(1) : segments;
        const strategies: Array<(v: VertexNode) => boolean> = [
            v => equals(v.itemisPath, withoutMachine),
            v => equals(statePath(v), withoutMachine),
            v => endsWith(v.itemisPath, segments),
            v => endsWith(statePath(v), segments)
        ];
        for (const strategy of strategies) {
            const matches = states.filter(strategy);
            if (matches.length === 1) {
                return matches[0];
            }
        }
        return undefined;
    }

    /** The shortest name which resolves to `vertex` from `context` (same rules as the HSM scope provider). */
    private referenceName(vertex: VertexNode, context: Container): string {
        const segments = qualifiedSegments(vertex);
        for (let i = segments.length - 1; i >= 0; i--) {
            const candidate = segments.slice(i).join('.');
            if (this.resolve(candidate, context) === vertex) {
                return candidate;
            }
        }
        return segments.join('.');
    }

    private resolve(name: string, context: Container): VertexNode | undefined {
        let current: Container | undefined = context;
        while (current) {
            let found: VertexNode | undefined;
            collectVertices(current, [], (vertex, path) => {
                if (!found && path === name) {
                    found = vertex;
                }
            });
            if (found) {
                return found;
            }
            current = parentContainer(current);
        }
        const candidates = new Map<string, VertexNode[]>();
        collectVertices(this.machine, [], (vertex, path) => {
            const segments = path.split('.');
            for (let i = 1; i < segments.length; i++) {
                const suffix = segments.slice(i).join('.');
                candidates.set(suffix, [...(candidates.get(suffix) ?? []), vertex]);
            }
        });
        const matches = candidates.get(name);
        return matches?.length === 1 ? matches[0] : undefined;
    }
}

// ---------------------------------------------------------------------------------------------
// Helpers for the intermediate model

function isVertexNode(value: unknown): value is VertexNode {
    return typeof value === 'object' && value !== null && 'itemisPath' in value;
}

function targetName(target: VertexNode | 'final'): string {
    return target === 'final' ? '[*]' : target.name;
}

function parentContainer(container: Container): Container | undefined {
    switch (container.kind) {
        case 'machine': return undefined;
        case 'region': return container.state;
        case 'state': return container.container;
    }
}

/** The state owning the given container (for entry points and exit nodes). */
function ownerState(container: Container): StateNode | undefined {
    return container.kind === 'region' ? container.state : container.kind === 'state' ? container : undefined;
}

function containerPath(container: Container): Container[] {
    const path: Container[] = [];
    for (let current: Container | undefined = container; current; current = parentContainer(current)) {
        path.unshift(current);
    }
    return path;
}

function depth(container: Container): number {
    return containerPath(container).length;
}

function commonContainer(a: Container, b: Container): Container {
    const pathA = containerPath(a);
    const pathB = containerPath(b);
    let result = pathA[0];
    for (let i = 0; i < Math.min(pathA.length, pathB.length) && pathA[i] === pathB[i]; i++) {
        result = pathA[i];
    }
    return result;
}

function collectVertices(container: Container, prefix: string[], accept: (vertex: VertexNode, path: string) => void): void {
    for (const vertex of container.vertices) {
        const path = [...prefix, vertex.name];
        accept(vertex, path.join('.'));
        if (vertex.kind === 'state') {
            collectVertices(vertex, path, accept);
            for (const region of vertex.regions) {
                collectVertices(region, path, accept);
            }
        }
    }
}

function qualifiedSegments(vertex: VertexNode): string[] {
    const names = [vertex.name];
    for (let current: Container | undefined = vertex.container; current && current.kind !== 'machine'; current = parentContainer(current)) {
        if (current.kind === 'state') {
            names.unshift(current.name);
        }
    }
    return names;
}

// ---------------------------------------------------------------------------------------------
// Names

/** Converts an itemis name into a valid HSM identifier (`Door Open` -> `Door_Open`, `entry` -> `entry_`). */
export function sanitizeName(name: string): string {
    let result = name.trim().replace(/[^A-Za-z0-9_]+/g, '_');
    if (result === '' || /^_+$/.test(result) && name.trim() !== result) {
        return '';
    }
    if (/^[0-9]/.test(result)) {
        result = '_' + result;
    }
    if (HSM_KEYWORDS.has(result)) {
        result += '_';
    }
    return result;
}

function uniqueName(base: string, used: Set<string>, alwaysNumber = false): string {
    const separator = alwaysNumber || base.endsWith('_') ? '' : '_';
    let name = alwaysNumber ? `${base}1` : base;
    for (let i = 2; used.has(name); i++) {
        name = `${base}${separator}${i}`;
    }
    used.add(name);
    return name;
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.substring(1);
}

function quote(value: string): string {
    return JSON.stringify(value);
}

// ---------------------------------------------------------------------------------------------
// Text helpers

function splitLines(text: string): string[] {
    return text.replace(/\r\n?/g, '\n').split('\n');
}

function collapseBlankLines(lines: string[]): string[] {
    return lines.filter((line, i) => line.trim() !== '' || (i > 0 && lines[i - 1].trim() !== ''))
        .map(line => line.trim() === '' ? '' : line);
}

function trimBlankLines(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;
    while (start < end && !lines[start].trim()) {
        start++;
    }
    while (end > start && !lines[end - 1].trim()) {
        end--;
    }
    return lines.slice(start, end);
}

/** Splits a line into code and a trailing `//` comment (strings are respected). */
function splitComment(line: string): { code: string, comment: string } {
    let quoteChar: string | undefined;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoteChar) {
            if (c === '\\') {
                i++;
            } else if (c === quoteChar) {
                quoteChar = undefined;
            }
        } else if (c === '"' || c === '\'') {
            quoteChar = c;
        } else if (c === '/' && line[i + 1] === '/') {
            return { code: line.substring(0, i), comment: line.substring(i) };
        }
    }
    return { code: line, comment: '' };
}

/** Applies `code` to the parts of the text outside of string literals and comments (`other` to the rest). */
function mapCode(text: string, code: (text: string) => string, other: (text: string) => string = t => t): string {
    let result = '';
    let start = 0;
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        let end = -1;
        if (c === '"' || c === '\'') {
            end = i + 1;
            while (end < text.length && text[end] !== c) {
                end += text[end] === '\\' ? 2 : 1;
            }
            end = Math.min(end + 1, text.length);
        } else if (c === '/' && text[i + 1] === '/') {
            const newline = text.indexOf('\n', i);
            end = newline < 0 ? text.length : newline;
        } else if (c === '/' && text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2);
            end = close < 0 ? text.length : close + 2;
        }
        if (end >= 0) {
            result += code(text.substring(start, i)) + other(text.substring(i, end));
            start = end;
            i = end;
        } else {
            i++;
        }
    }
    return result + code(text.substring(start));
}

/** Updates the bracket depth and whether the effect (`/`) of a reaction has started. */
function scanCode(code: string, depthLevel: number, inEffect: boolean): { depth: number, inEffect: boolean } {
    mapCode(code, text => {
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (c === '(' || c === '[') {
                depthLevel++;
            } else if (c === ')' || c === ']') {
                depthLevel = Math.max(0, depthLevel - 1);
            } else if (c === '/' && depthLevel === 0 && text[i + 1] !== '=' && text[i + 1] !== '/' && text[i - 1] !== '/') {
                inEffect = true;
            }
        }
        return text;
    });
    return { depth: depthLevel, inEffect };
}

/** Index of the first top-level `/` which separates trigger and guard from the effect (-1 if none). */
function effectStart(code: string): number {
    let level = 0;
    let index = -1;
    let offset = 0;
    mapCode(code, text => {
        for (let i = 0; i < text.length && index < 0; i++) {
            const c = text[i];
            if (c === '(' || c === '[') {
                level++;
            } else if (c === ')' || c === ']') {
                level--;
            } else if (c === '/' && level === 0 && text[i + 1] !== '=' && text[i + 1] !== '/' && text[i - 1] !== '/') {
                index = offset + i;
            }
        }
        offset += text.length;
        return text;
    }, text => {
        offset += text.length;
        return text;
    });
    return index;
}

/**
 * Whether the line starts a new reaction: `triggers [guard] / ...`, or `triggers [guard...` with a guard
 * which is continued on the next line.
 */
function isReactionStart(code: string): boolean {
    const slash = effectStart(code);
    if (slash >= 0) {
        const prefix = code.substring(0, slash);
        return prefix.trim() !== '' && REACTION_PREFIX.test(prefix);
    }
    const bracket = code.indexOf('[');
    return bracket >= 0 && scanCode(code, 0, false).depth > 0 && REACTION_PREFIX.test(code.substring(0, bracket));
}

/** Whether the reaction text has a trigger (text before the guard / effect). */
function hasTrigger(reaction: string): boolean {
    const code = mapCode(reaction, t => t, t => ' '.repeat(t.length));
    const slash = effectStart(code);
    const bracket = code.indexOf('[');
    const ends = [slash, bracket].filter(i => i >= 0);
    const end = ends.length > 0 ? Math.min(...ends) : code.length;
    return code.substring(0, end).trim() !== '';
}

/** Removes the type suffixes of itemis number literals (`1.5f`, `2.0d`, `10l`), which HSM does not support. */
function convertNumbers(code: string): string {
    return code.replace(/\b(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[fFdDlL]\b/g, '$1');
}

function needsSemicolon(previous: string, next: string): boolean {
    const prev = previous.trimEnd();
    if (!prev || /[;/,([{+\-*%&|^=<>!?:]$/.test(prev)) {
        return false;
    }
    return !/^[)\]}.+\-*/%&|^=<>?:;,]/.test(next);
}


/**
 * Splits the `# >entry` / `# exit>` part off a transition specification.
 * itemis CREATE allows several of them, e.g. `# ex1 > ex2 >`.
 */
function splitEntryExitSpec(specification: string): { reaction: string, entries: string[], exits: string[] } {
    let hash = -1;
    let offset = 0;
    mapCode(specification, text => {
        const index = text.indexOf('#');
        if (hash < 0 && index >= 0) {
            hash = offset + index;
        }
        offset += text.length;
        return text;
    }, text => {
        offset += text.length;
        return text;
    });
    if (hash < 0) {
        return { reaction: specification.trim(), entries: [], exits: [] };
    }
    const entries: string[] = [];
    const exits: string[] = [];
    const tokens = specification.substring(hash + 1).match(/>|[A-Za-z_]\w*/g) ?? [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === '>' && tokens[i + 1] && tokens[i + 1] !== '>') {
            entries.push(tokens[++i]);
        } else if (tokens[i] !== '>' && tokens[i + 1] === '>') {
            exits.push(tokens[i++]);
        }
    }
    return { reaction: specification.substring(0, hash).trim(), entries, exits };
}

// ---------------------------------------------------------------------------------------------
// Layout (notation model)

/** Height of the name of a top-level region in itemis CREATE (above its compartment). */
const ITEMIS_REGION_HEADER = 20;
/** Size assumed for itemis shapes without explicit size (used for bend points only). */
const ITEMIS_DEFAULT_SIZE = { state: { width: 80, height: 50 }, pseudo: { width: 15, height: 15 } };

interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Converts the `notation:Diagram` of an `.sct` file into a manual layout. Shapes in itemis CREATE are
 * positioned relative to the compartment of their region; in HSM relative to their composite state
 * (or region), below its name. The positions are therefore offset by the padding of the container;
 * the layout engine moves the content further down if the state has a taller body compartment.
 * Bend points are imported for transitions between vertices of the same container.
 */
class NotationImporter {

    private readonly layout = createManualLayout('manual', 'DOWN');
    /** semantic `xmi:id` -> notation view */
    private readonly views = new Map<string, XmlElement>();
    /** diagram id -> container diagram id, itemis bounds and offset of the container */
    private readonly placed = new Map<string, { parent: string, bounds: Bounds, offset: Point, pseudo: boolean }>();

    constructor(
        private readonly machine: MachineNode,
        private readonly implicit: Map<string, ImplicitVertex>,
        private readonly topRegions: XmlElement[]
    ) { }

    run(root: XmlElement): ManualLayout | undefined {
        const diagram = root.children.find(c => c.name === 'notation:Diagram');
        if (!diagram) {
            return undefined;
        }
        const collect = (element: XmlElement) => {
            for (const child of element.children) {
                if (child.name === 'children' && child.attributes['element']) {
                    this.views.set(child.attributes['element'], child);
                }
                collect(child);
            }
        };
        collect(diagram);

        const text = diagram.children.find(c => c.name === 'children' && c.attributes['type'] === 'StatechartText');
        const textBounds = text && boundsOf(text);
        if (textBounds) {
            this.layout.nodes[DEFINITION_ID] = { x: textBounds.x, y: textBounds.y };
        }
        const regionBounds = this.topRegions.map(r => boundsOf(this.views.get(r.attributes['xmi:id'] ?? '')));
        if (this.topRegions.length === 1) {
            const bounds = regionBounds[0] ?? { x: 0, y: 0, width: -1, height: -1 };
            this.placeContent(this.machine, MACHINE_ID, { x: bounds.x, y: bounds.y + ITEMIS_REGION_HEADER });
        } else if (this.topRegions.length > 1) {
            // the regions were wrapped into a generated composite state
            const main = this.machine.vertices.find((v): v is StateNode => v.kind === 'state' && !v.element);
            const known = regionBounds.filter((b): b is Bounds => b !== undefined);
            if (main && known.length > 0) {
                const x = Math.min(...known.map(b => b.x));
                const y = Math.min(...known.map(b => b.y));
                const spreadX = Math.max(...known.map(b => b.x)) - x;
                const spreadY = Math.max(...known.map(b => b.y)) - y;
                this.layout.nodes[main.name] = { x, y, regions: spreadX > spreadY ? 'horizontal' : 'vertical' };
                main.regions.forEach((region, index) => {
                    const bounds = regionBounds[index];
                    const id = `${main.name}#region${index + 1}`;
                    if (bounds && bounds.width > 0 && bounds.height > 0) {
                        this.layout.nodes[id] = { x: 0, y: 0, width: bounds.width, height: bounds.height };
                    }
                    this.placeContent(region, id, this.regionOffset(region));
                });
            }
        }
        this.importBendPoints(diagram);
        return Object.keys(this.layout.nodes).length > 0 ? this.layout : undefined;
    }

    private regionOffset(region: RegionNode): Point {
        const pad = DiagramMetrics.regionPadding;
        return { x: pad, y: pad + (region.name ? DiagramMetrics.lineHeight.body : 0) };
    }

    /** Stores the positions of the vertices of a container (relative to the container in HSM). */
    private placeContent(container: Container, containerId: string, offset: Point): void {
        for (const vertex of container.vertices) {
            const bounds = boundsOf(this.views.get(vertex.id));
            if (!bounds || !vertex.id) {
                continue;
            }
            const id = diagramId(vertex);
            const entry: NodeLayout = { x: bounds.x + offset.x, y: bounds.y + offset.y };
            if (vertex.kind === 'state' && bounds.width > 0 && bounds.height > 0) {
                entry.width = bounds.width;
                entry.height = bounds.height;
            }
            this.layout.nodes[id] = entry;
            this.placed.set(id, { parent: containerId, bounds, offset, pseudo: vertex.kind !== 'state' });
            if (vertex.kind !== 'state') {
                continue;
            }
            if (vertex.regions.length > 0) {
                const horizontal = this.views.get(vertex.id)?.children.some(c => c.name === 'styles'
                    && c.attributes['name'] === 'isHorizontal' && c.attributes['booleanValue'] === 'true');
                entry.regions = horizontal ? 'horizontal' : 'vertical';
                vertex.regions.forEach((region, index) => this.placeContent(region, `${id}#region${index + 1}`, this.regionOffset(region)));
            } else if (vertex.vertices.length > 0) {
                const m = DiagramMetrics;
                this.placeContent(vertex, id, { x: m.compositePadding, y: m.headerHeight + m.compositePadding });
            }
        }
        let final = false;
        for (const [viewId, vertex] of this.implicit) {
            if (vertex.container !== container || (vertex.kind === 'final' && final)) {
                continue;
            }
            const bounds = boundsOf(this.views.get(viewId));
            if (!bounds) {
                continue;
            }
            final ||= vertex.kind === 'final';
            const id = `${containerId}#${vertex.kind}`;
            this.layout.nodes[id] = { x: bounds.x + offset.x, y: bounds.y + offset.y };
            this.placed.set(id, { parent: containerId, bounds, offset, pseudo: true });
        }
    }

    /**
     * Bend points of transitions between vertices of the same container. In the notation model they are
     * stored relative to the anchor points of source and target (GMF `RelativeBendpoints`); the average
     * of both is used since the exact sizes of the itemis shapes are often unknown.
     */
    private importBendPoints(diagram: XmlElement): void {
        const edgeViews = new Map<string, XmlElement>();
        for (const edge of diagram.children.filter(c => c.name === 'edges')) {
            if (edge.attributes['element']) {
                edgeViews.set(edge.attributes['element'], edge);
            }
        }
        const counts = new Map<string, number>();
        const visit = (container: Container) => {
            const initials = container.transitions.filter(t => t.source === 'initial');
            const others = container.transitions.filter(t => t.source !== 'initial').sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
            for (const transition of [...initials, ...others]) {
                const source = transition.source === 'initial' ? `${containerId(transition.container)}#initial` : diagramId(transition.source);
                const target = transition.target === 'final' ? `${containerId(transition.container)}#final` : diagramId(transition.target);
                const base = `${source}->${target}`;
                const count = counts.get(base) ?? 0;
                counts.set(base, count + 1);
                const id = count === 0 ? base : `${base}~${count}`;
                const view = transition.elementId ? edgeViews.get(transition.elementId) : undefined;
                if (view && !transition.entryPoint && !transition.exitPoint) {
                    this.importEdge(id, source, target, view);
                }
            }
            for (const vertex of container.vertices) {
                if (vertex.kind === 'state') {
                    visit(vertex);
                    vertex.regions.forEach(visit);
                }
            }
        };
        visit(this.machine);
    }

    private importEdge(id: string, sourceId: string, targetId: string, view: XmlElement): void {
        const source = this.placed.get(sourceId);
        const target = this.placed.get(targetId);
        const bendpoints = view.children.find(c => c.name === 'bendpoints')?.attributes['points'] ?? '';
        const relative = [...bendpoints.matchAll(/\[([^\]]*)\]/g)].map(m => m[1].split(',').map(v => Number(v.trim())));
        if (!source || !target || source.parent !== target.parent || relative.length < 3
            || relative.some(p => p.length !== 4 || p.some(v => !Number.isFinite(v)))) {
            return;
        }
        const sourceRef = anchorPoint(source.bounds, source.pseudo, view.children.find(c => c.name === 'sourceAnchor'));
        const targetRef = anchorPoint(target.bounds, target.pseudo, view.children.find(c => c.name === 'targetAnchor'));
        const offset = source.offset;
        const bends = relative.slice(1, -1).map(([sx, sy, tx, ty]) => ({
            x: (sourceRef.x + sx + targetRef.x + tx) / 2 + offset.x,
            y: (sourceRef.y + sy + targetRef.y + ty) / 2 + offset.y
        }));
        this.layout.edges[id] = { bends };
    }
}

function boundsOf(view: XmlElement | undefined): Bounds | undefined {
    const constraint = view?.children.find(c => c.name === 'layoutConstraint' && c.attributes['xsi:type'] === 'notation:Bounds');
    if (!constraint) {
        return undefined;
    }
    const number = (name: string, fallback: number) => {
        const value = Number(constraint.attributes[name]);
        return constraint.attributes[name] !== undefined && Number.isFinite(value) ? value : fallback;
    };
    return { x: number('x', 0), y: number('y', 0), width: number('width', -1), height: number('height', -1) };
}

/** The reference point of a transition end in itemis coordinates (IdentityAnchor `(fx,fy)` or the center). */
function anchorPoint(bounds: Bounds, pseudo: boolean, anchor: XmlElement | undefined): Point {
    const defaults = pseudo ? ITEMIS_DEFAULT_SIZE.pseudo : ITEMIS_DEFAULT_SIZE.state;
    const width = bounds.width > 0 ? bounds.width : defaults.width;
    const height = bounds.height > 0 ? bounds.height : defaults.height;
    const match = /^\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*\)$/.exec(anchor?.attributes['id'] ?? '');
    const fx = match ? Number(match[1]) : 0.5;
    const fy = match ? Number(match[2]) : 0.5;
    return { x: bounds.x + width * fx, y: bounds.y + height * fy };
}

/** Id of a vertex in the HSM diagram: its qualified name. */
function diagramId(vertex: VertexNode): string {
    return qualifiedSegments(vertex).join('.');
}

/** Id of a container in the HSM diagram (`#machine`, a state or `<state>#region<n>`). */
function containerId(container: Container): string {
    switch (container.kind) {
        case 'machine': return MACHINE_ID;
        case 'state': return diagramId(container);
        case 'region': return `${diagramId(container.state)}#region${container.state.regions.indexOf(container) + 1}`;
    }
}
