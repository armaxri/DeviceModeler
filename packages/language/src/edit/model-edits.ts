import { AstUtils, GrammarUtils, type AstNode, type CstNode, type Reference } from 'langium';
import { containerAnnotations, elementStart } from '../model-annotations.js';
import * as ast from '../generated/ast.js';
import { qualifiedName, referenceName } from '../hsm-scope.js';
import {
    allTransitions, allVertices, commonContainer, initialTransitions, isScopeContainer, isAncestorOrSelf, scopeOf,
    type ScopeContainer
} from '../model-utils.js';

/** A replacement of `length` characters at `offset` by `text`. Offsets refer to the original text. */
export interface TextEdit {
    offset: number;
    length: number;
    text: string;
}

export interface EditResult {
    edits: TextEdit[];
    /**
     * Offset (in the text *after* applying the edits) of the element that should be selected
     * after the edit, e.g. a newly created state.
     */
    selectOffset?: number;
    /** Name of a newly created vertex. */
    createdName?: string;
}

export class EditError extends Error { }

export type NewVertexKind = 'state' | ast.PseudoStateKind;

/** Kinds of declarations which can be added to the definition section. */
export type DeclarationKind = 'in event' | 'out event' | 'internal event' | 'var' | 'const' | 'operation';

export const DECLARATION_KINDS: DeclarationKind[] = ['in event', 'out event', 'internal event', 'var', 'const', 'operation'];

export interface NewDeclaration {
    kind: DeclarationKind;
    /** Name of the declaration. Operations may include a parameter list: `log(msg : string)`. */
    name: string;
    /** Type (of the event payload, variable, constant or the return type of an operation). */
    type?: string;
    /** Initial value of a variable or constant. */
    value?: string;
    /**
     * Scope to add the declaration to: `internal`, the name of a named interface, or empty / undefined
     * for the unnamed interface. Default: `internal` for internal events, the unnamed interface otherwise.
     * A missing scope is created.
     */
    scope?: string;
}

/** Special end points of a transition: the initial or final pseudo state of a container. */
export type TransitionSource = ast.Vertex | { initialOf: ScopeContainer };
export type TransitionTarget = ast.Vertex | { finalOf: ScopeContainer };

/** Things that can be deleted from the diagram. */
export type DeletionTarget = AstNode | { initialOf: ScopeContainer } | { finalOf: ScopeContainer };

export const HSM_KEYWORDS = new Set([
    'statemachine', 'namespace', 'state', 'region', 'choice', 'junction', 'history', 'deephistory', 'sync', 'entry', 'exit',
    'interface', 'internal', 'in', 'out', 'event', 'var', 'const', 'readonly', 'operation', 'alias',
    'after', 'every', 'always', 'oncycle', 'else', 'default', 'raise', 'valueof', 'active', 'as', 'true', 'false', 'null']);

const ID_REGEX = /^[_a-zA-Z]\w*$/;

export function isValidIdentifier(name: string): boolean {
    return ID_REGEX.test(name) && !HSM_KEYWORDS.has(name);
}

/** Encodes the given text as a string literal of the HSM language. */
export function quote(value: string): string {
    return JSON.stringify(value);
}

/** Applies non-overlapping edits to the given text. */
export function applyEdits(text: string, edits: TextEdit[]): string {
    const sorted = [...edits].sort((a, b) => b.offset - a.offset);
    let result = text;
    let lastOffset = Number.POSITIVE_INFINITY;
    for (const edit of sorted) {
        if (edit.offset + edit.length > lastOffset) {
            throw new EditError('Overlapping text edits.');
        }
        result = result.substring(0, edit.offset) + edit.text + result.substring(edit.offset + edit.length);
        lastOffset = edit.offset;
    }
    return result;
}

/** Maps an offset of the original text to the corresponding offset after applying the edits. */
export function mapOffset(offset: number, edits: TextEdit[]): number {
    let delta = 0;
    for (const edit of edits) {
        if (edit.offset + edit.length <= offset) {
            delta += edit.text.length - edit.length;
        }
    }
    return offset + delta;
}

/** Formats the label part of a transition (`trigger [guard] / effect`), including the leading colon. */
export function formatTransitionLabel(spec: string | undefined): string {
    const text = spec?.replace(/\s+/g, ' ').trim();
    return text ? ` : ${text}` : '';
}

/**
 * Computes text edits for structural modifications of a state machine. The textual model
 * stays the single source of truth: every diagram operation is translated into a minimal
 * text change which keeps comments and formatting of unaffected parts intact.
 */
export class ModelEditor {

    private readonly indentUnit: string;

    constructor(readonly text: string, readonly machine: ast.StateMachine) {
        this.indentUnit = detectIndentUnit(text);
    }

    // ---------------------------------------------------------------------------------------
    // Operations

    addVertex(target: ScopeContainer, kind: NewVertexKind, name?: string): EditResult {
        const container = ast.isState(target) && target.regions.length > 0 ? target.regions[0] : target;
        const vertexName = name ?? this.freshName(defaultNamePrefix(kind));
        this.checkNewName(vertexName, container);
        const text = kind === 'state' ? `state ${vertexName}` : `${kind} ${vertexName}`;
        const { edit, memberOffset } = this.insertMember(container, [text], 'afterVertices');
        return { edits: [edit], selectOffset: memberOffset, createdName: vertexName };
    }

    addRegion(state: ast.State): EditResult {
        if (state.regions.length > 0 || (state.vertices.length === 0 && state.transitions.length === 0)) {
            const { edit, memberOffset } = this.insertMember(state, ['region {', '}'], 'end');
            return { edits: [edit], selectOffset: memberOffset };
        }
        // Wrap the existing content into a first region and add a second, empty region.
        const inner = this.childIndent(state);
        const regionIndent = inner + this.indentUnit;
        const lines: string[] = [];
        const withComment = (node: AstNode, indent: string) => {
            const comment = this.trailingComment(node.$cstNode!.end);
            return indent + this.nodeText(node, indent) + (comment ? ' ' + comment : '');
        };
        const byOffset = (a: AstNode, b: AstNode) => a.$cstNode!.offset - b.$cstNode!.offset;
        for (const reaction of [...state.reactions].sort(byOffset)) {
            lines.push(withComment(reaction, inner));
        }
        lines.push(inner + 'region {');
        for (const member of [...state.vertices, ...state.transitions].sort(byOffset)) {
            lines.push(withComment(member, regionIndent));
        }
        lines.push(inner + '}');
        lines.push(inner + 'region {');
        lines.push(inner + '}');
        const { open, close } = this.braces(state);
        const newText = '\n' + lines.join('\n') + '\n' + this.indentOf(state.$cstNode!.offset);
        const edit: TextEdit = { offset: open + 1, length: close - open - 1, text: newText };
        const secondRegion = newText.lastIndexOf('region {');
        return { edits: [edit], selectOffset: open + 1 + secondRegion };
    }

    addTransition(source: TransitionSource, target: TransitionTarget, label?: string): EditResult {
        let container: ScopeContainer;
        if ('initialOf' in source) {
            container = source.initialOf;
        } else if ('finalOf' in target) {
            container = target.finalOf;
        } else {
            container = commonContainer(scopeOf(source), scopeOf(target));
        }
        const sourceText = 'initialOf' in source ? '[*]' : referenceName(source, container);
        const targetText = 'finalOf' in target ? '[*]' : referenceName(target, container);
        const text = `${sourceText} -> ${targetText}${formatTransitionLabel(label)}`;
        const { edit, memberOffset } = this.insertMember(container, [text], 'end');
        return { edits: [edit], selectOffset: memberOffset };
    }

    /** Makes the given vertex the target of the initial transition of its container. */
    setInitial(vertex: ast.Vertex): EditResult {
        const container = scopeOf(vertex);
        const existing = initialTransitions(container)[0];
        if (existing) {
            const targetNode = existing.target?.$refNode ?? GrammarUtils.findNodeForProperty(existing.$cstNode, 'target');
            if (targetNode) {
                return {
                    edits: [{ offset: targetNode.offset, length: targetNode.length, text: referenceName(vertex, container) }],
                    selectOffset: existing.$cstNode!.offset
                };
            }
        }
        return this.addTransition({ initialOf: container }, vertex);
    }

    renameVertex(vertex: ast.Vertex, newName: string): EditResult {
        if (newName === vertex.name) {
            return { edits: [] };
        }
        this.checkNewName(newName, vertex.$container, vertex);
        const nameNode = GrammarUtils.findNodeForProperty(vertex.$cstNode, 'name');
        if (!nameNode) {
            throw new EditError(`Cannot rename '${vertex.name}'.`);
        }
        const edits: TextEdit[] = [{ offset: nameNode.offset, length: nameNode.length, text: newName }];
        // references use (partially) qualified names: replace the segment which denotes the renamed vertex
        const depth = qualifiedName(vertex).split('.').length - 1;
        for (const ref of vertexReferences(this.machine)) {
            const target = ref.ref;
            if (!target || !ref.$refNode || !isAncestorOrSelf(vertex, target)) {
                continue;
            }
            const targetSegments = qualifiedName(target).split('.');
            const refSegments = ref.$refText.split('.');
            const index = depth - (targetSegments.length - refSegments.length);
            if (index >= 0 && index < refSegments.length && refSegments[index] === vertex.name) {
                refSegments[index] = newName;
                edits.push({ offset: ref.$refNode.offset, length: ref.$refNode.length, text: refSegments.join('.') });
            }
        }
        return { edits, selectOffset: mapOffset(vertex.$cstNode!.offset, edits) };
    }

    renameRegion(region: ast.Region, newName: string | undefined): EditResult {
        const name = newName?.trim() || undefined;
        if (name && !isValidIdentifier(name)) {
            throw new EditError(`'${name}' is not a valid name.`);
        }
        const keyword = GrammarUtils.findNodeForKeyword(region.$cstNode, 'region')!;
        const nameNode = GrammarUtils.findNodeForProperty(region.$cstNode, 'name');
        if (nameNode) {
            return { edits: [name ? { offset: nameNode.offset, length: nameNode.length, text: name } : { offset: keyword.end, length: nameNode.end - keyword.end, text: '' }] };
        }
        return name ? { edits: [{ offset: keyword.end, length: 0, text: ` ${name}` }] } : { edits: [] };
    }

    setStateDescription(state: ast.State, description: string | undefined): EditResult {
        const descriptionNode = GrammarUtils.findNodeForProperty(state.$cstNode, 'description');
        const nameNode = GrammarUtils.findNodeForProperty(state.$cstNode, 'name')!;
        const value = description?.trim() ? description : undefined;
        if (descriptionNode) {
            const edit = value
                ? { offset: descriptionNode.offset, length: descriptionNode.length, text: quote(value) }
                : { offset: nameNode.end, length: descriptionNode.end - nameNode.end, text: '' };
            return { edits: [edit] };
        }
        return value ? { edits: [{ offset: nameNode.end, length: 0, text: ` ${quote(value)}` }] } : { edits: [] };
    }

    /** Sets, replaces or (with an empty effect) removes the `entry /` or `exit /` reaction of a state. */
    setStateAction(state: ast.State, kind: 'entry' | 'exit', effect: string | undefined): EditResult {
        const existing = stateAction(state, kind);
        const value = effect?.replace(/\s+/g, ' ').trim() || undefined;
        if (existing) {
            if (!value) {
                return { edits: [this.deletionEdit(existing.$cstNode!)] };
            }
            const effectNode = existing.effect.$cstNode!;
            return { edits: [{ offset: effectNode.offset, length: effectNode.length, text: value }] };
        }
        if (!value) {
            return { edits: [] };
        }
        const text = `${kind} / ${value}`;
        const entry = kind === 'exit' ? stateAction(state, 'entry') : undefined;
        if (entry) {
            const offset = this.endOfLineAfter(entry.$cstNode!.end);
            return { edits: [{ offset, length: 0, text: `\n${this.childIndent(state)}${text}` }] };
        }
        const { edit } = this.insertMember(state, [text], 'start');
        return { edits: [edit] };
    }

    /** Replaces the reaction specification (`triggers [guard] / effect`) of a transition. */
    updateTransitionLabel(transition: ast.Transition, spec: string | undefined): EditResult {
        const cst = transition.$cstNode!;
        const arrow = GrammarUtils.findNodeForKeyword(cst, '->')!;
        const targetNode = transition.final
            ? GrammarUtils.findNodeForProperty(cst, 'final')
            : transition.target?.$refNode ?? GrammarUtils.findNodeForProperty(cst, 'target');
        const start = targetNode ? targetNode.end : arrow.end;
        const hash = GrammarUtils.findNodeForKeyword(cst, '#');
        const end = hash ? hash.offset : cst.end;
        const suffix = hash ? ' ' : '';
        return {
            edits: [{ offset: start, length: end - start, text: formatTransitionLabel(spec) + suffix }],
            selectOffset: cst.offset
        };
    }

    /**
     * Adds a declaration (event, variable, constant, operation) to a scope of the definition
     * section. The scope (`interface:`, `interface Name:` or `internal:`) is created if missing.
     */
    addDeclaration(declaration: NewDeclaration): EditResult {
        const name = declaration.name.trim();
        const simpleName = /^\s*([^\s(]*)/.exec(name)![1];
        if (!isValidIdentifier(simpleName)) {
            throw new EditError(`'${simpleName}' is not a valid name. Use letters, digits and '_' (no keywords).`);
        }
        const type = declaration.type?.trim() || undefined;
        if (type && !isValidIdentifier(type)) {
            throw new EditError(`'${type}' is not a valid type name.`);
        }
        const scopeName = (declaration.scope ?? (declaration.kind === 'internal event' ? 'internal' : '')).trim();
        if (scopeName && scopeName !== 'internal' && !isValidIdentifier(scopeName)) {
            throw new EditError(`'${scopeName}' is not a valid interface name.`);
        }
        const scope = this.machine.scopes.find(s => scopeName === 'internal'
            ? ast.isInternalScope(s)
            : ast.isInterfaceScope(s) && (s.name ?? '') === scopeName);
        const qualified = scopeName && scopeName !== 'internal' ? `${scopeName}.${simpleName}` : simpleName;
        for (const other of this.machine.scopes) {
            for (const existing of other.declarations) {
                const otherName = ast.isInterfaceScope(other) && other.name ? `${other.name}.${existing.name}` : existing.name;
                if (otherName === qualified) {
                    throw new EditError(`'${qualified}' is already declared.`);
                }
            }
        }
        const text = declarationText({ ...declaration, name, type });
        if (scope) {
            const last = scope.declarations[scope.declarations.length - 1];
            const scopeIndent = this.indentOf(scope.$cstNode!.offset);
            if (last) {
                const firstOffset = scope.declarations[0].$cstNode!.offset;
                const indent = this.isAtLineStart(firstOffset) ? this.indentOf(firstOffset) : scopeIndent + this.indentUnit;
                const offset = this.endOfLineAfter(last.$cstNode!.end);
                return { edits: [{ offset, length: 0, text: `\n${indent}${text}` }] };
            }
            const colon = GrammarUtils.findNodeForKeyword(scope.$cstNode, ':')!;
            const offset = this.endOfLineAfter(colon.end);
            return { edits: [{ offset, length: 0, text: `\n${scopeIndent}${this.indentUnit}${text}` }] };
        }
        // create the scope
        const header = scopeName === 'internal' ? 'internal:' : scopeName ? `interface ${scopeName}:` : 'interface:';
        const indent = this.childIndent(this.machine);
        const block = `${indent}${header}\n${indent}${this.indentUnit}${text}`;
        const firstScope = this.machine.scopes[0];
        if (!scopeName && firstScope && this.isAtLineStart(firstScope.$cstNode!.offset)) {
            // the unnamed interface comes first
            const lineStart = this.text.lastIndexOf('\n', firstScope.$cstNode!.offset - 1) + 1;
            return { edits: [{ offset: lineStart, length: 0, text: `${block}\n\n` }] };
        }
        const cst = this.machine.$cstNode!;
        const anchors = [
            GrammarUtils.findNodeForProperty(cst, 'namespace'),
            ...containerAnnotations(this.machine).map(a => a.$cstNode),
            ...this.machine.scopes.map(s => s.$cstNode)
        ].filter((n): n is CstNode => !!n);
        const anchor = anchors.sort((a, b) => a.end - b.end)[anchors.length - 1];
        if (anchor) {
            const offset = this.endOfLineAfter(anchor.end);
            return { edits: [{ offset, length: 0, text: `\n\n${block}` }] };
        }
        const { open } = this.braces(this.machine);
        const offset = this.endOfLineAfter(open + 1);
        const hasMembers = this.members(this.machine).length > 0;
        return { edits: [{ offset, length: 0, text: `\n${block}${hasMembers ? '\n' : ''}` }] };
    }

    /** Changes the source or target of a transition. */
    reconnectTransition(transition: ast.Transition, end: 'source' | 'target', vertex: ast.Vertex): EditResult {
        const cst = transition.$cstNode!;
        const node = end === 'source'
            ? (transition.initial ? GrammarUtils.findNodeForProperty(cst, 'initial') : transition.source?.$refNode)
            : (transition.final ? GrammarUtils.findNodeForProperty(cst, 'final') : transition.target?.$refNode);
        if (!node) {
            throw new EditError('Cannot reconnect the transition.');
        }
        return { edits: [{ offset: node.offset, length: node.length, text: referenceName(vertex, scopeOf(transition)) }], selectOffset: cst.offset };
    }

    /** Moves a vertex (including its content) into another container. */
    moveVertex(vertex: ast.Vertex, target: ScopeContainer): EditResult {
        const container = ast.isState(target) && target.regions.length > 0 ? target.regions[0] : target;
        if (isAncestorOrSelf(vertex, container)) {
            throw new EditError(`Cannot move '${vertex.name}' into itself.`);
        }
        if (vertex.$container === container) {
            return { edits: [] };
        }
        if (ast.isState(container) && container.regions.length > 0) {
            throw new EditError(`State '${container.name}' has regions.`);
        }
        const deletion = this.deletionEdit(this.rangeOf(vertex));
        const moved = this.nodeText(vertex, '').split('\n');
        const comment = this.trailingComment(vertex.$cstNode!.end);
        if (comment) {
            moved[moved.length - 1] += ' ' + comment;
        }
        const { edit, memberOffset } = this.insertMember(container, moved, 'afterVertices');
        const edits = [deletion, edit];
        this.checkOverlaps(edits);
        return { edits, selectOffset: mapOffset(edit.offset, [deletion]) + (memberOffset - edit.offset) };
    }

    /**
     * Deletes the given elements. Transitions which start or end in a deleted vertex are
     * removed as well.
     */
    deleteElements(targets: DeletionTarget[]): EditResult {
        const nodes = new Set<AstNode>();
        for (const target of targets) {
            if ('initialOf' in target) {
                target.initialOf.transitions.filter(t => t.initial).forEach(t => nodes.add(t));
            } else if ('finalOf' in target) {
                target.finalOf.transitions.filter(t => t.final).forEach(t => nodes.add(t));
            } else if (!ast.isStateMachine(target)) {
                nodes.add(target);
            }
        }
        const deletedVertices = new Set<AstNode>();
        for (const node of nodes) {
            if (ast.isVertex(node)) {
                deletedVertices.add(node);
            }
            AstUtils.streamAllContents(node).filter(ast.isVertex).forEach(v => deletedVertices.add(v));
        }
        for (const transition of allTransitions(this.machine)) {
            const source = transition.source?.ref;
            const target = transition.target?.ref;
            if ((source && deletedVertices.has(source)) || (target && deletedVertices.has(target))) {
                nodes.add(transition);
            }
        }
        // drop nodes which are contained in other deleted nodes
        const roots = [...nodes].filter(node => ![...nodes].some(other => other !== node && isAncestorOrSelf(other, node)));
        const edits = roots
            .filter(node => node.$cstNode)
            .map(node => this.deletionEdit(this.rangeOf(node)));
        // states which lose all their members become simple states again: `state A { }` -> `state A`
        const parents = new Set(roots.map(node => node.$container).filter(ast.isState));
        for (const state of parents) {
            if (!nodes.has(state) && this.members(state).every(member => nodes.has(member))) {
                const header = GrammarUtils.findNodeForProperty(state.$cstNode, 'description')
                    ?? GrammarUtils.findNodeForProperty(state.$cstNode, 'name');
                if (header) {
                    edits.push({ offset: header.end, length: state.$cstNode!.end - header.end, text: '' });
                }
            }
        }
        edits.sort((a, b) => a.offset - b.offset);
        // merge overlapping ranges (line extension may cause touching ranges)
        const merged: TextEdit[] = [];
        for (const edit of edits) {
            const last = merged[merged.length - 1];
            if (last && edit.offset < last.offset + last.length) {
                const end = Math.max(last.offset + last.length, edit.offset + edit.length);
                last.length = end - last.offset;
            } else {
                merged.push({ ...edit });
            }
        }
        return { edits: merged };
    }

    // ---------------------------------------------------------------------------------------
    // Helpers

    freshName(prefix: string): string {
        const names = new Set(allVertices(this.machine).map(v => v.name));
        let index = 1;
        while (names.has(`${prefix}${index}`)) {
            index++;
        }
        return `${prefix}${index}`;
    }

    /** Checks that `name` is a valid identifier and not used by a sibling in the given container. */
    private checkNewName(name: string, container: AstNode, except?: ast.Vertex): void {
        if (!isValidIdentifier(name)) {
            throw new EditError(`'${name}' is not a valid name. Use letters, digits and '_' (no keywords).`);
        }
        if (siblingVertices(container).some(v => v !== except && v.name === name)) {
            throw new EditError(`A state named '${name}' already exists here.`);
        }
    }

    private checkOverlaps(edits: TextEdit[]): void {
        const sorted = [...edits].sort((a, b) => a.offset - b.offset);
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i].offset < sorted[i - 1].offset + sorted[i - 1].length) {
                throw new EditError('The requested change is not possible.');
            }
        }
    }

    /** Leading whitespace of the line containing the offset. */
    private indentOf(offset: number): string {
        const start = this.text.lastIndexOf('\n', offset - 1) + 1;
        return /^[ \t]*/.exec(this.text.substring(start))![0];
    }

    /** Indentation used for members of the given container. */
    private childIndent(container: ScopeContainer): string {
        const members = this.members(container);
        for (const member of members) {
            const offset = member.$cstNode!.offset;
            if (this.isAtLineStart(offset)) {
                return this.indentOf(offset);
            }
        }
        return this.indentOf(container.$cstNode!.offset) + this.indentUnit;
    }

    private isAtLineStart(offset: number): boolean {
        const start = this.text.lastIndexOf('\n', offset - 1) + 1;
        return this.text.substring(start, offset).trim() === '';
    }

    private members(container: ScopeContainer): AstNode[] {
        const result: AstNode[] = [...container.vertices, ...container.transitions];
        if (ast.isState(container)) {
            result.push(...container.reactions, ...container.regions);
        } else if (ast.isStateMachine(container)) {
            // the definition section precedes the vertices
            result.push(...containerAnnotations(container), ...container.scopes);
        }
        return result.filter(n => n.$cstNode).sort((a, b) => a.$cstNode!.offset - b.$cstNode!.offset);
    }

    private braces(container: ScopeContainer): { open: number, close: number } {
        const cst = container.$cstNode!;
        const open = GrammarUtils.findNodeForKeyword(cst, '{');
        const close = this.text.charAt(cst.end - 1) === '}' ? cst.end - 1 : -1;
        if (!open || close < 0) {
            throw new EditError('The model contains syntax errors. Please fix them first.');
        }
        return { open: open.offset, close };
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
     * Inserts a member into a container. `lines` are the lines of the new member without
     * indentation. Returns the edit and the offset of the member in the resulting text.
     */
    private insertMember(container: ScopeContainer, lines: string[], position: 'start' | 'afterVertices' | 'end'): { edit: TextEdit, memberOffset: number } {
        const cst = container.$cstNode;
        if (!cst) {
            throw new EditError('The model contains syntax errors. Please fix them first.');
        }
        const containerIndent = this.indentOf(cst.offset);
        const indent = this.childIndent(container);
        const memberText = lines.map((line, i) => (i === 0 ? '' : indent) + line).join('\n');

        if (ast.isState(container) && !GrammarUtils.findNodeForKeyword(cst, '{')) {
            // simple state without body: create one
            const prefix = ` {\n${indent}`;
            const edit = { offset: cst.end, length: 0, text: `${prefix}${memberText}\n${containerIndent}}` };
            return { edit, memberOffset: cst.end + prefix.length };
        }
        const { open, close } = this.braces(container);
        const members = this.members(container);
        let anchor: AstNode | undefined;
        if (position === 'end') {
            anchor = members[members.length - 1];
        } else if (position === 'afterVertices') {
            const structural = members.filter(m => !ast.isTransition(m));
            anchor = structural[structural.length - 1];
        }
        if (anchor) {
            const offset = this.endOfLineAfter(anchor.$cstNode!.end);
            // separate the first vertex from the definition section by an empty line
            const prefix = ast.isScope(anchor) || ast.isAnnotation(anchor) ? `\n\n${indent}` : `\n${indent}`;
            return { edit: { offset, length: 0, text: prefix + memberText }, memberOffset: offset + prefix.length };
        }
        const namespace = ast.isStateMachine(container) ? GrammarUtils.findNodeForProperty(cst, 'namespace') : undefined;
        if (namespace) {
            const offset = this.endOfLineAfter(namespace.end);
            const prefix = `\n\n${indent}`;
            return { edit: { offset, length: 0, text: prefix + memberText }, memberOffset: offset + prefix.length };
        }
        const first = members[0];
        if (first && this.isAtLineStart(first.$cstNode!.offset)) {
            const lineStart = this.text.lastIndexOf('\n', first.$cstNode!.offset - 1) + 1;
            return { edit: { offset: lineStart, length: 0, text: `${indent}${memberText}\n` }, memberOffset: lineStart + indent.length };
        }
        if (first) {
            const prefix = `\n${indent}`;
            return { edit: { offset: open + 1, length: 0, text: prefix + memberText }, memberOffset: open + 1 + prefix.length };
        }
        // empty body: replace the whole interior (keeps comments out of the way)
        const interior = this.text.substring(open + 1, close);
        const comments = interior.trim() ? interior.trimEnd() : '';
        const prefix = `${comments}\n${indent}`;
        return {
            edit: { offset: open + 1, length: close - open - 1, text: `${prefix}${memberText}\n${containerIndent}` },
            memberOffset: open + 1 + prefix.length
        };
    }

    /** Text of a node re-indented for the given indentation (first line without indentation). */
    private nodeText(node: AstNode, indent: string): string {
        const cst = this.rangeOf(node);
        const originalIndent = this.indentOf(cst.offset);
        const lines = this.text.substring(cst.offset, cst.end).split('\n');
        return lines.map((line, i) => {
            if (i === 0) {
                return line;
            }
            return line.startsWith(originalIndent) ? indent + line.substring(originalIndent.length) : line;
        }).join('\n');
    }

    /**
     * Text range of a node; for vertices, regions and transitions including their annotations (also those
     * parsed into the state machine, see model-annotations.ts).
     */
    private rangeOf(node: AstNode): { offset: number, end: number } {
        const cst = node.$cstNode!;
        if (ast.isVertex(node) || ast.isRegion(node) || ast.isTransition(node)) {
            return { offset: Math.min(cst.offset, elementStart(node) ?? cst.offset), end: cst.end };
        }
        return cst;
    }

    /** Deletes the text of the node including the whole line if nothing else remains on it. */
    private deletionEdit(cst: { offset: number, end: number }): TextEdit {
        let start = cst.offset;
        let end = cst.end;
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
            // other content follows on the same line: remove trailing blanks
            while (end < this.text.length && (this.text[end] === ' ' || this.text[end] === '\t')) {
                end++;
            }
        }
        return { offset: start, length: end - start, text: '' };
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

/** All references to vertices (transition end points and `active(...)` expressions). */
function vertexReferences(machine: ast.StateMachine): Array<Reference<ast.Vertex>> {
    const result: Array<Reference<ast.Vertex>> = [];
    for (const node of AstUtils.streamAllContents(machine)) {
        if (ast.isTransition(node)) {
            if (node.source) {
                result.push(node.source);
            }
            if (node.target) {
                result.push(node.target);
            }
        } else if (ast.isActiveExpression(node)) {
            result.push(node.state);
        }
    }
    return result;
}

/**
 * Vertices whose names must differ from the name of a vertex in the given container: the vertices
 * of the owning state including all its regions (regions are transparent in qualified names).
 */
export function siblingVertices(container: AstNode): ast.Vertex[] {
    const owner = ast.isRegion(container) ? container.$container : container;
    if (ast.isState(owner)) {
        return [...owner.vertices, ...owner.regions.flatMap(r => r.vertices)];
    }
    return isScopeContainer(owner) ? owner.vertices : [];
}

/** Text of a new declaration, e.g. `in event open : integer` or `operation log(msg : string) : void`. */
export function declarationText(declaration: NewDeclaration): string {
    const name = declaration.name.trim();
    const type = declaration.type?.trim();
    const value = declaration.value?.trim();
    const typeSuffix = type ? ` : ${type}` : '';
    switch (declaration.kind) {
        case 'in event':
        case 'out event':
            return `${declaration.kind} ${name}${typeSuffix}`;
        case 'internal event':
            return `event ${name}${typeSuffix}`;
        case 'var':
        case 'const':
            return `${declaration.kind} ${name}${typeSuffix}${value ? ` = ${value}` : ''}`;
        case 'operation':
            return `operation ${name.includes('(') ? name : `${name}()`}${typeSuffix}`;
    }
}

/** The unguarded `entry /` or `exit /` reaction of a state. */
export function stateAction(state: ast.State, kind: 'entry' | 'exit'): ast.LocalReaction | undefined {
    return state.reactions.find(r => r.guard === undefined && r.triggers.length === 1
        && ast.isBuiltinTrigger(r.triggers[0]) && r.triggers[0].kind === kind);
}

function defaultNamePrefix(kind: NewVertexKind): string {
    switch (kind) {
        case 'state': return 'State';
        case 'choice': return 'Choice';
        case 'junction': return 'Junction';
        case 'history': return 'H';
        case 'deephistory': return 'DeepH';
        case 'sync': return 'Sync';
        case 'entry': return 'Entry';
        case 'exit': return 'Exit';
    }
}
