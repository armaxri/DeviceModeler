import { AstUtils, GrammarUtils, type AstNode, type LangiumCoreServices } from 'langium';
import * as ast from '../generated/ast.js';
import { visibleElements } from '../dmf-imports.js';
import { enclosingStructure, isCompositeType, structureInstances, threadInstances, threadOf } from '../dmf-model.js';
import { portIncompatibilities } from '../dmf-types.js';
import { BUILTIN_TYPES } from '../hsm-typesystem.js';
import { EditError, mapOffset, quote, type EditResult, type TextEdit } from './model-edits.js';

/*
 * Text edits of structure files (`.dmf`): the graphical editing of the internal block diagram. Like the
 * ModelEditor of the state machines (model-edits.ts), every diagram operation becomes a minimal text
 * change that keeps comments and the formatting of the unaffected parts; new text follows the style of
 * the formatter (dmf-formatter.ts): one member per line, bodies indented, annotations of threads on the
 * line before the thread.
 */

/** Keywords of the structure language (not allowed as names). */
export const DMF_KEYWORDS: ReadonlySet<string> = new Set([
    'package', 'import', 'struct', 'interface', 'event', 'component', 'behavior', 'subsystem', 'system',
    'provides', 'requires', 'sync', 'async', 'thread', 'connect', 'delegate'
]);

const ID_REGEX = /^[_a-zA-Z]\w*$/;

/** Whether the name is a valid name of an element of a structure file (identifier, no keyword, no built-in type). */
export function isValidDmfName(name: string): boolean {
    return ID_REGEX.test(name) && !DMF_KEYWORDS.has(name) && !(BUILTIN_TYPES as readonly string[]).includes(name);
}

/** Checks a new name; throws an {@link EditError} with a message for the user. */
export function checkDmfName(name: string): void {
    if (!isValidDmfName(name)) {
        throw new EditError(`'${name}' is not a valid name. Use letters, digits and '_' (no keywords or built-in type names).`);
    }
}

/** A port seen in a structure: a port of a part (`instance`) or a boundary port of the structure. */
export interface DmfPortEnd {
    instance?: ast.ComponentInstance;
    port: ast.Port;
}

/** How two ports chosen in the diagram are connected (see {@link planConnection}). */
export interface ConnectionPlan {
    kind: 'connect' | 'delegate';
    /** The end written first (the required side of a connection, see docs/structure-language.md). */
    source: DmfPortEnd;
    target: DmfPortEnd;
    /** The ports were chosen in the opposite order (the ends were swapped). */
    swapped: boolean;
    /** The statement: `connect door.motor -> drive.ctrl`. */
    text: string;
    /** Incompatibilities of the ports (kinds, events, types), empty if they are compatible. */
    problems: string[];
}

export type DmfPortType = { direction: 'provides' | 'requires', kind: 'sync' | 'async' };

export interface NewPort extends DmfPortType {
    name?: string;
    /** The type: a data type for sync ports, an interface or `event a, event b : T` for async ports. Default: `integer` / `event <name>`. */
    type?: string;
}

/** Thread settings as annotation arguments (`5`, `10 ms`, `4096`); undefined or empty removes the annotation. */
export interface ThreadAnnotations {
    priority?: string;
    period?: string;
    stack?: string;
}

/** The text of a port end: `door.cmd` or `remote` (a boundary port). */
export function portEndText(end: DmfPortEnd): string {
    return end.instance ? `${end.instance.name}.${end.port.name}` : end.port.name;
}

/**
 * How the ports `a` and `b` (in the order they were chosen) of the parts or the boundary of a structure
 * are connected: two ports of parts with a `connect` from the required to the provided port (the ends
 * are swapped if the provided port was chosen first), a boundary port and a port of a part with the same
 * direction with a `delegate` (provided: outer -> inner, required: inner -> outer). Throws an
 * {@link EditError} if the ports cannot be connected; incompatible types are reported in
 * {@link ConnectionPlan.problems} (the connection can be made, the validator reports the error).
 */
export function planConnection(structure: ast.Structure, a: DmfPortEnd, b: DmfPortEnd): ConnectionPlan {
    let kind: ConnectionPlan['kind'];
    let source: DmfPortEnd;
    let target: DmfPortEnd;
    if (!a.instance && !b.instance) {
        throw new EditError('Two boundary ports cannot be connected – delegate a boundary port to a port of a part.');
    }
    if (a.instance && b.instance) {
        if (a.instance === b.instance) {
            throw new EditError(`'${a.port.name}' and '${b.port.name}' are ports of the same part '${a.instance.name}'.`);
        }
        if (a.port.direction === b.port.direction) {
            throw new EditError(`Both ports are ${a.port.direction === 'provides' ? 'provided' : 'required'} ports – connect a required port with a provided port.`);
        }
        kind = 'connect';
        [source, target] = a.port.direction === 'requires' ? [a, b] : [b, a];
    } else {
        const outer = a.instance ? b : a;
        const inner = a.instance ? a : b;
        if (outer.port.direction !== inner.port.direction) {
            throw new EditError(`The boundary port '${outer.port.name}' is ${outer.port.direction === 'provides' ? 'provided' : 'required'}, `
                + `'${portEndText(inner)}' is ${inner.port.direction === 'provides' ? 'provided' : 'required'} – a boundary port is delegated to a port of a part with the same direction.`);
        }
        kind = 'delegate';
        [source, target] = outer.port.direction === 'provides' ? [outer, inner] : [inner, outer];
    }
    const statements: Array<ast.Connection | ast.Delegation> = kind === 'connect' ? structure.connections : structure.delegations;
    const same = (reference: ast.PortReference | undefined, end: DmfPortEnd) =>
        !!reference && reference.port?.ref === end.port && reference.instance?.ref === end.instance;
    if (statements.some(s => same(s.source, source) && same(s.target, target))) {
        throw new EditError(`'${portEndText(source)}' and '${portEndText(target)}' are already connected.`);
    }
    const problems = portIncompatibilities(source.port, target.port);
    if (kind === 'connect' && source.port.kind === 'sync'
        && structure.connections.some(c => same(c.source, source))) {
        problems.push(`the sync port '${portEndText(source)}' is already connected (a required sync port has one provider)`);
    }
    return {
        kind, source, target, swapped: source !== a, problems,
        text: `${kind} ${portEndText(source)} -> ${portEndText(target)}`
    };
}

type BodyNode = ast.Structure | ast.Component | ast.Thread;

/** An insertion into a body: `memberStart` is the index of the new member in the inserted text. */
type Insertion = TextEdit & { memberStart: number };

/** The edit without the extra properties of an insertion, and the offset of the inserted member. */
function inserted(edit: Insertion): EditResult {
    return { edits: [{ offset: edit.offset, length: edit.length, text: edit.text }], selectOffset: edit.offset + edit.memberStart };
}

/**
 * Computes the text edits of structural modifications of a structure file (`.dmf`): add, rename,
 * move and delete threads, instances, ports, connections, component types; edit ports, thread
 * annotations and the behavior of components. Renames of elements referenced from other files are
 * computed by {@link dmfRenameEdits} (Langium references across the loaded documents).
 */
export class DmfEditor {

    private readonly indentUnit: string;

    constructor(readonly text: string, readonly model: ast.DmfModel) {
        this.indentUnit = detectIndentUnit(text);
    }

    // -----------------------------------------------------------------------------------------
    // Component types

    /** Adds a component type (`component C1 { }`) at the end of the file. */
    addComponentType(kind: 'component' | 'subsystem' | 'system', name?: string): EditResult {
        const typeName = name ?? this.freshName(kind === 'component' ? 'Component' : kind === 'subsystem' ? 'Subsystem' : 'System',
            this.model.elements.map(e => e.name));
        checkDmfName(typeName);
        if (this.model.elements.some(e => e.name === typeName)) {
            throw new EditError(`'${typeName}' is already declared in this file.`);
        }
        const text = `${kind} ${typeName} {\n}`;
        const last = [...this.model.imports, ...this.model.elements].filter(n => n.$cstNode).sort(byOffset).pop();
        if (!last) {
            const prefix = this.text.trim() ? this.text.trimEnd() + '\n\n' : '';
            return { edits: [{ offset: 0, length: this.text.length, text: `${prefix}${text}\n` }], selectOffset: prefix.length, createdName: typeName };
        }
        const offset = this.endOfLineAfter(last.$cstNode!.end);
        return { edits: [{ offset, length: 0, text: `\n\n${text}` }], selectOffset: offset + 2, createdName: typeName };
    }

    /** Sets (`behavior "door.hsm"`), replaces or (undefined / empty) removes the behavior of a component. */
    setBehavior(component: ast.Component, path: string | undefined): EditResult {
        const value = path?.trim() || undefined;
        const text = value ? `behavior ${/^[_a-zA-Z][\w.]*$/.test(value) && !/\.hsm$/i.test(value) ? value : quote(value)}` : undefined;
        const existing = component.behavior?.$cstNode;
        if (existing) {
            return { edits: [text ? { offset: existing.offset, length: existing.length, text } : this.deletionEdit(existing)] };
        }
        if (!text) {
            return { edits: [] };
        }
        return inserted(this.insertInBody(component, text, undefined));
    }

    // -----------------------------------------------------------------------------------------
    // Ports

    /** Adds a port to a component type (a component or the boundary of a structure). */
    addPort(owner: ast.ComponentType, port: NewPort): EditResult {
        const name = port.name ?? this.freshName(port.direction === 'provides' ? 'in' : 'out', owner.ports.map(p => p.name));
        checkDmfName(name);
        if (owner.ports.some(p => p.name === name)) {
            throw new EditError(`'${owner.name}' already has a port '${name}'.`);
        }
        const type = port.type?.trim() || (port.kind === 'sync' ? 'integer' : `event ${name}`);
        const text = `${port.direction} ${port.kind} ${name} : ${type}`;
        const anchor = lastOf(owner.ports) ?? (ast.isComponent(owner) ? owner.behavior : undefined);
        return { ...inserted(this.insertInBody(owner, text, anchor)), createdName: name };
    }

    setPortDirection(port: ast.Port, direction: 'provides' | 'requires'): EditResult {
        return this.replaceProperty(port, 'direction', direction);
    }

    setPortKind(port: ast.Port, kind: 'sync' | 'async'): EditResult {
        return this.replaceProperty(port, 'kind', kind);
    }

    /** Replaces the type of a port (everything after the colon): `DoorCmd`, `integer`, `event a, event b : integer`. */
    setPortType(port: ast.Port, type: string): EditResult {
        const value = type.replace(/\s+/g, ' ').trim();
        if (!value) {
            throw new EditError('Please enter the type of the port.');
        }
        const cst = port.$cstNode!;
        const colon = GrammarUtils.findNodeForKeyword(cst, ':');
        if (!colon) {
            throw new EditError('The model contains syntax errors. Please fix them first.');
        }
        return { edits: [{ offset: colon.end, length: cst.end - colon.end, text: ` ${value}` }], selectOffset: cst.offset };
    }

    // -----------------------------------------------------------------------------------------
    // Threads and instances

    /** Adds a thread (with optional annotations) to a structure. */
    addThread(structure: ast.Structure, name?: string, annotations: ThreadAnnotations = {}): EditResult {
        const threadName = name ?? this.freshName('Thread', this.memberNames(structure));
        this.checkMemberName(structure, threadName);
        const prefix = annotationsText(annotations);
        const lines = prefix ? [prefix, `thread ${threadName} {`, '}'] : [`thread ${threadName} {`, '}'];
        const anchor = lastOf(structure.threads) ?? lastOf(structure.ports);
        return { ...inserted(this.insertInBody(structure, lines.join('\n'), anchor, !!anchor && !ast.isThread(anchor))), createdName: threadName };
    }

    /**
     * Adds an instance (`name : Type`) to a subsystem or system: an instance of a component into the given
     * thread (it is required), an instance of a subsystem outside of the threads (no thread may be given),
     * see docs/structure-language.md#threads. The name defaults to the type name starting with a lower
     * case letter.
     */
    addInstance(structure: ast.Structure, typeName: string, options: { name?: string, thread?: ast.Thread } = {}): EditResult {
        const type = typeName.trim();
        if (!/^[_a-zA-Z][\w]*(\.[_a-zA-Z]\w*)*$/.test(type)) {
            throw new EditError(`'${type}' is not a component type name.`);
        }
        const resolved = visibleElements(this.model).get(type);
        if (ast.isComponent(resolved) && !options.thread) {
            throw new EditError(`'${type}' is a component: its instances run in a thread – add the instance to a thread.`);
        }
        if (ast.isStructure(resolved) && options.thread) {
            throw new EditError(`'${type}' is a subsystem: its instances are placed outside of the threads (its parts run in the threads of ${type}).`);
        }
        const simple = type.substring(type.lastIndexOf('.') + 1);
        const base = simple.charAt(0).toLowerCase() + simple.substring(1);
        const taken = this.memberNames(structure);
        const name = options.name ?? (taken.includes(base) || !isValidDmfName(base) ? this.freshName(isValidDmfName(base) ? base : 'part', taken) : base);
        this.checkMemberName(structure, name);
        const text = `${name} : ${type}`;
        let edit: Insertion;
        if (options.thread) {
            const members = [...options.thread.instances, ...options.thread.members];
            edit = this.insertInBody(options.thread, text, lastOf(members));
        } else {
            const anchor = lastOf(structure.instances);
            const other = anchor ? undefined : lastOf(structure.threads) ?? lastOf(structure.ports);
            edit = this.insertInBody(structure, text, anchor ?? other, !!other);
        }
        return { ...inserted(edit), createdName: name };
    }

    /** Replaces the component type of an instance. */
    setInstanceType(instance: ast.ComponentInstance, typeName: string): EditResult {
        const node = instance.type?.$refNode ?? GrammarUtils.findNodeForProperty(instance.$cstNode, 'type');
        const value = typeName.trim();
        if (!node || !value) {
            throw new EditError('Cannot change the type of the instance.');
        }
        return { edits: [{ offset: node.offset, length: node.length, text: value }], selectOffset: instance.$cstNode!.offset };
    }

    /**
     * Moves an instance of a component into another thread. An instance declared in the body and assigned
     * to a thread by name (`thread T { door }`) loses that assignment; its declaration moves into the
     * target thread. `target` = the subsystem / system moves an instance out of its thread: allowed only
     * for instances of subsystems (which do not belong into threads, see docs/structure-language.md#threads).
     */
    moveInstance(instance: ast.ComponentInstance, target: ast.Thread | ast.Structure): EditResult {
        const structure = enclosingStructure(instance);
        if (!structure || (ast.isThread(target) ? target.$container !== structure : target !== structure)) {
            throw new EditError(`'${instance.name}' can only be moved within its ${structure?.kind ?? 'subsystem'}.`);
        }
        const type = instance.type?.ref;
        if (isCompositeType(type) && ast.isThread(target)) {
            throw new EditError(`'${instance.name}' is an instance of the subsystem ${type.name}: it is placed outside of the threads (its parts run in the threads of ${type.name}).`);
        }
        if (ast.isComponent(type) && ast.isStructure(target)) {
            throw new EditError(`'${instance.name}' is an instance of the component ${type.name}: it runs in a thread – move it into another thread.`);
        }
        const current = threadOf(instance);
        if ((ast.isThread(target) && current === target) || (ast.isStructure(target) && !current)) {
            return { edits: [] };
        }
        const edits: TextEdit[] = [];
        // assignments by name
        for (const thread of structure.threads) {
            for (const member of thread.members) {
                if (member.instance?.ref === instance && member.$cstNode) {
                    edits.push(this.deletionEdit(member.$cstNode));
                }
            }
        }
        const declaredInBody = instance.$container === structure;
        if (declaredInBody && ast.isStructure(target)) {
            return { edits: mergeEdits(edits) };
        }
        const range = this.rangeOf(instance);
        const moved = this.nodeText(range, '').split('\n');
        const comment = this.trailingComment(instance.$cstNode!.end);
        if (comment) {
            moved[moved.length - 1] += ' ' + comment;
        }
        edits.push(this.deletionEdit(range));
        let insertion: Insertion;
        if (ast.isThread(target)) {
            insertion = this.insertInBody(target, moved.join('\n'), lastOf([...target.instances, ...target.members].filter(m => m !== instance)));
        } else {
            const anchor = lastOf(structure.instances);
            insertion = this.insertInBody(structure, moved.join('\n'), anchor ?? lastOf(structure.threads), !anchor);
        }
        const deletions = mergeEdits(edits);
        const plain: TextEdit = { offset: insertion.offset, length: insertion.length, text: insertion.text };
        const all = mergeEdits([...deletions, plain]);
        checkOverlaps(all);
        return { edits: all, selectOffset: mapOffset(insertion.offset, deletions) + insertion.memberStart };
    }

    // -----------------------------------------------------------------------------------------
    // Connections

    /** Connects two ports chosen in the diagram (see {@link planConnection}: the ends are swapped if necessary). */
    addConnection(structure: ast.Structure, a: DmfPortEnd, b: DmfPortEnd): EditResult & { plan: ConnectionPlan } {
        const plan = planConnection(structure, a, b);
        const anchor = plan.kind === 'connect'
            ? lastOf(structure.connections) ?? lastOf([...structure.instances, ...structure.threads, ...structure.ports])
            : lastOf(structure.delegations) ?? lastOf(structure.connections) ?? lastOf([...structure.instances, ...structure.threads, ...structure.ports]);
        const blank = !!anchor && !ast.isConnection(anchor) && !ast.isDelegation(anchor);
        return { ...inserted(this.insertInBody(structure, plan.text, anchor, blank)), plan };
    }

    // -----------------------------------------------------------------------------------------
    // Annotations

    /**
     * Sets the thread annotations (`@priority(5) @period(10 ms) @stack(4096)`), written on the line
     * before the thread; an empty value removes the annotation, other annotations are kept.
     */
    setThreadAnnotations(thread: ast.Thread, changes: ThreadAnnotations): EditResult {
        for (const [name, value] of Object.entries(changes)) {
            const text = (value as string | undefined)?.trim();
            if (text && !checkAnnotationValue(name, text)) {
                throw new EditError(name === 'period'
                    ? `'${text}' is not a period – write a number and a unit (s, ms, us, ns), e.g. 10 ms.`
                    : `'${text}' is not a number.`);
            }
        }
        const cst = thread.$cstNode!;
        const keyword = GrammarUtils.findNodeForKeyword(cst, 'thread');
        if (!keyword) {
            throw new EditError('The model contains syntax errors. Please fix them first.');
        }
        const parts: string[] = [];
        const handled = new Set<string>();
        for (const annotation of thread.annotations) {
            const name = annotation.name;
            if (name in changes) {
                if (!handled.has(name)) {
                    handled.add(name);
                    const value = changes[name as keyof ThreadAnnotations]?.trim();
                    if (value) {
                        parts.push(`@${name}(${value})`);
                    }
                }
            } else {
                parts.push(this.text.substring(annotation.$cstNode!.offset, annotation.$cstNode!.end));
            }
        }
        for (const name of ['priority', 'period', 'stack'] as const) {
            const value = changes[name]?.trim();
            if (value && !handled.has(name)) {
                parts.push(`@${name}(${value})`);
            }
        }
        const start = thread.annotations[0]?.$cstNode?.offset ?? keyword.offset;
        const indent = this.indentOf(start);
        const text = parts.length > 0 ? `${parts.join(' ')}\n${indent}` : '';
        const current = this.text.substring(start, keyword.offset);
        if (current === text) {
            return { edits: [] };
        }
        return { edits: [{ offset: start, length: keyword.offset - start, text }], selectOffset: start };
    }

    // -----------------------------------------------------------------------------------------
    // Renaming (elements without references from other files) and deleting

    /**
     * Renames an element by its name and the references in this file. For elements that may be
     * referenced from other files (component types, ports) use {@link dmfRenameEdits}.
     */
    rename(node: ast.DmfElement | ast.Port | ast.Thread | ast.ComponentInstance, newName: string): EditResult {
        const name = newName.trim();
        if (name === node.name) {
            return { edits: [] };
        }
        checkRename(node, name);
        const nameNode = GrammarUtils.findNodeForProperty(node.$cstNode, 'name');
        if (!nameNode) {
            throw new EditError(`Cannot rename '${node.name}'.`);
        }
        const edits: TextEdit[] = [{ offset: nameNode.offset, length: nameNode.length, text: name }];
        for (const reference of AstUtils.streamAst(this.model).flatMap(n => AstUtils.streamReferences(n))) {
            const ref = reference.reference;
            if ('ref' in ref && ref.ref === node && ref.$refNode) {
                edits.push({ offset: ref.$refNode.offset, length: ref.$refNode.length, text: replaceLastSegment(ref.$refText, name) });
            }
        }
        return { edits: mergeEdits(edits), selectOffset: mapOffset(node.$cstNode!.offset, edits) };
    }

    /**
     * Deletes elements of the diagram:
     * - an instance with its connections, delegations and assignments to threads,
     * - a port with the connections and delegations of this file that use it,
     * - a thread with its instances (declared in it or assigned to it) and their connections and
     *   delegations (instances of components run in a thread, see docs/structure-language.md#threads),
     * - connections, delegations, component types.
     */
    deleteElements(targets: readonly AstNode[]): EditResult {
        const nodes = new Set<AstNode>();
        const threads = new Set<ast.Thread>();
        const deletedInstances = new Set<ast.ComponentInstance>();
        const deletedPorts = new Set<ast.Port>();
        for (const target of targets) {
            if (ast.isThread(target)) {
                threads.add(target);
                for (const instance of threadInstances(target)) {
                    nodes.add(instance);
                    deletedInstances.add(instance);
                }
            } else if (ast.isComponentInstance(target)) {
                nodes.add(target);
                deletedInstances.add(target);
            } else if (ast.isPort(target)) {
                nodes.add(target);
                deletedPorts.add(target);
            } else if (ast.isConnection(target) || ast.isDelegation(target) || ast.isComponentType(target) || ast.isThreadMember(target)) {
                nodes.add(target);
                if (ast.isComponentType(target)) {
                    target.ports.forEach(p => deletedPorts.add(p));
                    if (ast.isStructure(target)) {
                        structureInstances(target).forEach(i => deletedInstances.add(i));
                    }
                }
            }
        }
        const uses = (reference: ast.PortReference | undefined) => {
            const instance = reference?.instance?.ref;
            return !!reference && ((instance !== undefined && deletedInstances.has(instance)) || (reference.port?.ref !== undefined && deletedPorts.has(reference.port.ref)));
        };
        for (const structure of this.model.elements.filter(ast.isStructure)) {
            for (const statement of [...structure.connections, ...structure.delegations]) {
                if (uses(statement.source) || uses(statement.target)) {
                    nodes.add(statement);
                }
            }
            for (const thread of structure.threads) {
                for (const member of thread.members) {
                    const instance = member.instance?.ref;
                    if (instance && deletedInstances.has(instance)) {
                        nodes.add(member);
                    }
                }
            }
        }
        const roots = [...nodes].filter(node => ![...nodes, ...threads].some(other => other !== node && isAncestor(other, node)));
        const edits: TextEdit[] = [];
        for (const node of roots) {
            if (node.$cstNode && ![...threads].some(t => isAncestor(t, node))) {
                edits.push(this.deletionEdit(this.rangeOf(node)));
            }
        }
        for (const thread of threads) {
            if (thread.$cstNode && ![...nodes].some(n => isAncestor(n, thread))) {
                edits.push(this.deletionEdit(this.rangeOf(thread)));
            }
        }
        return { edits: mergeEdits(edits) };
    }

    // -----------------------------------------------------------------------------------------
    // Helpers

    freshName(prefix: string, taken: readonly string[]): string {
        const names = new Set(taken);
        let index = 1;
        while (names.has(`${prefix}${index}`)) {
            index++;
        }
        return `${prefix}${index}`;
    }

    /** The names of the instances and threads of a structure (they must be unique together). */
    private memberNames(structure: ast.Structure): string[] {
        return [...structureInstances(structure).map(i => i.name), ...structure.threads.map(t => t.name)];
    }

    private checkMemberName(structure: ast.Structure, name: string): void {
        checkDmfName(name);
        if (this.memberNames(structure).includes(name)) {
            throw new EditError(`'${structure.name}' already has an instance or thread named '${name}'.`);
        }
    }

    private replaceProperty(node: AstNode, property: string, value: string): EditResult {
        const cst = GrammarUtils.findNodeForProperty(node.$cstNode, property);
        if (!cst) {
            throw new EditError('The model contains syntax errors. Please fix them first.');
        }
        if (this.text.substring(cst.offset, cst.end) === value) {
            return { edits: [] };
        }
        return { edits: [{ offset: cst.offset, length: cst.length, text: value }], selectOffset: node.$cstNode!.offset };
    }

    /** Leading whitespace of the line containing the offset. */
    private indentOf(offset: number): string {
        const start = this.text.lastIndexOf('\n', offset - 1) + 1;
        return /^[ \t]*/.exec(this.text.substring(start))![0];
    }

    private isAtLineStart(offset: number): boolean {
        const start = this.text.lastIndexOf('\n', offset - 1) + 1;
        return this.text.substring(start, offset).trim() === '';
    }

    private members(container: BodyNode): AstNode[] {
        return AstUtils.streamContents(container)
            .filter(n => !ast.isDmfAnnotation(n) && n.$cstNode !== undefined)
            .toArray()
            .sort(byOffset);
    }

    /** Indentation of the members of a body. */
    private childIndent(container: BodyNode): string {
        for (const member of this.members(container)) {
            const offset = member.$cstNode!.offset;
            if (this.isAtLineStart(offset)) {
                return this.indentOf(offset);
            }
        }
        return this.indentOf(this.headerOffset(container)) + this.indentUnit;
    }

    /** Offset of the line of the header (`thread T {`, not its annotations on the line before). */
    private headerOffset(container: BodyNode): number {
        return GrammarUtils.findNodeForKeyword(container.$cstNode, '{')?.offset ?? container.$cstNode!.offset;
    }

    private braces(container: BodyNode): { open: number, close: number } {
        const cst = container.$cstNode!;
        const open = GrammarUtils.findNodeForKeyword(cst, '{');
        const close = this.text.charAt(cst.end - 1) === '}' ? cst.end - 1 : -1;
        if (!open || close < 0) {
            throw new EditError('The model contains syntax errors. Please fix them first.');
        }
        return { open: open.offset, close };
    }

    /**
     * Inserts a member (lines separated by `\n`, without indentation) into a body: after `anchor` (with an
     * empty line before it if `blank`), at the start of the body if there is no anchor.
     */
    private insertInBody(container: BodyNode, member: string, anchor: AstNode | undefined, blank = false): Insertion {
        if (!container.$cstNode) {
            throw new EditError('The model contains syntax errors. Please fix them first.');
        }
        const { open, close } = this.braces(container);
        const indent = this.childIndent(container);
        const text = member.split('\n').map((line, i) => (i === 0 ? '' : indent) + line).join('\n');
        if (anchor?.$cstNode) {
            const offset = this.endOfLineAfter(anchor.$cstNode.end);
            const prefix = `${blank ? '\n' : ''}\n${indent}`;
            return { offset, length: 0, text: prefix + text, memberStart: prefix.length };
        }
        const members = this.members(container);
        const first = members[0];
        if (first && this.isAtLineStart(first.$cstNode!.offset)) {
            const lineStart = this.text.lastIndexOf('\n', first.$cstNode!.offset - 1) + 1;
            return { offset: lineStart, length: 0, text: `${indent}${text}\n`, memberStart: indent.length };
        }
        if (first) {
            return { offset: open + 1, length: 0, text: `\n${indent}${text}`, memberStart: indent.length + 1 };
        }
        // empty body: `{ }` or `{\n}` (comments in the body are kept)
        const interior = this.text.substring(open + 1, close);
        const comments = interior.trim() ? interior.trimEnd() : '';
        const containerIndent = this.indentOf(this.headerOffset(container));
        const prefix = `${comments}\n${indent}`;
        return { offset: open + 1, length: close - open - 1, text: `${prefix}${text}\n${containerIndent}`, memberStart: prefix.length };
    }

    /** A `//` comment which follows the given offset on the same line. */
    private trailingComment(offset: number): string | undefined {
        let lineEnd = this.text.indexOf('\n', offset);
        if (lineEnd < 0) {
            lineEnd = this.text.length;
        }
        const match = /^\s*(\/\/.*?)\s*$/.exec(this.text.substring(offset, lineEnd));
        return match?.[1];
    }

    /** End of the line after the given offset, if the remainder of the line is only whitespace or a comment. */
    private endOfLineAfter(offset: number): number {
        let lineEnd = this.text.indexOf('\n', offset);
        if (lineEnd < 0) {
            lineEnd = this.text.length;
        }
        const rest = this.text.substring(offset, lineEnd);
        if (/^\s*(\/\/.*)?$/.test(rest)) {
            return lineEnd > 0 && this.text.charAt(lineEnd - 1) === '\r' ? lineEnd - 1 : lineEnd;
        }
        return offset;
    }

    /**
     * The text range of an element including the comment lines directly before it (its documentation
     * or a `//` remark, without an empty line in between).
     */
    private rangeOf(node: AstNode): { offset: number, end: number } {
        const cst = node.$cstNode!;
        let offset = cst.offset;
        if (this.isAtLineStart(offset)) {
            let lineStart = this.text.lastIndexOf('\n', offset - 1) + 1;
            while (lineStart > 0) {
                const previousStart = this.text.lastIndexOf('\n', lineStart - 2) + 1;
                const line = this.text.substring(previousStart, lineStart - 1).trim();
                if (line.startsWith('//')) {
                    lineStart = previousStart;
                } else if (line.endsWith('*/')) {
                    const commentStart = this.text.lastIndexOf('/*', lineStart - 1);
                    if (commentStart < 0 || !this.isAtLineStart(commentStart)) {
                        break;
                    }
                    lineStart = this.text.lastIndexOf('\n', commentStart - 1) + 1;
                } else {
                    break;
                }
            }
            offset = Math.min(offset, lineStart + this.indentOf(lineStart).length);
        }
        return { offset, end: cst.end };
    }

    /** Text of a range re-indented for the given indentation (first line without indentation). */
    private nodeText(range: { offset: number, end: number }, indent: string): string {
        const originalIndent = this.indentOf(range.offset);
        const lines = this.text.substring(range.offset, range.end).split('\n');
        return lines.map((line, i) => i === 0 ? line : line.startsWith(originalIndent) ? indent + line.substring(originalIndent.length) : line).join('\n');
    }

    /** Deletes the text of the range including the whole line(s) if nothing else remains on them. */
    private deletionEdit(range: { offset: number, end: number }): TextEdit {
        let start = range.offset;
        let end = range.end;
        const lineStart = this.text.lastIndexOf('\n', start - 1) + 1;
        let lineEnd = this.text.indexOf('\n', end);
        if (lineEnd < 0) {
            lineEnd = this.text.length;
        }
        const before = this.text.substring(lineStart, start);
        const after = this.text.substring(end, lineEnd);
        if (before.trim() === '' && /^\s*(\/\/.*)?$/.test(after)) {
            start = lineStart;
            end = Math.min(lineEnd + 1, this.text.length);
        } else if (before.trim() === '') {
            while (end < this.text.length && (this.text[end] === ' ' || this.text[end] === '\t')) {
                end++;
            }
        } else {
            while (start > lineStart && (this.text[start - 1] === ' ' || this.text[start - 1] === '\t')) {
                start--;
            }
        }
        return { offset: start, length: end - start, text: '' };
    }
}

// ---------------------------------------------------------------------------------------------
// Renaming across files

/**
 * Checks a new name of an element: a valid name that differs from its siblings (elements of the file;
 * ports of the component type; instances and threads of the structure). Throws an {@link EditError}.
 */
export function checkRename(node: AstNode & { name: string }, newName: string): void {
    checkDmfName(newName);
    const container = node.$container;
    let siblings: Array<{ name: string }> = [];
    let what = 'An element';
    if (ast.isPort(node)) {
        siblings = node.$container.ports;
        what = 'A port';
    } else if (ast.isComponentInstance(node) || ast.isThread(node)) {
        const structure = enclosingStructure(node);
        siblings = structure ? [...structureInstances(structure), ...structure.threads] : [];
        what = 'An instance or thread';
    } else if (ast.isDmfModel(container)) {
        siblings = container.elements;
    }
    if (siblings.some(s => s !== node && s.name === newName)) {
        throw new EditError(`${what} named '${newName}' already exists here.`);
    }
}

/**
 * The edits renaming an element of a structure file and all references to it in the loaded documents
 * (Langium references: also in other files, e.g. the instances of a component type or the connections
 * of its ports in the structures that import it), by document URI. Qualified references
 * (`types.Position`) keep their qualifier.
 */
export function dmfRenameEdits(services: LangiumCoreServices, node: AstNode & { name: string }, newName: string): Map<string, TextEdit[]> {
    const name = newName.trim();
    const result = new Map<string, TextEdit[]>();
    if (name === node.name) {
        return result;
    }
    checkRename(node, name);
    const documents = services.shared.workspace.LangiumDocuments;
    const add = (uri: string, edit: TextEdit) => {
        const edits = result.get(uri) ?? [];
        if (!edits.some(e => e.offset === edit.offset)) {
            edits.push(edit);
        }
        result.set(uri, edits);
    };
    const own = AstUtils.getDocument(node);
    const nameNode = GrammarUtils.findNodeForProperty(node.$cstNode, 'name');
    if (!nameNode) {
        throw new EditError(`Cannot rename '${node.name}'.`);
    }
    add(own.uri.toString(), { offset: nameNode.offset, length: nameNode.length, text: name });
    for (const reference of services.references.References.findReferences(node, { includeDeclaration: false })) {
        const uri = reference.sourceUri.toString();
        const document = documents.getDocument(reference.sourceUri);
        if (!document) {
            continue;
        }
        const text = document.textDocument.getText().substring(reference.segment.offset, reference.segment.end);
        add(uri, { offset: reference.segment.offset, length: reference.segment.length, text: replaceLastSegment(text, name) });
    }
    if (ast.isPort(node)) {
        // the layout annotations placing the port (`@port(cmd, left, 40)`) on the instances of its type and on its subsystem / system
        const owner = node.$container;
        for (const document of documents.all) {
            for (const element of AstUtils.streamAst(document.parseResult.value)) {
                const placed = ast.isStructure(element) ? element === owner : ast.isComponentInstance(element) && element.type?.ref === owner;
                if (!placed) {
                    continue;
                }
                for (const annotation of (element as ast.Structure | ast.ComponentInstance).annotations) {
                    const argument = annotation.name === 'port' ? annotation.arguments[0] : undefined;
                    if (argument?.name === node.name && argument.$cstNode) {
                        add(document.uri.toString(), { offset: argument.$cstNode.offset, length: argument.$cstNode.length, text: name });
                    }
                }
            }
        }
    }
    return result;
}

/** Replaces the last segment of a (qualified) reference text: `types.Position` -> `types.<name>`. */
function replaceLastSegment(text: string, name: string): string {
    const index = Math.max(text.lastIndexOf('.'), text.lastIndexOf('::') >= 0 ? text.lastIndexOf('::') + 1 : -1);
    return index >= 0 ? text.substring(0, index + 1) + name : name;
}

// ---------------------------------------------------------------------------------------------

function checkAnnotationValue(name: string, value: string): boolean {
    if (name === 'period') {
        return /^\d+(\.\d+)?\s*(s|ms|us|ns)$/.test(value);
    }
    return /^(0[xX][0-9a-fA-F]+|-?\d+)$/.test(value);
}

/** `@priority(5) @period(10 ms)` of the given settings. */
function annotationsText(annotations: ThreadAnnotations): string {
    return (['priority', 'period', 'stack'] as const)
        .filter(name => annotations[name]?.trim())
        .map(name => `@${name}(${annotations[name]!.trim()})`)
        .join(' ');
}

function lastOf<T extends AstNode>(nodes: readonly T[]): T | undefined {
    return [...nodes].filter(n => n.$cstNode).sort(byOffset).pop();
}

function byOffset(a: AstNode, b: AstNode): number {
    return a.$cstNode!.offset - b.$cstNode!.offset;
}

function isAncestor(ancestor: AstNode, node: AstNode): boolean {
    for (let current = node.$container; current; current = current.$container) {
        if (current === ancestor) {
            return true;
        }
    }
    return false;
}

/** Sorts the edits and merges overlapping deletions (whole-line deletions may touch). */
function mergeEdits(edits: TextEdit[]): TextEdit[] {
    const sorted = [...edits].sort((a, b) => a.offset - b.offset || a.length - b.length);
    const merged: TextEdit[] = [];
    for (const edit of sorted) {
        const last = merged[merged.length - 1];
        if (last && edit.offset < last.offset + last.length && !edit.text && !last.text) {
            last.length = Math.max(last.offset + last.length, edit.offset + edit.length) - last.offset;
        } else {
            merged.push({ ...edit });
        }
    }
    return merged;
}

function checkOverlaps(edits: TextEdit[]): void {
    for (let i = 1; i < edits.length; i++) {
        if (edits[i].offset < edits[i - 1].offset + edits[i - 1].length) {
            throw new EditError('The requested change is not possible.');
        }
    }
}

/** The smallest indentation used in the text (ignoring block comment continuation lines). */
function detectIndentUnit(text: string): string {
    let unit: string | undefined;
    for (const match of text.matchAll(/^([ \t]+)([^\s*])/gm)) {
        const indent = match[1];
        if (indent.startsWith('\t')) {
            return '\t';
        }
        if (!unit || indent.length < unit.length) {
            unit = indent;
        }
    }
    return unit && unit.length >= 2 && unit.length <= 8 ? unit : '    ';
}

