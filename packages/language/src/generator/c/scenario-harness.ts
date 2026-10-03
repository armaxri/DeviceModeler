import * as ast from '../../generated/ast.js';
import { returnTypeOf, typeOfEvent, typeOfParameter, type DevmType } from '../../typesystem.js';
import type { Scenario, ScenarioExpectation, ScenarioStep, ScenarioValue } from '../../simulation/scenario.js';
import { cInteger, cString, indent } from './c-code.js';
import type { CApi } from './c-generator.js';
import { cType } from './c-expressions.js';

/**
 * Generates a C program that runs a scenario of the conformance suite (test/scenarios/README.md)
 * against the generated code: operations return the scripted values and record their calls, a
 * virtual timer service implements `advance` / `runFor` like the interpreter, `expect` steps check
 * the observations. The program prints `PASS` or `FAIL ...` lines and exits with 0 / 1.
 */
export function generateScenarioHarness(api: CApi, scenario: Scenario): string {
    return new HarnessGenerator(api, scenario).generate();
}

const NS_PER_MS = 1e6;

class HarnessGenerator {

    private readonly f: CApi['functions'];
    private readonly handleType: string;

    constructor(private readonly api: CApi, private readonly scenario: Scenario) {
        this.f = api.functions;
        this.handleType = api.types.handle;
    }

    private get index() {
        return this.api.index;
    }

    private get eventDriven(): boolean {
        return this.api.executionMode === 'event';
    }

    generate(): string {
        const main: string[] = [];
        this.scenario.steps.forEach((step, i) => main.push(...this.step(step, i)));
        const body = [
            ...this.operations(),
            ...this.timerService(),
            ...this.observer(),
            ...this.driver(),
            ...this.stateTables(),
            'int main(void) {',
            ...indent([
                `${this.handleType} handle;`,
                `${this.f.init}(&handle);`,
                ...(this.index.events().some(e => this.index.eventDirection(e) === 'out') ? [`${this.api.prefix}_set_out_event_observer(&handle, on_out_event);`] : []),
                ...main
            ]),
            'done:',
            '    if (failures > 0) {',
            '        return 1;',
            '    }',
            '    printf("PASS\\n");',
            '    return 0;',
            '}'
        ];
        const prelude = RUNTIME.filter(fn => fn.always || body.some(line => line.includes(fn.name))).flatMap(fn => fn.lines);
        return [
            `/* Scenario harness for '${this.scenario.name ?? this.api.typeName}' (generated). */`,
            '#include <stdio.h>',
            '#include <stdlib.h>',
            '#include <string.h>',
            `#include "${this.api.header}"`,
            '',
            ...prelude,
            ...body,
            ''
        ].join('\n');
    }

    // ----- host side of the generated API

    private operations(): string[] {
        const lines: string[] = [];
        const operations = this.api.index.machine.scopes.flatMap(s => s.declarations).filter(ast.isOperationDeclaration);
        for (const operation of operations) {
            const name = this.index.declarationName(operation);
            const returnType = returnTypeOf(operation);
            const scripted = this.scenario.operations?.[name] ?? this.scenario.operations?.[operation.name] ?? [];
            const params = [`${this.handleType} *handle`];
            const format: string[] = [];
            operation.parameters.forEach((parameter, i) => {
                const type = typeOfParameter(parameter);
                const separator = i === 0 ? '' : 'append(text, sizeof text, ",");';
                if (parameter.varArgs) {
                    params.push(`sc_integer ${parameter.name}_count`, `const ${cType(type)} *${parameter.name}`);
                    format.push(
                        `for (i = 0; i < ${parameter.name}_count; i++) {`,
                        `    if (${i === 0 ? 'i > 0' : '1'}) {`,
                        '        append(text, sizeof text, ",");',
                        '    }',
                        `    append_value_${valueKind(type)}(text, sizeof text, ${parameter.name}[i]);`,
                        '}'
                    );
                } else {
                    params.push(`${cType(type)} ${parameter.name}`);
                    if (separator) {
                        format.push(separator);
                    }
                    format.push(`append_value_${valueKind(type)}(text, sizeof text, ${parameter.name});`);
                }
            });
            const hasVarArgs = operation.parameters.some(p => p.varArgs);
            lines.push(`${cType(returnType)} ${this.api.operation(operation)}(${params.join(', ')}) {`);
            const body: string[] = ['char text[LINE];'];
            if (hasVarArgs) {
                body.push('sc_integer i;');
            }
            if (returnType !== 'void' && scripted.length > 0) {
                body.push(`static const ${cType(returnType)} values[] = { ${scripted.map(v => this.literal(v, returnType)).join(', ')} };`, 'static int next = 0;');
            }
            body.push('(void)handle;', `text[0] = '\\0';`, `append(text, sizeof text, ${cString(`${name}(`)});`, ...format, 'append(text, sizeof text, ")");', 'record(calls, &call_count, text);');
            if (returnType !== 'void') {
                if (scripted.length > 0) {
                    body.push(`return values[next < ${scripted.length} ? next++ : ${scripted.length - 1}];`);
                } else {
                    body.push(`return ${defaultLiteral(returnType)};`);
                }
            }
            lines.push(...indent(body), '}', '');
        }
        lines.push(
            `void ${this.f.onError}(${this.handleType} *handle, ${this.api.types.error} error, const char *message) {`,
            '    (void)handle;',
            '    (void)error;',
            '    if (error_count++ == 0) {',
            '        snprintf(first_error, sizeof first_error, "%s", message);',
            '    }',
            '}',
            ''
        );
        return lines;
    }

    private timerService(): string[] {
        if (this.api.timerCount === 0) {
            return [];
        }
        const t = this.api.types.timer;
        return [
            `static Timer timers[${this.api.timerCount}];`,
            '',
            `void ${this.f.setTimer}(${this.handleType} *handle, ${t} timer, sc_integer duration_ns, sc_boolean periodic) {`,
            '    (void)handle;',
            '    timers[timer].active = 1;',
            '    timers[timer].due = now + duration_ns;',
            '    timers[timer].period = periodic ? duration_ns : 0;',
            '    timers[timer].sequence = timer_sequence++;',
            '}',
            '',
            `void ${this.f.unsetTimer}(${this.handleType} *handle, ${t} timer) {`,
            '    (void)handle;',
            '    timers[timer].active = 0;',
            '}',
            '',
            '/* The next active timer due at or before `until` (earliest first, then in start order), -1 if none. */',
            'int next_timer(sc_integer until) {',
            '    int i;',
            '    int best = -1;',
            `    for (i = 0; i < ${this.api.timerCount}; i++) {`,
            '        if (timers[i].active && timers[i].due <= until && (best < 0 || timers[i].due < timers[best].due',
            '                || (timers[i].due == timers[best].due && timers[i].sequence < timers[best].sequence))) {',
            '            best = i;',
            '        }',
            '    }',
            '    return best;',
            '}',
            '',
            '/* Removes a fired `after` timer, reschedules an `every` timer after the current time. */',
            'void expire(int i) {',
            '    if (timers[i].period == 0) {',
            '        timers[i].active = 0;',
            '    } else {',
            '        while (timers[i].due <= now) {',
            '            timers[i].due += timers[i].period;',
            '        }',
            '    }',
            '}',
            ''
        ];
    }

    /** `run_cycle`, `advance` and `run_for` of the virtual host (like the interpreter, docs/semantics.md §6). */
    private driver(): string[] {
        const h = this.handleType;
        const f = this.f;
        const timers = this.api.timerCount > 0;
        const raiseExpired = (until: string, setNow: boolean) => [
            'int i;',
            `while ((i = next_timer(${until})) >= 0) {`,
            ...(setNow ? ['    now = timers[i].due;'] : []),
            '    expire(i);',
            `    ${f.raiseTimeEvent}(handle, (${this.api.types.timer})i);`,
            '}'
        ];
        const lines: string[] = [`void run_cycle(${h} *handle) {`];
        if (timers && !this.eventDriven) {
            lines.push(`    if (${f.isActive}(handle) && !${f.isFinal}(handle)) {`, ...indent(raiseExpired('now', false), 2), '    }');
        }
        lines.push(`    ${f.runCycle}(handle);`, '}', '');
        lines.push(`void advance(${h} *handle, sc_integer duration) {`, '    sc_integer end = now + duration;');
        if (timers && this.eventDriven) {
            lines.push(`    if (${f.isActive}(handle)) {`, ...indent(raiseExpired('end', true), 2), '    }');
        } else {
            lines.push('    (void)handle;');
        }
        lines.push('    now = end;', '}', '');
        lines.push(`void run_for(${h} *handle, sc_integer duration) {`);
        if (this.eventDriven) {
            lines.push('    advance(handle, duration);');
        } else {
            const period = this.periodNs();
            lines.push(
                '    sc_integer end = now + duration;',
                `    if (!${f.isActive}(handle)) {`,
                '        advance(handle, duration);',
                '        return;',
                '    }',
                '    if (next_cycle < now) {',
                `        next_cycle = enter_time + (now - enter_time + ${period} - 1) / ${period} * ${period};`,
                '    }',
                '    while (next_cycle <= end) {',
                '        now = next_cycle;',
                `        next_cycle += ${period};`,
                '        run_cycle(handle);',
                '    }',
                '    now = end;'
            );
        }
        lines.push('}', '');
        return lines;
    }

    private observer(): string[] {
        const outEvents = this.index.events().filter(e => this.index.eventDirection(e) === 'out');
        if (outEvents.length === 0) {
            return [];
        }
        const lines = [`void on_out_event(${this.handleType} *handle, ${this.api.types.event} event) {`, '    char text[LINE];', '    (void)handle;', `    text[0] = '\\0';`, '    switch (event) {'];
        for (const event of outEvents) {
            const name = this.index.declarationName(event);
            const type = typeOfEvent(event);
            lines.push(`    case ${this.api.event(event)}:`);
            if (type === 'void' || type === 'error') {
                lines.push(`        append(text, sizeof text, ${cString(name)});`);
            } else {
                lines.push(
                    `        append(text, sizeof text, ${cString(`${name}(`)});`,
                    `        append_value_${valueKind(type)}(text, sizeof text, ${this.api.eventValue(event)}(handle));`,
                    '        append(text, sizeof text, ")");'
                );
            }
            lines.push('        break;');
        }
        lines.push('    default:', '        break;', '    }', '    record(out_events, &out_event_count, text);', '}', '');
        return lines;
    }

    /** Tables of all states: names and whether a state is an active leaf. */
    private stateTables(): string[] {
        const states = this.index.states;
        const active = (state: ast.State) => `${this.f.isStateActive}(handle, ${this.api.state(state)})`;
        const lines = [`#define STATE_COUNT ${states.length}`, ''];
        lines.push('static const char *const state_names[] = {', ...states.map((s, i) => `    ${cString(this.index.stateName(s))}${i < states.length - 1 ? ',' : ''}`), '};', '');
        lines.push(`int state_active(const ${this.handleType} *handle, int i) {`, '    switch (i) {');
        states.forEach((state, i) => lines.push(`    case ${i}:`, `        return ${active(state)};`));
        lines.push('    default:', '        return 0;', '    }', '}', '');
        lines.push(`int leaf_active(const ${this.handleType} *handle, int i) {`, '    switch (i) {');
        states.forEach((state, i) => {
            const children = this.index.regionsOf(state).flatMap(r => r.vertices.filter(ast.isState));
            lines.push(`    case ${i}:`, `        return ${[active(state), ...children.map(c => `!${active(c)}`)].join(' && ')};`);
        });
        lines.push('    default:', '        return 0;', '    }', '}', '');
        lines.push(
            `void describe_states(const ${this.handleType} *handle, int leaves, char *text, size_t size) {`,
            '    int i;',
            '    int first = 1;',
            `    text[0] = '\\0';`,
            '    append(text, size, "[");',
            '    for (i = 0; i < STATE_COUNT; i++) {',
            '        if (leaves ? leaf_active(handle, i) : state_active(handle, i)) {',
            '            if (!first) {',
            '                append(text, size, ", ");',
            '            }',
            '            append(text, size, state_names[i]);',
            '            first = 0;',
            '        }',
            '    }',
            '    append(text, size, "]");',
            '}',
            ''
        );
        return lines;
    }

    // ----- steps

    private step(step: ScenarioStep, index: number): string[] {
        const lines = [`/* step ${index}: ${commentOf(step)} */`];
        if (step.expect) {
            lines.push(...this.expect(step.expect, index));
            return lines;
        }
        const action = this.action(step);
        if (action === undefined) {
            // an error detected when generating the harness (e.g. an unknown event: a compile time error in C)
            if (step.expectError === undefined) {
                throw new Error(`step ${index}: cannot be translated to C`);
            }
            lines.push('/* rejected when generating the harness (compile time error in C) */');
            return lines;
        }
        lines.push('error_count = 0;', ...action);
        if (step.expectError !== undefined) {
            lines.push(
                `if (error_count == 0 || strstr(first_error, ${cString(step.expectError)}) == NULL) {`,
                `    fail(${index}, "expected an error containing '%s' but got: %s", ${cString(step.expectError)}, error_count == 0 ? "no error" : first_error);`,
                '}'
            );
        } else {
            lines.push('if (error_count > 0) {', `    fail(${index}, "%s", first_error);`, '    goto done;', '}');
        }
        return lines;
    }

    /** The C statements of an action; `undefined` if the action is rejected at generation time. */
    private action(step: ScenarioStep): string[] | undefined {
        const f = this.f;
        if (step.enter) {
            return [`${f.enter}(&handle);`, 'enter_time = now;', `next_cycle = now + ${this.periodNs()};`];
        }
        if (step.exit) {
            return [`${f.exit}(&handle);`];
        }
        if (step.raise !== undefined) {
            const event = this.index.findEvent(step.raise);
            if (!event || this.index.eventDirection(event) !== 'in') {
                return undefined;
            }
            const type = typeOfEvent(event);
            const hasValue = type !== 'void' && type !== 'error';
            if (hasValue) {
                const value = step.value === undefined ? defaultLiteral(type) : this.literal(step.value, type);
                return [`${this.api.raise(event)}(&handle, ${value});`];
            }
            return [`${this.api.raise(event)}(&handle);`];
        }
        if (step.runCycle !== undefined) {
            const count = step.runCycle === true ? 1 : step.runCycle;
            return count === 1 ? ['run_cycle(&handle);'] : [`for (n = 0; n < ${count}; n++) {`, '    run_cycle(&handle);', '}'];
        }
        if (step.advance !== undefined) {
            return [`advance(&handle, ${cInteger(BigInt(Math.round(step.advance * NS_PER_MS)))});`];
        }
        if (step.runFor !== undefined) {
            return [`run_for(&handle, ${cInteger(BigInt(Math.round(step.runFor * NS_PER_MS)))});`];
        }
        if (step.set) {
            const lines: string[] = [];
            for (const [name, value] of Object.entries(step.set)) {
                const variable = this.index.findVariable(name);
                const setter = variable ? this.api.setter(variable) : undefined;
                if (!variable || !setter) {
                    return undefined;
                }
                lines.push(`${setter}(&handle, ${this.literal(value, this.api.variableType(variable))});`);
            }
            return lines;
        }
        return [];
    }

    private periodNs(): string {
        return cInteger(BigInt(Math.round(this.api.cyclePeriod * NS_PER_MS)));
    }

    private expect(expect: ScenarioExpectation, index: number): string[] {
        const lines: string[] = [];
        const fail = (format: string, ...args: string[]) => `fail(${[String(index), cString(format), ...args].join(', ')});`;
        for (const name of expect.active ?? []) {
            const state = this.stateOf(name);
            lines.push(
                `if (!${this.f.isStateActive}(&handle, ${this.api.state(state)})) {`,
                '    describe_states(&handle, 0, text, sizeof text);',
                `    ${fail(`expected '${name}' to be active; active: %s`, 'text')}`,
                '}'
            );
        }
        for (const name of expect.inactive ?? []) {
            const state = this.stateOf(name);
            lines.push(
                `if (${this.f.isStateActive}(&handle, ${this.api.state(state)})) {`,
                '    describe_states(&handle, 0, text, sizeof text);',
                `    ${fail(`expected '${name}' to be inactive; active: %s`, 'text')}`,
                '}'
            );
        }
        if (expect.configuration) {
            const expected = new Set(expect.configuration.map(name => this.stateOf(name)));
            const conditions = this.index.states.map((state, i) => expected.has(state) ? `!leaf_active(&handle, ${i})` : `leaf_active(&handle, ${i})`);
            const names = [...expected].map(s => this.index.stateName(s)).sort().join(', ');
            lines.push(
                `if (${conditions.join('\n        || ')}) {`,
                '    describe_states(&handle, 1, text, sizeof text);',
                `    ${fail(`expected configuration [${names}] but was %s`, 'text')}`,
                '}'
            );
        }
        if (expect.final !== undefined) {
            lines.push(
                `if (${expect.final ? '!' : ''}${this.f.isFinal}(&handle)) {`,
                `    ${fail(`expected the state machine ${expect.final ? '' : 'not '}to be final`)}`,
                '}'
            );
        }
        for (const [name, value] of Object.entries(expect.variables ?? {})) {
            const variable = this.index.findVariable(name);
            if (!variable) {
                lines.push(fail(`unknown variable '${name}'`));
                continue;
            }
            const getter = `${this.api.getter(variable)}(&handle)`;
            const type = this.api.variableType(variable);
            const message = `expected variable '${name}' = ${JSON.stringify(value)} but was %s`;
            let check: string;
            switch (type) {
                case 'real':
                    check = typeof value === 'number' ? `!same_real(${getter}, ${realLiteral(value)})` : '1';
                    break;
                case 'boolean':
                    check = typeof value === 'boolean' ? `${getter} != ${value}` : '1';
                    break;
                case 'string':
                    check = typeof value === 'string' ? `strcmp(${getter}, ${cString(value)}) != 0` : '1';
                    break;
                default:
                    check = typeof value === 'number' && Number.isInteger(value) ? `${getter} != ${cInteger(BigInt(value))}` : '1';
            }
            lines.push(
                `if (${check}) {`,
                `    text[0] = '\\0';`,
                `    append_value_${valueKind(type)}(text, sizeof text, ${getter});`,
                `    ${fail(message, 'text')}`,
                '}'
            );
        }
        if (expect.outEvents) {
            lines.push(...this.compareList('out events', expect.outEvents, 'out_events', 'out_event_count', index));
        }
        if (expect.calls) {
            lines.push(...this.compareList('calls', expect.calls, 'calls', 'call_count', index));
        }
        lines.push('out_event_count = 0;', 'call_count = 0;');
        return lines;
    }

    private compareList(what: string, expected: string[], array: string, count: string, index: number): string[] {
        const normalized = expected.map(normalize);
        const name = `expected_${array}_${index}`;
        return [
            '{',
            ...indent([
                normalized.length > 0
                    ? `static const char *const ${name}[] = { ${normalized.map(cString).join(', ')} };`
                    : `static const char *const *const ${name} = NULL;`,
                `if (!same_list(${name}, ${normalized.length}, ${array}, ${count})) {`,
                `    describe_list(${array}, ${count}, text, sizeof text);`,
                `    fail(${index}, "expected ${what} %s but got %s", ${cString(`[${expected.join('; ')}]`)}, text);`,
                '}'
            ]),
            '}'
        ];
    }

    private stateOf(name: string): ast.State {
        const state = this.index.findState(name);
        if (!state) {
            throw new Error(`Unknown or ambiguous state '${name}'`);
        }
        return state;
    }

    private literal(value: ScenarioValue, type: DevmType): string {
        switch (type) {
            case 'real':
                if (typeof value !== 'number') {
                    throw new Error(`${JSON.stringify(value)} is not a real`);
                }
                return realLiteral(value);
            case 'boolean':
                if (typeof value !== 'boolean') {
                    throw new Error(`${JSON.stringify(value)} is not a boolean`);
                }
                return String(value);
            case 'string':
                if (typeof value !== 'string') {
                    throw new Error(`${JSON.stringify(value)} is not a string`);
                }
                return cString(value);
            default:
                if (typeof value !== 'number' || !Number.isInteger(value)) {
                    throw new Error(`${JSON.stringify(value)} is not an integer`);
                }
                return cInteger(BigInt(value));
        }
    }
}

function valueKind(type: DevmType): string {
    switch (type) {
        case 'real': return 'real';
        case 'boolean': return 'boolean';
        case 'string': return 'string';
        default: return 'integer';
    }
}

function defaultLiteral(type: DevmType): string {
    switch (type) {
        case 'real': return '0.0';
        case 'boolean': return 'false';
        case 'string': return '""';
        default: return '0';
    }
}

function realLiteral(value: number): string {
    const text = String(value);
    return /^-?\d+$/.test(text) ? `${text}.0` : text.replace('Infinity', '(1.0 / 0.0)');
}

/** Removes white space outside of string literals (like the scenario runner). */
function normalize(text: string): string {
    return text.replace(/("(?:\\.|[^"\\])*")|\s+/g, (_match, literal: string | undefined) => literal ?? '');
}

function commentOf(step: ScenarioStep): string {
    const { comment: _comment, ...rest } = step;
    return JSON.stringify(rest).replace(/\*\//g, '* /');
}

interface RuntimeFunction {
    name: string;
    always?: boolean;
    lines: string[];
}

/** Runtime of the harness; functions are only emitted if they are used (no unused static functions). */
const RUNTIME: RuntimeFunction[] = [
    {
        name: 'LINE', always: true, lines: [
            '#define LINE 512',
            '#define LOG_SIZE 256',
            '',
            'char calls[LOG_SIZE][LINE];',
            'int call_count = 0;',
            'char out_events[LOG_SIZE][LINE];',
            'int out_event_count = 0;',
            'int error_count = 0;',
            'char first_error[LINE];',
            'int failures = 0;',
            'char text[4 * LINE];',
            'int n = 0;',
            '/* virtual clock (ns) */',
            'sc_integer now = 0;',
            'sc_integer enter_time = 0;',
            'sc_integer next_cycle = 0;',
            '',
            'typedef struct {',
            '    int active;',
            '    sc_integer due;',
            '    sc_integer period;',
            '    sc_integer sequence;',
            '} Timer;',
            'sc_integer timer_sequence = 0;',
            '',
            '#include <stdarg.h>',
            'static void fail(int step, const char *format, ...) {',
            '    va_list args;',
            '    va_start(args, format);',
            '    printf("FAIL step %d: ", step);',
            '    vprintf(format, args);',
            '    printf("\\n");',
            '    va_end(args);',
            '    failures++;',
            '}',
            '',
            'static void append(char *target, size_t size, const char *text) {',
            '    size_t length = strlen(target);',
            '    while (*text != \'\\0\' && length + 1 < size) {',
            '        target[length++] = *text++;',
            '    }',
            '    target[length] = \'\\0\';',
            '}',
            ''
        ]
    },
    {
        name: 'record(', lines: [
            'static void record(char log[][LINE], int *count, const char *text) {',
            '    if (*count < LOG_SIZE) {',
            '        snprintf(log[*count], LINE, "%s", text);',
            '        (*count)++;',
            '    }',
            '}',
            ''
        ]
    },
    {
        name: 'same_list(', lines: [
            'static int same_list(const char *const *expected, int expected_count, char log[][LINE], int count) {',
            '    int i;',
            '    if (expected_count != count) {',
            '        return 0;',
            '    }',
            '    for (i = 0; i < count; i++) {',
            '        if (strcmp(expected[i], log[i]) != 0) {',
            '            return 0;',
            '        }',
            '    }',
            '    return 1;',
            '}',
            '',
            'static void describe_list(char log[][LINE], int count, char *target, size_t size) {',
            '    int i;',
            '    target[0] = \'\\0\';',
            '    append(target, size, "[");',
            '    for (i = 0; i < count; i++) {',
            '        append(target, size, i > 0 ? "; " : "");',
            '        append(target, size, log[i]);',
            '    }',
            '    append(target, size, "]");',
            '}',
            ''
        ]
    },
    {
        name: 'same_real(', lines: [
            'static int same_real(sc_real actual, sc_real expected) {',
            '    sc_real difference = actual - expected;',
            '    sc_real magnitude = expected < 0 ? -expected : expected;',
            '    if (difference < 0) {',
            '        difference = -difference;',
            '    }',
            '    return actual == expected || difference <= 1e-9 * (magnitude > 1 ? magnitude : 1);',
            '}',
            ''
        ]
    },
    {
        name: 'append_value_integer(', lines: [
            'static void append_value_integer(char *target, size_t size, sc_integer value) {',
            '    char buffer[32];',
            '    snprintf(buffer, sizeof buffer, "%lld", (long long)value);',
            '    append(target, size, buffer);',
            '}',
            ''
        ]
    },
    {
        name: 'append_value_boolean(', lines: [
            'static void append_value_boolean(char *target, size_t size, sc_boolean value) {',
            '    append(target, size, value ? "true" : "false");',
            '}',
            ''
        ]
    },
    {
        name: 'append_value_string(', lines: [
            '/* A JSON string literal, like JSON.stringify. */',
            'static void append_value_string(char *target, size_t size, sc_string value) {',
            '    char buffer[8];',
            '    const unsigned char *p = (const unsigned char *)value;',
            '    append(target, size, "\\"");',
            '    for (; *p != \'\\0\'; p++) {',
            '        switch (*p) {',
            '        case \'"\': append(target, size, "\\\\\\""); break;',
            '        case \'\\\\\': append(target, size, "\\\\\\\\"); break;',
            '        case \'\\n\': append(target, size, "\\\\n"); break;',
            '        case \'\\r\': append(target, size, "\\\\r"); break;',
            '        case \'\\t\': append(target, size, "\\\\t"); break;',
            '        case \'\\b\': append(target, size, "\\\\b"); break;',
            '        case \'\\f\': append(target, size, "\\\\f"); break;',
            '        default:',
            '            if (*p < 0x20) {',
            '                snprintf(buffer, sizeof buffer, "\\\\u%04x", *p);',
            '            } else {',
            '                buffer[0] = (char)*p;',
            '                buffer[1] = \'\\0\';',
            '            }',
            '            append(target, size, buffer);',
            '        }',
            '    }',
            '    append(target, size, "\\"");',
            '}',
            ''
        ]
    },
    {
        name: 'append_value_real(', lines: [
            '/* A real like the interpreter formats it (JavaScript number to string, integral values with ".0"). */',
            'static void append_value_real(char *target, size_t size, sc_real value) {',
            '    char buffer[64];',
            '    char digits[32];',
            '    char result[64];',
            '    int precision;',
            '    int k = 0;',
            '    int exponent;',
            '    int point;',
            '    int i;',
            '    const char *p;',
            '    if (value != value) {',
            '        append(target, size, "NaN");',
            '        return;',
            '    }',
            '    if (value == 0) {',
            '        append(target, size, "0.0");',
            '        return;',
            '    }',
            '    if (value < 0) {',
            '        append(target, size, "-");',
            '        value = -value;',
            '    }',
            '    if (value > 1.7976931348623157e308) {',
            '        append(target, size, "Infinity");',
            '        return;',
            '    }',
            '    for (precision = 1; precision <= 17; precision++) {',
            '        snprintf(buffer, sizeof buffer, "%.*e", precision - 1, value);',
            '        if (strtod(buffer, NULL) == value) {',
            '            break;',
            '        }',
            '    }',
            '    for (p = buffer; *p != \'e\'; p++) {',
            '        if (*p >= \'0\' && *p <= \'9\') {',
            '            digits[k++] = *p;',
            '        }',
            '    }',
            '    while (k > 1 && digits[k - 1] == \'0\') {',
            '        k--;',
            '    }',
            '    digits[k] = \'\\0\';',
            '    exponent = atoi(p + 1);',
            '    point = exponent + 1;',
            '    result[0] = \'\\0\';',
            '    if (k <= point && point <= 21) {',
            '        append(result, sizeof result, digits);',
            '        for (i = k; i < point; i++) {',
            '            append(result, sizeof result, "0");',
            '        }',
            '        append(result, sizeof result, ".0");',
            '    } else if (0 < point && point <= 21) {',
            '        for (i = 0; i < point; i++) {',
            '            result[i] = digits[i];',
            '        }',
            '        result[point] = \'\\0\';',
            '        append(result, sizeof result, ".");',
            '        append(result, sizeof result, digits + point);',
            '    } else if (-6 < point && point <= 0) {',
            '        append(result, sizeof result, "0.");',
            '        for (i = point; i < 0; i++) {',
            '            append(result, sizeof result, "0");',
            '        }',
            '        append(result, sizeof result, digits);',
            '    } else {',
            '        char e[16];',
            '        result[0] = digits[0];',
            '        result[1] = \'\\0\';',
            '        if (k > 1) {',
            '            append(result, sizeof result, ".");',
            '            append(result, sizeof result, digits + 1);',
            '        }',
            '        snprintf(e, sizeof e, "e%c%d", point - 1 >= 0 ? \'+\' : \'-\', point - 1 >= 0 ? point - 1 : 1 - point);',
            '        append(result, sizeof result, e);',
            '    }',
            '    append(target, size, result);',
            '}',
            ''
        ]
    }
];
