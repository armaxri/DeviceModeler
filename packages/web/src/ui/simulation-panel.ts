import type { AstNode } from 'langium';
import { declaredType, runtimeTypeOfValue, type HostValue } from 'devm-language';
import { h } from './dom.js';
import { panelSection } from './side-panel.js';
import { type LogEntry, type OperationMock, type SimulationSession } from '../simulation/session.js';
import { defaultHostValue, formatHostValue, typeLabel, valueEditor, type EditorType, type ValueEditor } from './value-editor.js';

/** Operations of the application used by the simulation panel. */
export interface SimulationPanelHost {
    /** Shows the model element in the text (and in the diagram). */
    reveal(node: AstNode): void;
    /** Toggles the breakpoint of the element selected in the diagram. */
    toggleBreakpointOfSelection(): void;
    /** Leaves the simulation mode. */
    stopSimulation(): void;
}

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5, 10];
const FLASH_MS = 1200;
/** Number of trace entries shown in the log. */
const LOG_LINES = 150;

/**
 * The simulation view (like the "Simulation" view of itemis CREATE): controls for the virtual clock,
 * buttons to raise in events, the variables (editable), operation results, out events, operation
 * calls and the execution trace. It replaces the properties panel while simulating.
 *
 * The panel is built once per session; {@link update} only changes the dynamic parts, so that input
 * elements keep their focus and state while real-time mode is running.
 */
export class SimulationPanel {

    private readonly time = h('span', { class: 'sim-time' });
    private readonly status = h('div', { class: 'sim-status' });
    private readonly errorBox = h('div', { class: 'sim-error', hidden: true });
    private readonly breakBox = h('div', { class: 'sim-break', hidden: true });
    private readonly playButton = h('button', { class: 'sim-play', title: 'Run in real time (Esc pauses)' });
    private readonly cycleButton: HTMLButtonElement;
    private readonly activeList = h('div', { class: 'sim-active' });
    private readonly variableCells = new Map<string, { row: HTMLElement, value: HTMLElement, editor?: ValueEditor, type: EditorType | undefined }>();
    private readonly eventButtons = new Map<string, HTMLElement>();
    private readonly operationCounters = new Map<OperationMock, HTMLElement>();
    private readonly outList = h('ol', { class: 'sim-log sim-records' });
    private readonly callList = h('ol', { class: 'sim-log sim-records' });
    private readonly traceList = h('ol', { class: 'sim-log' });
    private readonly lastIds = { out: -1, calls: -1, trace: -1 };
    private readonly flashed = new Map<string, number>();
    private readonly shownMessages = new Map<HTMLElement, object | undefined>();

    constructor(private readonly root: HTMLElement, private readonly session: SimulationSession, private readonly host: SimulationPanelHost) {
        const cycleBased = session.executionMode === 'cycle';
        this.cycleButton = h('button', {
            class: 'primary',
            title: cycleBased ? 'Run one cycle (Space)' : 'Perform a step without events (Space)',
            onClick: () => session.runCycle()
        }, cycleBased ? 'Run cycle' : 'Step');
        this.build();
        this.update();
    }

    private build(): void {
        const session = this.session;
        const sim = session.sim;
        const cycleBased = session.executionMode === 'cycle';
        this.playButton.addEventListener('click', () => session.isPlaying ? session.pause() : session.play());

        const advanceInput = h('input', { type: 'number', min: '0', step: 'any', value: String(cycleBased ? sim.cyclePeriod : 1000), title: 'Milliseconds' });
        const advance = () => {
            const ms = Number(advanceInput.value);
            if (Number.isFinite(ms) && ms > 0) {
                advanceInput.classList.remove('invalid');
                session.advanceTime(ms);
            } else {
                advanceInput.classList.add('invalid');
            }
        };
        advanceInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                advance();
            }
        });
        const speed = h('select', { title: 'Speed of the virtual clock in real-time mode' },
            ...SPEEDS.map(s => h('option', { value: String(s) }, `${s}×`)));
        speed.value = String(session.speed);
        speed.addEventListener('change', () => session.speed = Number(speed.value));

        const autoCycle = h('input', { type: 'checkbox', checked: session.autoCycle });
        autoCycle.addEventListener('change', () => session.autoCycle = autoCycle.checked);

        const controls = h('div', { class: 'sim-controls' },
            h('div', { class: 'sim-row' },
                this.cycleButton,
                this.playButton,
                h('button', { title: 'Restart: re-enter the state machine', onClick: () => session.restart() }, '↺ Restart')),
            h('div', { class: 'sim-row' },
                h('span', { class: 'sim-label' }, 'Advance'),
                advanceInput,
                h('span', {}, 'ms'),
                h('button', { title: cycleBased ? 'Advance the virtual clock, running the cycles that are due' : 'Advance the virtual clock, firing the time events that are due', onClick: advance }, 'Go')),
            h('div', { class: 'sim-row' },
                h('span', { class: 'sim-label' }, 'Speed'), speed,
                h('span', { class: 'spacer' }),
                this.time),
            cycleBased
                ? h('label', { class: 'sim-check', title: 'Run a cycle right after raising an event (in real-time mode the next cycle processes it)' },
                    autoCycle, h('span', {}, 'Run cycle after raising an event'))
                : undefined);

        const content: Array<HTMLElement | undefined> = [
            panelSection('sim.controls', 'Controls', [
                h('div', { class: 'sim-header' },
                    h('h2', {}, `Simulation of ${session.machine.name}`),
                    h('button', { class: 'sim-stop', title: 'Stop the simulation and return to editing', onClick: () => this.host.stopSimulation() }, '■ Stop')),
                h('div', { class: 'kind' }, cycleBased ? `Cycle based, period ${sim.cyclePeriod} ms` : 'Event driven',
                    sim.executionOrder === 'child-first' ? ', child first' : ''),
                this.status,
                this.errorBox,
                this.breakBox,
                controls]),
            section('Active states', this.activeList),
            this.eventsSection(),
            this.variablesSection(),
            this.operationsSection(),
            section('Out events', this.outList),
            this.session.operations.length > 0 ? section('Operation calls', this.callList) : undefined,
            section('Trace', this.traceList, 'Click an entry to show the element in the text'),
            panelSection('sim.tools', 'Breakpoints and logs', [h('div', { class: 'actions' },
                h('button', { title: 'Toggle the breakpoint of the state or transition selected in the diagram (or right-click it)', onClick: () => this.host.toggleBreakpointOfSelection() }, '● Toggle breakpoint'),
                h('button', {
                    title: 'Clear the logs',
                    onClick: () => {
                        session.log = [];
                        session.outEvents = [];
                        session.calls = [];
                        this.update();
                    }
                }, 'Clear logs')),
            h('p', { class: 'hint' }, 'Space: run cycle / step · Esc: pause real time · right-click a state or transition: breakpoint')])
        ];
        this.root.replaceChildren(...content.filter((e): e is HTMLElement => !!e));
    }

    private eventsSection(): HTMLElement | undefined {
        const events = this.session.events;
        if (events.length === 0) {
            return section('In events', h('p', { class: 'hint' }, 'The state machine has no in events.'));
        }
        const groups = new Map<string, HTMLElement[]>();
        for (const event of events) {
            let input: ValueEditor | undefined;
            if (event.type !== 'void') {
                input = valueEditor(event.type, defaultHostValue(event.type));
                input.element.title = `Value (${typeLabel(event.type)})`;
            }
            const button = h('button', {
                class: 'sim-event',
                title: `Raise ${event.name}${input ? ' with the value' : ''}`,
                onClick: () => {
                    let value: HostValue | undefined;
                    if (input) {
                        value = input.read();
                        if (value === undefined) {
                            return;
                        }
                    }
                    this.session.raise(event.name, value);
                }
            }, event.name);
            this.eventButtons.set(event.name, button);
            const row = h('div', { class: 'sim-event-row' }, button, input?.element);
            const list = groups.get(event.group) ?? [];
            list.push(row);
            groups.set(event.group, list);
        }
        const content: HTMLElement[] = [];
        for (const [group, rows] of groups) {
            if (groups.size > 1 || group) {
                content.push(h('div', { class: 'sim-group' }, group ? `interface ${group}` : 'interface'));
            }
            content.push(...rows);
        }
        return section('In events', content);
    }

    private variablesSection(): HTMLElement | undefined {
        const variables = this.session.variables;
        if (variables.length === 0) {
            return undefined;
        }
        const values = this.session.sim.variables;
        const rows: HTMLElement[] = [];
        let group = '';
        for (const variable of variables) {
            if (variable.group !== group) {
                group = variable.group;
                rows.push(h('tr', { class: 'sim-group-row' }, h('td', { colspan: '2' }, group)));
            }
            const declared = declaredType(variable.declaration.type);
            const runtime = this.session.sim.getVariableType?.(variable.name) ?? runtimeTypeOfValue(this.session.sim.getValue?.(variable.name));
            const type: EditorType | undefined = declared && declared !== 'void' ? declared : runtime ?? (typeof values[variable.name] === 'number' ? 'number' : undefined);
            const cell = h('td', { class: 'sim-value' });
            let editor: ValueEditor | undefined;
            if (variable.editable) {
                editor = valueEditor(type, values[variable.name]);
                editor.onChange = () => {
                    const value = editor!.read();
                    if (value !== undefined) {
                        this.session.setVariable(variable.name, value);
                    }
                };
                editor.onReset = () => editor!.set(this.session.sim.variables[variable.name]);
                cell.append(editor.element);
            }
            const prefix = variable.declaration.const ? 'const ' : variable.declaration.readonly ? 'readonly ' : '';
            const row = h('tr', {},
                h('td', { class: 'sim-name', title: `${prefix}${variable.name}${type ? ` : ${typeLabel(type)}` : ''}` }, variable.name), cell);
            rows.push(row);
            this.variableCells.set(variable.name, { row, value: cell, editor, type });
        }
        return section('Variables', h('table', { class: 'sim-table' }, h('tbody', {}, ...rows)));
    }

    private operationsSection(): HTMLElement | undefined {
        const operations = this.session.operations;
        if (operations.length === 0) {
            return undefined;
        }
        const rows = operations.map(operation => {
            const counter = h('td', { class: 'sim-calls', title: 'Number of calls' }, '0');
            this.operationCounters.set(operation, counter);
            let result: HTMLElement = h('span', { class: 'hint' }, 'void');
            if (operation.returnType !== 'void') {
                const editor = valueEditor(operation.returnType, operation.value);
                editor.element.title = `Result returned by ${operation.name}() (${typeLabel(operation.returnType)})`;
                editor.onChange = () => {
                    const value = editor.read();
                    if (value !== undefined) {
                        this.session.setOperationResult(operation, value);
                    }
                };
                result = editor.element;
            }
            const params = operation.declaration.parameters.map(p => p.name).join(', ');
            return h('tr', {}, h('td', { class: 'sim-name', title: `${operation.name}(${params}) : ${typeLabel(operation.returnType)}` }, `${operation.name}()`),
                h('td', { class: 'sim-value' }, result), counter);
        });
        return section('Operations', h('table', { class: 'sim-table' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Operation'), h('th', {}, 'Returns'), h('th', {}, 'Calls'))),
            h('tbody', {}, ...rows)));
    }

    /** Updates the dynamic parts of the panel after the simulation changed. */
    update(): void {
        const session = this.session;
        const sim = session.sim;
        this.time.textContent = `t = ${formatTime(sim?.time ?? 0)}`;
        this.playButton.textContent = session.isPlaying ? '❚❚ Pause' : '▶ Real time';
        this.playButton.classList.toggle('active', session.isPlaying);
        const final = !!sim?.isRunning && sim.isFinal();
        const stopped = !!session.error || !sim?.isRunning;
        this.playButton.disabled = stopped || final && !session.isPlaying;
        this.cycleButton.disabled = stopped || final;
        this.eventButtons.forEach(button => (button as HTMLButtonElement).disabled = stopped);

        // status
        this.status.className = `sim-status ${session.error ? 'error' : final ? 'final' : session.isPlaying ? 'playing' : ''}`;
        this.status.textContent = session.error ? 'Stopped by an error'
            : final ? 'Final state reached – the state machine is terminated'
                : session.isPlaying ? `Running in real time (${session.speed}×)` : 'Paused';
        this.updateMessage(this.errorBox, session.error, 'Error');
        this.updateMessage(this.breakBox, session.breakpointHit, undefined);

        // active states
        const active = sim?.isRunning ? sim.activeLeafStates : [];
        this.activeList.replaceChildren(...(active.length > 0 ? active.map(name => h('span', { class: 'sim-chip' }, name))
            : [h('span', { class: 'hint' }, final ? '[*] (final)' : 'none')]));

        // pending events
        for (const [name, button] of this.eventButtons) {
            button.classList.toggle('pending', session.pending.includes(name));
            button.title = session.pending.includes(name) ? `${name} is pending until the next cycle` : `Raise ${name}`;
        }

        // variables
        const values = sim?.variables ?? {};
        const now = performance.now();
        for (const [name, cell] of this.variableCells) {
            const value = values[name];
            if (cell.editor) {
                if (!cell.editor.editing) {
                    cell.editor.set(value);
                }
            } else {
                cell.value.textContent = formatHostValue(cell.type, value);
            }
            const changed = session.changedVariables.get(name);
            if (changed !== undefined && now - changed < FLASH_MS && this.flashed.get(name) !== changed) {
                this.flashed.set(name, changed);
                cell.row.classList.remove('flash');
                void cell.row.offsetWidth;
                cell.row.classList.add('flash');
            }
        }

        for (const [operation, counter] of this.operationCounters) {
            counter.textContent = String(operation.calls);
        }

        this.updateList(this.outList, session.outEvents, 'out', r => h('li', {}, h('span', { class: 'sim-t' }, formatTime(r.time)), r.text), 'No out events yet');
        this.updateList(this.callList, session.calls, 'calls', r => h('li', {}, h('span', { class: 'sim-t' }, formatTime(r.time)), r.text), 'No calls yet');
        this.updateList(this.traceList, session.log.slice(-LOG_LINES), 'trace', entry => this.traceItem(entry), 'Empty');
    }

    private updateMessage(box: HTMLElement, message: { message: string, node?: AstNode } | undefined, title: string | undefined): void {
        if (this.shownMessages.get(box) === message) {
            return;
        }
        this.shownMessages.set(box, message);
        if (!message) {
            box.hidden = true;
            return;
        }
        box.hidden = false;
        const node = message.node;
        box.replaceChildren(
            h('strong', {}, `${title ?? 'Paused'}: `),
            h('span', {}, message.message),
            h('div', { class: 'sim-row' },
                node ? h('button', { onClick: () => this.host.reveal(node) }, 'Show in model') : undefined,
                title ? h('button', { onClick: () => this.session.restart() }, '↺ Restart') : undefined));
    }

    private updateList<T extends { id: number }>(list: HTMLElement, items: readonly T[], key: keyof SimulationPanel['lastIds'], render: (item: T) => HTMLElement, empty: string): void {
        const last = items.length > 0 ? items[items.length - 1].id : -1;
        if (last === this.lastIds[key] && list.childElementCount > 0) {
            return;
        }
        this.lastIds[key] = last;
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
        list.replaceChildren(...(items.length > 0 ? items.map(render) : [h('li', { class: 'hint' }, empty)]));
        if (atBottom) {
            list.scrollTop = list.scrollHeight;
        }
    }

    private traceItem(entry: LogEntry): HTMLElement {
        const node = entry.node;
        return h('li', {
            class: `sim-trace-${entry.kind}${node ? ' link' : ''}`,
            title: node ? 'Show in the text' : undefined,
            // mousedown: the list is re-rendered continuously in real-time mode
            onMouseDown: node ? (event: MouseEvent) => event.button === 0 && this.host.reveal(node) : undefined
        }, h('span', { class: 'sim-t' }, formatTime(entry.time)), entry.text);
    }
}

/** A collapsible section of the side panel (its state is kept by the key `sim.<title>`). */
function section(title: string, content: HTMLElement | HTMLElement[], hint?: string): HTMLElement {
    return panelSection(`sim.${title.toLowerCase().replace(/\s+/g, '-')}`, title, [content].flat(), { hint, class: 'sim-section' });
}

/** `850 ms`, `12.35 s`. */
export function formatTime(ms: number): string {
    if (ms < 1000) {
        return `${Math.round(ms * 100) / 100} ms`;
    }
    return `${(ms / 1000).toFixed(ms < 60000 ? 2 : 1)} s`;
}
