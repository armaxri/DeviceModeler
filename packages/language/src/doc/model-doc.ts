import { AstUtils, type AstNode } from 'langium';
import { semanticAnnotations } from '../model-annotations.js';
import * as ast from '../generated/ast.js';
import { qualifiedName } from '../statemachine-scope.js';
import { eventDirection, typeName, typeOfAlias, typeOfEvent, typeOfParameter, typeOfVariable, returnTypeOf } from '../typesystem.js';
import { nodeText, outgoingTransitions, scopeOf, transitionPriority, type ScopeContainer } from '../model-utils.js';
import { docComment } from './doc-comments.js';
import { isDevmTypeReference, writtenCppType } from '../class-members.js';

/*
 * Documentation of state machines: a structured description of a model (`describeStateMachine`) and
 * its rendering as a Markdown or a self-contained HTML page (`generateModelDoc`), plus an index page
 * (`generateDocIndex`). Pure functions without I/O; the CLI (`devm doc`) writes the files.
 */

export type DocFormat = 'md' | 'html';

export interface EventDoc {
    name: string;
    direction: 'in' | 'out' | 'internal';
    /** Type of the value (`void` for events without value). */
    type: string;
    documentation?: string;
}

export interface VariableDoc {
    name: string;
    type: string;
    constant: boolean;
    readonly: boolean;
    /** Source text of the initial value (undefined: the default value of the type). */
    initialValue?: string;
    documentation?: string;
}

export interface OperationDoc {
    name: string;
    /** `name(a : integer, values... : string) : boolean` */
    signature: string;
    parameters: Array<{ name: string, type: string, varArgs: boolean }>;
    returnType: string;
    documentation?: string;
}

export interface ScopeDoc {
    /** `public`, `protected`, `private`: a C++ class section (its types are the C++ types as written). */
    kind: 'interface' | 'internal' | 'public' | 'protected' | 'private';
    /** Name of a named interface. */
    name?: string;
    documentation?: string;
    events: EventDoc[];
    variables: VariableDoc[];
    operations: OperationDoc[];
    /** Type aliases (`alias Name : type`). */
    typeAliases: TypeAliasDoc[];
}

export interface TypeAliasDoc {
    name: string;
    /** The aliased type as written (`integer`, `OtherAlias`). */
    type: string;
    /** The resolved built-in type. */
    baseType: string;
    documentation?: string;
}

export interface VertexDoc {
    /** Qualified name (`Closed.Active.Playing`). */
    name: string;
    /** `state`, `composite state`, `orthogonal state` or the kind of a pseudo state (`choice`, `entry point`, …). */
    kind: string;
    /** Qualified name of the parent state, if any (with the name of the region: `Service (region Lock)`). */
    parent?: string;
    /** Description string of a state (`state Open "Tray is open"`). */
    description?: string;
    documentation?: string;
    /** Local reactions with the trigger `entry` / `exit` (without the trigger), other local reactions. */
    entry: string[];
    exit: string[];
    reactions: string[];
    /** Names (simple) of the direct sub vertices, per region for orthogonal states (`Lock: Unlocked, Locked`). */
    subStates: string[];
}

export interface TransitionDoc {
    /** Qualified name of the source vertex or `[*]` (initial pseudo state of `scope`). */
    source: string;
    /** Qualified name of the target vertex or `[*]` (final state of `scope`). */
    target: string;
    /** Scope of `[*]`: name of the state machine or of the (qualified) state / region. */
    scope: string;
    triggers: string[];
    guard?: string;
    effect?: string;
    /** `>E` (entry point of the target; only the first one is used) and `X>` (exit nodes of the source). */
    entryPoints: string[];
    exitPoints: string[];
    /** Priority among the outgoing transitions of the source (if there are several). */
    priority?: number;
    documentation?: string;
}

export interface ExecutionDoc {
    mode: 'cycle' | 'event';
    /** Cycle period in ms (source text, `200` if not given). */
    period?: string;
    order: 'parent-first' | 'child-first';
    /** All annotations as written in the model. */
    annotations: string[];
}

export interface StateMachineDoc {
    name: string;
    namespace?: string;
    description?: string;
    documentation?: string;
    execution: ExecutionDoc;
    scopes: ScopeDoc[];
    /** Local reactions of the state machine itself. */
    reactions: string[];
    vertices: VertexDoc[];
    transitions: TransitionDoc[];
}

/** Collects the documentation of a state machine: declarations, states, transitions and doc comments. */
export function describeStateMachine(machine: ast.StateMachine): StateMachineDoc {
    const annotation = (name: string) => machine.annotations.find(a => a.name === name);
    const cycleBased = annotation('CycleBased');
    const mode = annotation('EventDriven') && !cycleBased ? 'event' : 'cycle';
    const vertices: VertexDoc[] = [];
    const visit = (container: ScopeContainer) => {
        for (const vertex of container.vertices) {
            vertices.push(describeVertex(vertex));
            if (ast.isState(vertex)) {
                visit(vertex);
                vertex.regions.forEach(visit);
            }
        }
    };
    visit(machine);
    return {
        name: machine.name,
        namespace: machine.namespace,
        description: machine.description,
        documentation: docComment(machine),
        execution: {
            mode,
            period: mode === 'cycle' ? (cycleBased?.arguments[0] ? nodeText(cycleBased.arguments[0]) : '200') : undefined,
            order: annotation('ChildFirstExecution') ? 'child-first' : 'parent-first',
            annotations: semanticAnnotations(machine).map(a => nodeText(a))
        },
        scopes: machine.scopes.map(describeScope),
        reactions: machine.reactions.map(r => nodeText(r)),
        vertices,
        transitions: AstUtils.streamAllContents(machine).filter(ast.isTransition).toArray()
            .sort((a, b) => (a.$cstNode?.offset ?? 0) - (b.$cstNode?.offset ?? 0))
            .map(describeTransition)
    };
}

function describeScope(scope: ast.Scope): ScopeDoc {
    const result: ScopeDoc = {
        kind: ast.isInternalScope(scope) ? 'internal' : ast.isClassScope(scope) ? scope.access : 'interface',
        name: ast.isInterfaceScope(scope) ? scope.name : undefined,
        documentation: docComment(scope),
        events: [],
        variables: [],
        operations: [],
        typeAliases: []
    };
    // the C++ class sections show the C++ types as written (`unsigned int`, `const app::Config&`)
    const typeText = (reference: ast.TypeReference | undefined, type: () => string) =>
        ast.isClassScope(scope) && reference && !isDevmTypeReference(reference) ? writtenCppType(reference) : type();
    for (const declaration of scope.declarations) {
        const documentation = docComment(declaration);
        if (ast.isEventDeclaration(declaration)) {
            result.events.push({ name: declaration.name, direction: eventDirection(declaration), type: typeName(typeOfEvent(declaration)), documentation });
        } else if (ast.isVariableDeclaration(declaration)) {
            result.variables.push({
                name: declaration.name,
                type: typeText(declaration.type, () => typeName(typeOfVariable(declaration))),
                constant: declaration.const,
                readonly: declaration.readonly,
                initialValue: declaration.initialValue ? nodeText(declaration.initialValue) : undefined,
                documentation
            });
        } else if (ast.isTypeAliasDeclaration(declaration)) {
            result.typeAliases.push({ name: declaration.name, type: declaration.type?.name ?? '', baseType: typeName(typeOfAlias(declaration)), documentation });
        } else {
            const parameters = declaration.parameters.map(p => ({ name: p.name, type: typeText(p.type, () => typeName(typeOfParameter(p))), varArgs: p.varArgs }));
            const returnType = typeText(declaration.returnType, () => typeName(returnTypeOf(declaration)));
            const signature = `${declaration.const ? 'const ' : ''}${declaration.name}(${parameters.map(p => `${p.name}${p.varArgs ? '...' : ''} : ${p.type}`).join(', ')}) : ${returnType}`;
            result.operations.push({ name: declaration.name, signature, parameters, returnType, documentation });
        }
    }
    return result;
}

const PSEUDO_KINDS: Record<string, string> = {
    choice: 'choice',
    junction: 'junction',
    history: 'shallow history',
    deephistory: 'deep history',
    sync: 'synchronization',
    entry: 'entry point',
    exit: 'exit node'
};

function describeVertex(vertex: ast.Vertex): VertexDoc {
    const result: VertexDoc = {
        name: qualifiedName(vertex),
        kind: '',
        parent: parentName(vertex),
        documentation: docComment(vertex),
        entry: [],
        exit: [],
        reactions: [],
        subStates: []
    };
    if (ast.isPseudoState(vertex)) {
        result.kind = PSEUDO_KINDS[vertex.kind] ?? vertex.kind;
        return result;
    }
    result.kind = vertex.regions.length > 0 ? 'orthogonal state' : vertex.vertices.length > 0 ? 'composite state' : 'state';
    result.description = vertex.description;
    for (const reaction of vertex.reactions) {
        const builtin = reaction.triggers.length === 1 && ast.isBuiltinTrigger(reaction.triggers[0]) ? reaction.triggers[0].kind : undefined;
        if (builtin === 'entry' || builtin === 'exit') {
            const guard = reaction.guard ? `[${nodeText(reaction.guard)}] / ` : '';
            (builtin === 'entry' ? result.entry : result.exit).push(guard + nodeText(reaction.effect));
        } else {
            result.reactions.push(nodeText(reaction));
        }
    }
    if (vertex.regions.length > 0) {
        vertex.regions.forEach((region, i) => {
            const names = region.vertices.map(v => v.name).join(', ');
            result.subStates.push(`${region.name ?? `region ${i + 1}`}: ${names}`);
        });
    } else {
        result.subStates.push(...vertex.vertices.map(v => v.name));
    }
    return result;
}

function parentName(vertex: ast.Vertex): string | undefined {
    const container = vertex.$container;
    if (ast.isState(container)) {
        return qualifiedName(container);
    }
    if (ast.isRegion(container)) {
        return `${qualifiedName(container.$container)} (region ${container.name ?? container.$container.regions.indexOf(container) + 1})`;
    }
    return undefined;
}

function scopeName(container: ScopeContainer): string {
    if (ast.isStateMachine(container)) {
        return container.name;
    }
    if (ast.isState(container)) {
        return qualifiedName(container);
    }
    return `${qualifiedName(container.$container)} (region ${container.name ?? container.$container.regions.indexOf(container) + 1})`;
}

function describeTransition(transition: ast.Transition): TransitionDoc {
    const spec = transition.spec;
    const source = transition.source?.ref;
    const priority = source && !transition.initial ? transitionPriority(transition, outgoingTransitions(source)) : undefined;
    return {
        source: transition.initial ? '[*]' : source ? qualifiedName(source) : transition.source?.$refText ?? '?',
        target: transition.final ? '[*]' : transition.target?.ref ? qualifiedName(transition.target.ref) : transition.target?.$refText ?? '?',
        scope: scopeName(scopeOf(transition)),
        triggers: spec?.triggers.map(t => nodeText(t)) ?? [],
        guard: spec?.guard ? nodeText(spec.guard) : undefined,
        effect: spec?.effect ? nodeText(spec.effect) : undefined,
        entryPoints: [...transition.entryPoints],
        exitPoints: [...transition.exitPoints],
        priority,
        documentation: docComment(transition)
    };
}

// ---------------------------------------------------------------------------------------------
// Rendering

export interface ModelDocOptions {
    /** Default: `md`. */
    format?: DocFormat;
    /**
     * SVG document of the diagram (`renderSvg`), inlined into HTML pages. Markdown pages reference
     * `svgFile` instead.
     */
    svg?: string;
    /** File name of the diagram relative to the page (Markdown: `![…](svgFile)`, HTML without `svg`: `<img>`). */
    svgFile?: string;
    /** Path of the model file shown on the page. */
    source?: string;
    /** Link to the model file (relative to the page), if any. */
    sourceHref?: string;
    /** File name of the index page (link back), if any. */
    indexFile?: string;
}

/** Renders the documentation page of a state machine as Markdown (GitHub flavored) or as a self-contained HTML page. */
export function generateModelDoc(machine: ast.StateMachine | StateMachineDoc, options: ModelDocOptions = {}): string {
    const doc = ast.isStateMachine(machine as AstNode) ? describeStateMachine(machine as ast.StateMachine) : machine as StateMachineDoc;
    const writer = (options.format ?? 'md') === 'html' ? new HtmlWriter() : new MarkdownWriter();
    return writeDoc(doc, writer, options);
}

export interface DocIndexEntry {
    name: string;
    /** File name of the page relative to the index. */
    file: string;
    description?: string;
    documentation?: string;
    source?: string;
    /** Link to the model file (relative to the index), if any. */
    sourceHref?: string;
}

/** Renders an index page linking the documentation pages of several state machines. */
export function generateDocIndex(entries: DocIndexEntry[], format: DocFormat = 'md', title = 'State machines'): string {
    const w = format === 'html' ? new HtmlWriter() : new MarkdownWriter();
    w.heading(1, w.text(title));
    w.table(['State machine', 'Description', 'Source'], entries.map(e => [
        w.link(w.text(e.name), e.file),
        joinDescription(w, e.description, e.documentation, true),
        e.source ? (e.sourceHref ? w.link(w.code(e.source), e.sourceHref) : w.code(e.source)) : ''
    ]));
    return w.finish(title);
}

function joinDescription(w: DocWriter, description: string | undefined, documentation: string | undefined, firstParagraph = false): string {
    const parts: string[] = [];
    if (description) {
        parts.push(w.text(description));
    }
    if (documentation) {
        parts.push(w.markdownInline(firstParagraph ? documentation.split(/\n\s*\n/)[0] : documentation));
    }
    return parts.join(w.lineBreak);
}

function writeDoc(doc: StateMachineDoc, w: DocWriter, options: ModelDocOptions): string {
    if (options.indexFile) {
        w.paragraph(w.link(w.text('← All state machines'), options.indexFile));
    }
    w.heading(1, w.text(doc.name));
    if (doc.description) {
        w.quote(w.text(doc.description));
    }
    if (doc.documentation) {
        w.markdownBlock(doc.documentation);
    }
    if (options.source) {
        const source = w.code(options.source);
        w.paragraph(`${w.text('Source: ')}${options.sourceHref ? w.link(source, options.sourceHref) : source}`);
    }
    if (options.svg && w instanceof HtmlWriter) {
        w.raw(`<figure class="diagram">${stripXmlDeclaration(options.svg)}</figure>`);
    } else if (options.svgFile) {
        w.image(`${doc.name} diagram`, options.svgFile);
    }

    w.heading(2, w.text('Execution'));
    const execution = doc.execution;
    w.table(['Property', 'Value'], [
        ['Execution', execution.mode === 'cycle'
            ? `${w.text('cycle based, period ')}${w.code(`${execution.period} ms`)}`
            : w.text('event driven')],
        ['Order', w.text(execution.order === 'child-first'
            ? 'child first (inner states react before their parents)'
            : 'parent first (parent states react before their sub states)')],
        ...(doc.namespace ? [['Namespace', w.code(doc.namespace)]] : []),
        ...(execution.annotations.length > 0 ? [['Annotations', execution.annotations.map(a => w.code(a)).join(' ')]] : [])
    ]);

    if (doc.scopes.length > 0) {
        w.heading(2, w.text('Interfaces'));
        for (const scope of doc.scopes) {
            const heading = scope.kind === 'internal' ? w.text('Internal scope')
                : scope.kind !== 'interface' ? `${w.text('C++ class section ')}${w.code(`${scope.kind}:`)}`
                : scope.name ? `${w.text('Interface ')}${w.code(scope.name)}` : w.text('Interface');
            w.heading(3, heading);
            if (scope.documentation) {
                w.markdownBlock(scope.documentation);
            }
            if (scope.events.length > 0) {
                w.paragraph(w.strong('Events'));
                w.table(['Event', 'Direction', 'Type', 'Description'], scope.events.map(e => [
                    w.code(e.name), w.text(e.direction), e.type === 'void' ? '' : w.code(e.type), description(w, e.documentation)
                ]));
            }
            if (scope.variables.length > 0) {
                w.paragraph(w.strong('Variables and constants'));
                w.table(['Name', 'Kind', 'Type', 'Initial value', 'Description'], scope.variables.map(v => [
                    w.code(v.name),
                    w.text(v.constant ? 'const' : v.readonly ? 'var readonly' : 'var'),
                    w.code(v.type),
                    v.initialValue !== undefined ? w.code(v.initialValue) : w.text('(default)'),
                    description(w, v.documentation)
                ]));
            }
            if (scope.operations.length > 0) {
                w.paragraph(w.strong('Operations'));
                w.table(['Operation', 'Return type', 'Description'], scope.operations.map(o => [
                    w.code(o.signature.replace(/ : [^:]*$/, '')), w.code(o.returnType), description(w, o.documentation)
                ]));
            }
            if (scope.typeAliases.length > 0) {
                w.paragraph(w.strong('Type aliases'));
                w.table(['Alias', 'Type', 'Description'], scope.typeAliases.map(a => [
                    w.code(a.name), w.code(a.type === a.baseType ? a.type : `${a.type} (${a.baseType})`), description(w, a.documentation)
                ]));
            }
            if (scope.events.length + scope.variables.length + scope.operations.length + scope.typeAliases.length === 0) {
                w.paragraph(w.text('(no declarations)'));
            }
        }
    }
    if (doc.reactions.length > 0) {
        w.heading(3, w.text('Reactions of the state machine'));
        w.list(doc.reactions.map(r => w.code(r)));
    }

    if (doc.vertices.length > 0) {
        w.heading(2, w.text('States'));
        w.table(['State', 'Kind', 'Description', 'Entry', 'Exit', 'Local reactions', 'Sub states'], doc.vertices.map(v => [
            w.code(v.name),
            w.text(v.kind),
            joinDescription(w, v.description, v.documentation),
            codeLines(w, v.entry),
            codeLines(w, v.exit),
            codeLines(w, v.reactions),
            v.subStates.map(s => w.text(s)).join(w.lineBreak)
        ]));
    }

    if (doc.transitions.length > 0) {
        w.heading(2, w.text('Transitions'));
        w.table(['Source', 'Target', 'Trigger', 'Guard', 'Effect', 'Priority', 'Description'], doc.transitions.map(t => [
            t.source === '[*]' ? `${w.code('[*]')} ${w.text(`(initial, ${t.scope})`)}` : w.code(t.source) + (t.exitPoints.length > 0 ? ` ${w.text('via exit')} ${t.exitPoints.map(x => w.code(x)).join(w.text(' / '))}` : ''),
            t.target === '[*]' ? `${w.code('[*]')} ${w.text(`(final, ${t.scope})`)}` : w.code(t.target) + (t.entryPoints.length > 0 ? ` ${w.text('via entry')} ${w.code(t.entryPoints[0])}` : ''),
            t.triggers.map(tr => w.code(tr)).join(', '),
            t.guard ? w.code(t.guard) : '',
            t.effect ? w.code(t.effect) : '',
            t.priority !== undefined ? String(t.priority) : '',
            description(w, t.documentation)
        ]));
    }
    return w.finish(doc.name);
}

function description(w: DocWriter, documentation: string | undefined): string {
    return documentation ? w.markdownInline(documentation) : '';
}

function codeLines(w: DocWriter, lines: string[]): string {
    return lines.map(line => w.code(line)).join(w.lineBreak);
}

function stripXmlDeclaration(svg: string): string {
    return svg.replace(/^<\?xml[^>]*\?>\s*/, '');
}

/** Minimal writer interface shared by the Markdown and the HTML output. Text arguments are already formatted. */
abstract class DocWriter {
    protected readonly out: string[] = [];
    abstract readonly lineBreak: string;
    abstract text(value: string): string;
    abstract code(value: string): string;
    abstract strong(value: string): string;
    abstract link(label: string, href: string): string;
    /** Documentation comment (Markdown) inside a table cell. */
    abstract markdownInline(markdown: string): string;
    abstract markdownBlock(markdown: string): void;
    abstract heading(level: number, content: string): void;
    abstract paragraph(content: string): void;
    abstract quote(content: string): void;
    abstract image(alt: string, src: string): void;
    abstract list(items: string[]): void;
    abstract table(header: string[], rows: string[][]): void;
    raw(content: string): void {
        this.out.push(content);
    }
    abstract finish(title: string): string;
}

class MarkdownWriter extends DocWriter {
    readonly lineBreak = '<br>';

    text(value: string): string {
        return value.replace(/([\\`*_[\]<>|#])/g, '\\$1').replace(/\r?\n/g, ' ');
    }

    code(value: string): string {
        const text = value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
        const fence = text.includes('`') ? '``' : '`';
        return `${fence}${fence.length > 1 ? ' ' : ''}${text}${fence.length > 1 ? ' ' : ''}${fence}`;
    }

    strong(value: string): string {
        return `**${value}**`;
    }

    link(label: string, href: string): string {
        return `[${label}](${encodeURI(href)})`;
    }

    markdownInline(markdown: string): string {
        // line breaks as written (the documentation comments keep them)
        return markdown.replace(/\|/g, '\\|').replace(/[ \t]*\n[ \t]*\n\s*/g, '<br><br>').replace(/[ \t]*\n[ \t]*/g, '<br>');
    }

    markdownBlock(markdown: string): void {
        this.out.push(markdown, '');
    }

    heading(level: number, content: string): void {
        this.out.push(`${'#'.repeat(level)} ${content}`, '');
    }

    paragraph(content: string): void {
        this.out.push(content, '');
    }

    quote(content: string): void {
        this.out.push(`> ${content}`, '');
    }

    image(alt: string, src: string): void {
        this.out.push(`![${this.text(alt)}](${encodeURI(src)})`, '');
    }

    list(items: string[]): void {
        this.out.push(...items.map(i => `- ${i}`), '');
    }

    table(header: string[], rows: string[][]): void {
        this.out.push(`| ${header.join(' | ')} |`, `|${header.map(() => ' --- ').join('|')}|`);
        for (const row of rows) {
            this.out.push(`| ${row.map(cell => cell || ' ').join(' | ')} |`);
        }
        this.out.push('');
    }

    finish(): string {
        while (this.out.length > 0 && this.out[this.out.length - 1] === '') {
            this.out.pop();
        }
        return this.out.join('\n') + '\n';
    }
}

class HtmlWriter extends DocWriter {
    readonly lineBreak = '<br>';

    text(value: string): string {
        return escapeHtml(value);
    }

    code(value: string): string {
        return `<code>${escapeHtml(value)}</code>`;
    }

    strong(value: string): string {
        return `<strong>${value}</strong>`;
    }

    link(label: string, href: string): string {
        return `<a href="${escapeHtml(encodeURI(href))}">${label}</a>`;
    }

    markdownInline(markdown: string): string {
        return markdown.split(/\n\s*\n/).map(p => p.split('\n').map(line => inlineMarkdownToHtml(trimSpaces(line))).join('<br>')).join('<br><br>');
    }

    markdownBlock(markdown: string): void {
        this.out.push(markdownToHtml(markdown));
    }

    heading(level: number, content: string): void {
        this.out.push(`<h${level}>${content}</h${level}>`);
    }

    paragraph(content: string): void {
        this.out.push(`<p>${content}</p>`);
    }

    quote(content: string): void {
        this.out.push(`<blockquote>${content}</blockquote>`);
    }

    image(alt: string, src: string): void {
        this.out.push(`<figure class="diagram"><img src="${escapeHtml(encodeURI(src))}" alt="${escapeHtml(alt)}"></figure>`);
    }

    list(items: string[]): void {
        this.out.push(`<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`);
    }

    table(header: string[], rows: string[][]): void {
        this.out.push('<table>', `<thead><tr>${header.map(h => `<th>${h}</th>`).join('')}</tr></thead>`, '<tbody>');
        for (const row of rows) {
            this.out.push(`<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`);
        }
        this.out.push('</tbody>', '</table>');
    }

    finish(title: string): string {
        return [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            `<title>${escapeHtml(title)}</title>`,
            `<style>${PAGE_CSS}</style>`,
            '</head>',
            '<body>',
            '<main>',
            ...this.out,
            '</main>',
            '</body>',
            '</html>',
            ''
        ].join('\n');
    }
}

const PAGE_CSS = `
body { margin: 0; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2328; background: #fff; line-height: 1.5; }
main { max-width: 1200px; margin: 0 auto; padding: 24px 32px 64px; }
h1 { border-bottom: 1px solid #d0d7de; padding-bottom: 6px; }
h2 { margin-top: 36px; border-bottom: 1px solid #d0d7de; padding-bottom: 4px; }
h3 { margin-top: 24px; }
code { font-family: "DejaVu Sans Mono", Menlo, Consolas, monospace; font-size: 85%; background: #f3f4f6; padding: 1px 4px; border-radius: 4px; }
blockquote { margin: 0 0 16px; padding: 0 12px; color: #59636e; border-left: 4px solid #d0d7de; }
table { border-collapse: collapse; margin: 8px 0 16px; font-size: 14px; }
th, td { border: 1px solid #d0d7de; padding: 4px 10px; text-align: left; vertical-align: top; }
th { background: #f6f8fa; }
pre { background: #f6f8fa; padding: 8px 12px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
figure.diagram { margin: 16px 0; overflow-x: auto; }
figure.diagram svg, figure.diagram img { max-width: none; }
a { color: #0969da; }
`;

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Converts the Markdown subset of doc comments (paragraphs with their line breaks, lists, fenced code
 * blocks, code, emphasis, links) to HTML.
 */
export function markdownToHtml(markdown: string): string {
    const html: string[] = [];
    const lines = markdown.split(/\r?\n/);
    let paragraph: string[] = [];
    let items: string[][] = [];
    const flushParagraph = () => {
        if (paragraph.length > 0) {
            html.push(`<p>${paragraph.map(line => inlineMarkdownToHtml(trimSpaces(line))).join('<br>')}</p>`);
        }
        paragraph = [];
    };
    const flushList = () => {
        if (items.length > 0) {
            html.push(`<ul>${items.map(item => `<li>${item.map(line => inlineMarkdownToHtml(trimSpaces(line))).join('<br>')}</li>`).join('')}</ul>`);
        }
        items = [];
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fence = /^\s*(`{3,}|~{3,})/.exec(line);
        if (fence) {
            flushParagraph();
            flushList();
            const code: string[] = [];
            while (++i < lines.length && !lines[i].trim().startsWith(fence[1])) {
                code.push(lines[i]);
            }
            html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        } else if (line.trim() === '') {
            flushParagraph();
            flushList();
        } else if (/^\s*([-*+]|\d+[.)]) /.test(line)) {
            flushParagraph();
            items.push([line.trim().replace(/^([-*+]|\d+[.)]) /, '')]);
        } else if (items.length > 0 && /^\s/.test(line)) {
            items[items.length - 1].push(line);
        } else {
            flushList();
            paragraph.push(line);
        }
    }
    flushParagraph();
    flushList();
    return html.join('\n');
}

function inlineMarkdownToHtml(text: string): string {
    const parts = text.split(/(`[^`]*`)/);
    return parts.map(part => {
        if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
            return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
        }
        // backslash escapes of Markdown (`\<`)
        return escapeHtml(part.replace(/\\([!-/:-@[-`{-~])/g, '$1'))
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
            .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) =>
                /^(https?:|#|\.{0,2}\/|[\w-]+\.\w+)/.test(href) ? `<a href="${href}">${label}</a>` : label)
            .replace(/\n/g, ' ');
    }).join('');
}

/** A line without leading and trailing spaces and tabs (non-breaking spaces indent lines of doc comments). */
function trimSpaces(line: string): string {
    return line.replace(/^[ \t]+|[ \t]+$/g, '');
}
