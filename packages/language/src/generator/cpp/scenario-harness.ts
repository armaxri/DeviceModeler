import * as ast from '../../generated/ast.js';
import { returnTypeOf, typeOfEvent, type HsmType } from '../../hsm-typesystem.js';
import type { Scenario, ScenarioExpectation, ScenarioStep, ScenarioValue } from '../../simulation/scenario.js';
import { cInteger, cString, indent } from '../common/code.js';
import { cppType } from './cpp-code.js';
import type { CppApi } from './cpp-generator.js';

export interface CppHarnessOptions {
    /** Namespace of the harness code, which defines `int run()` there (default `hsm_scenario_harness`). */
    namespace?: string;
    /** Whether to define `int main()` calling `run()` (default true). */
    main?: boolean;
}

/**
 * Generates a C++ program that runs a scenario of the conformance suite (test/scenarios/README.md)
 * against the generated class: mocked operation callbacks return the scripted values and record
 * their calls, a virtual timer service implements `advance` / `runFor` like the interpreter, out
 * events are recorded by observers, `expect` steps check the observations and `expectError` steps
 * check the message of the `sc::StatemachineError`. `run()` prints `PASS` or `FAIL ...` lines and
 * returns 0 / 1. Several harnesses (with different namespaces) can be compiled in one translation unit.
 */
export function generateCppScenarioHarness(api: CppApi, scenario: Scenario, options: CppHarnessOptions = {}): string {
    return new CppHarnessGenerator(api, scenario, options).generate();
}

const NS_PER_MS = 1e6;

class CppHarnessGenerator {

    private readonly namespace: string;
    private readonly usesInternals: boolean;

    constructor(private readonly api: CppApi, private readonly scenario: Scenario, private readonly options: CppHarnessOptions) {
        this.namespace = options.namespace ?? 'hsm_scenario_harness';
        this.usesInternals = scenario.steps.some(step =>
            Object.keys(step.set ?? {}).concat(Object.keys(step.expect?.variables ?? {})).some(name => {
                const variable = this.index.findVariable(name);
                return variable !== undefined && api.isInternal(variable);
            }));
    }

    private get index() {
        return this.api.index;
    }

    private get eventDriven(): boolean {
        return this.api.executionMode === 'event';
    }

    private get outEvents(): ast.EventDeclaration[] {
        return this.index.events().filter(e => this.index.eventDirection(e) === 'out');
    }

    generate(): string {
        const main: string[] = [];
        this.scenario.steps.forEach((step, i) => main.push(...this.step(step, i)));
        const lines = [
            `// Scenario harness for '${this.scenario.name ?? this.api.className}' (generated).`,
            `#include "${this.api.header}"`,
            '',
            ...RUNTIME,
            ...this.internals(),
            `namespace ${this.namespace} {`,
            '',
            `using Machine = ${this.api.qualifiedClassName};`,
            'using namespace hsm_scenario;',
            '',
            'std::vector<std::string> calls;',
            'std::vector<std::string> out_events;',
            'int failures = 0;',
            '// virtual clock (ns)',
            'sc::integer now = 0;',
            'sc::integer enter_time = 0;',
            'sc::integer next_cycle = 0;',
            '',
            'void fail(int step, const std::string& message) {',
            '    std::printf("FAIL step %d: %s\\n", step, message.c_str());',
            '    failures++;',
            '}',
            '',
            ...this.callbacks(),
            ...this.observers(),
            ...this.timerService(),
            ...this.driver(),
            ...this.stateTables(),
            'int run() {',
            ...indent([
                'Machine machine;',
                ...this.setup(),
                'std::string error;',
                ...main,
                'if (failures > 0) {',
                '    return 1;',
                '}',
                'std::printf("PASS\\n");',
                'return 0;'
            ]),
            '}',
            '',
            `} // namespace ${this.namespace}`,
            ''
        ];
        if (this.options.main ?? true) {
            lines.push('int main() {', `    return ${this.namespace}::run();`, '}', '');
        }
        return lines.join('\n');
    }

    // ----- host side of the generated API

    private internals(): string[] {
        if (!this.usesInternals) {
            return [];
        }
        const lines: string[] = [];
        const open = this.api.namespace ? [`namespace ${this.api.namespace} {`, ''] : [];
        lines.push(...open, '// Access to the internal scope (friend of the state machine class).', `struct ${this.api.internalsStruct} {`);
        for (const variable of this.index.variables().filter(v => this.api.isInternal(v))) {
            const type = cppType(this.api.variableType(variable));
            const member = this.api.internalMember(variable);
            lines.push(
                `    static ${type} get_${variable.name}(const ${this.api.className}& machine) {`,
                `        return machine.${member};`,
                '    }',
                `    static void set_${variable.name}(${this.api.className}& machine, ${type} value) {`,
                `        machine.${member} = value;`,
                '    }'
            );
        }
        lines.push('};', '');
        if (this.api.namespace) {
            lines.push(`} // namespace ${this.api.namespace}`, '');
        }
        return lines;
    }

    private callbacks(): string[] {
        const lines: string[] = [];
        this.api.operationScopes.forEach((scope, i) => {
            lines.push(`class Callbacks${i} : public Machine::${scope.callbackClass} {`, 'public:');
            const counters: string[] = [];
            scope.operations.forEach((operation, j) => {
                const name = this.index.declarationName(operation);
                const returnType = returnTypeOf(operation);
                const scripted = this.scenario.operations?.[name] ?? this.scenario.operations?.[operation.name] ?? [];
                const body: string[] = [`std::string hsm_text = ${cString(`${name}(`)};`];
                const parameterNames = this.api.operationParameterNames(operation);
                let first = true;
                operation.parameters.forEach((parameter, k) => {
                    const parameterName = parameterNames[k];
                    const format = `hsm_scenario::format(${parameter.varArgs ? 'hsm_value' : parameterName})`;
                    if (parameter.varArgs) {
                        body.push(`for (const auto& hsm_value : ${parameterName}) {`, `    hsm_text += hsm_text.back() == '(' ? "" : ",";`, `    hsm_text += ${format};`, '}');
                    } else {
                        body.push(...(first ? [] : ['hsm_text += ",";']), `hsm_text += ${format};`);
                    }
                    first = false;
                });
                body.push('hsm_text += ")";', 'calls.push_back(hsm_text);');
                if (returnType !== 'void') {
                    if (scripted.length > 0) {
                        const counter = `hsm_next${j}`;
                        counters.push(`std::size_t ${counter} = 0;`);
                        body.push(
                            `static const ${cppType(returnType)} hsm_values[] = {${scripted.map(v => this.literal(v, returnType)).join(', ')}};`,
                            `return hsm_values[${counter} < ${scripted.length} ? ${counter}++ : ${scripted.length - 1}];`
                        );
                    } else {
                        body.push(`return ${defaultLiteral(returnType)};`);
                    }
                }
                lines.push(`    ${cppType(returnType)} ${operation.name}(${this.api.operationParameters(operation)}) override {`, ...indent(body, 2), '    }');
            });
            if (counters.length > 0) {
                lines.push('', 'private:', ...indent(counters));
            }
            lines.push('};', '');
        });
        return lines;
    }

    private setup(): string[] {
        const lines: string[] = [];
        this.api.operationScopes.forEach((scope, i) => {
            lines.push(`Callbacks${i} callbacks${i};`, `${scope.setCallback('machine', `&callbacks${i}`)};`);
        });
        if (this.api.timerCount > 0) {
            lines.push('VirtualTimers timers;', 'machine.setTimerService(&timers);');
        }
        this.outEvents.forEach((event, i) => {
            lines.push(`Observer${i} observer${i};`, `machine.${this.api.interfaceAccess(event)}${this.api.observable(event)}().subscribe(observer${i});`);
        });
        return lines;
    }

    private observers(): string[] {
        const lines: string[] = [];
        this.outEvents.forEach((event, i) => {
            const name = this.index.declarationName(event);
            const type = typeOfEvent(event);
            const hasValue = type !== 'void' && type !== 'error';
            lines.push(`class Observer${i} : public sc::rx::Observer<${hasValue ? cppType(type) : 'void'}> {`, 'public:');
            if (hasValue) {
                lines.push(`    void next(const ${cppType(type)}& value) override {`, `        out_events.push_back(${cString(`${name}(`)} + format(value) + ")");`, '    }');
            } else {
                lines.push('    void next() override {', `        out_events.push_back(${cString(name)});`, '    }');
            }
            lines.push('};', '');
        });
        return lines;
    }

    private timerService(): string[] {
        if (this.api.timerCount === 0) {
            return [];
        }
        return [
            'class VirtualTimers : public sc::TimerServiceInterface {',
            'public:',
            '    struct Timer {',
            '        bool active = false;',
            '        sc::integer due = 0;',
            '        sc::integer period = 0;',
            '        sc::integer sequence = 0;',
            '    };',
            '',
            `    Timer timers[${this.api.timerCount}];`,
            '    sc::integer sequence = 0;',
            '',
            '    void setTimer(sc::TimedInterface*, sc::eventid event, sc::integer durationNs, bool periodic) override {',
            '        Timer& timer = timers[event];',
            '        timer.active = true;',
            '        timer.due = now + durationNs;',
            '        timer.period = periodic ? durationNs : 0;',
            '        timer.sequence = sequence++;',
            '    }',
            '',
            '    void unsetTimer(sc::TimedInterface*, sc::eventid event) override {',
            '        timers[event].active = false;',
            '    }',
            '',
            '    // The next active timer due at or before `until` (earliest first, then in start order), -1 if none.',
            '    int next(sc::integer until) const {',
            '        int best = -1;',
            `        for (int i = 0; i < ${this.api.timerCount}; i++) {`,
            '            const Timer& timer = timers[i];',
            '            if (timer.active && timer.due <= until && (best < 0 || timer.due < timers[best].due',
            '                    || (timer.due == timers[best].due && timer.sequence < timers[best].sequence))) {',
            '                best = i;',
            '            }',
            '        }',
            '        return best;',
            '    }',
            '',
            '    // Removes a fired `after` timer, reschedules an `every` timer after the current time.',
            '    void expire(int i) {',
            '        Timer& timer = timers[i];',
            '        if (timer.period == 0) {',
            '            timer.active = false;',
            '        } else {',
            '            while (timer.due <= now) {',
            '                timer.due += timer.period;',
            '            }',
            '        }',
            '    }',
            '};',
            ''
        ];
    }

    /** `run_cycle`, `advance` and `run_for` of the virtual host (like the interpreter, docs/semantics.md §6). */
    private driver(): string[] {
        const timers = this.api.timerCount > 0;
        const timerService = 'VirtualTimers& timers = *static_cast<VirtualTimers*>(machine.getTimerService());';
        const raiseExpired = (until: string, setNow: boolean) => [
            timerService,
            'int i;',
            `while ((i = timers.next(${until})) >= 0) {`,
            ...(setNow ? ['    now = timers.timers[i].due;'] : []),
            '    timers.expire(i);',
            '    machine.raiseTimeEvent(i);',
            '}'
        ];
        const lines: string[] = ['void run_cycle(Machine& machine) {'];
        if (timers && !this.eventDriven) {
            lines.push('    if (machine.isActive() && !machine.isFinal()) {', ...indent(raiseExpired('now', false), 2), '    }');
        }
        lines.push('    machine.runCycle();', '}', '');
        lines.push('void advance(Machine& machine, sc::integer duration) {', '    const sc::integer end = now + duration;');
        if (timers && this.eventDriven) {
            lines.push('    if (machine.isActive()) {', ...indent(raiseExpired('end', true), 2), '    }');
        } else {
            lines.push('    (void)machine;');
        }
        lines.push('    now = end;', '}', '');
        lines.push('void run_for(Machine& machine, sc::integer duration) {');
        if (this.eventDriven) {
            lines.push('    advance(machine, duration);');
        } else {
            const period = this.periodNs();
            lines.push(
                '    const sc::integer end = now + duration;',
                '    if (!machine.isActive()) {',
                '        advance(machine, duration);',
                '        return;',
                '    }',
                '    if (next_cycle < now) {',
                `        next_cycle = enter_time + (now - enter_time + ${period} - 1) / ${period} * ${period};`,
                '    }',
                '    while (next_cycle <= end) {',
                '        now = next_cycle;',
                `        next_cycle += ${period};`,
                '        run_cycle(machine);',
                '    }',
                '    now = end;'
            );
        }
        lines.push('}', '');
        return lines;
    }

    /** Names of all states and whether a state is an active leaf. */
    private stateTables(): string[] {
        const states = this.index.states;
        const active = (state: ast.State) => `machine.isStateActive(Machine::${this.api.state(state)})`;
        const lines = [`const int STATE_COUNT = ${states.length};`, ''];
        const names = states.length > 0 ? states.map(s => cString(this.index.stateName(s))) : ['""'];
        lines.push('const char* const state_names[] = {', ...names.map((name, i) => `    ${name}${i < names.length - 1 ? ',' : ''}`), '};', '');
        lines.push('bool state_active(const Machine& machine, int i) {', '    switch (i) {');
        states.forEach((state, i) => lines.push(`    case ${i}:`, `        return ${active(state)};`));
        lines.push('    default:', '        return false;', '    }', '}', '');
        lines.push('bool leaf_active(const Machine& machine, int i) {', '    switch (i) {');
        states.forEach((state, i) => {
            const children = this.index.regionsOf(state).flatMap(r => r.vertices.filter(ast.isState));
            lines.push(`    case ${i}:`, `        return ${[active(state), ...children.map(c => `!${active(c)}`)].join(' && ')};`);
        });
        lines.push('    default:', '        return false;', '    }', '}', '');
        lines.push(
            'std::string describe_states(const Machine& machine, bool leaves) {',
            '    std::vector<std::string> names;',
            '    for (int i = 0; i < STATE_COUNT; i++) {',
            '        if (leaves ? leaf_active(machine, i) : state_active(machine, i)) {',
            '            names.push_back(state_names[i]);',
            '        }',
            '    }',
            '    return describe(names, ", ");',
            '}',
            ''
        );
        return lines;
    }

    // ----- steps

    private step(step: ScenarioStep, index: number): string[] {
        const lines = [`// step ${index}: ${commentOf(step)}`];
        if (step.expect) {
            lines.push(...this.expect(step.expect, index));
            return lines;
        }
        const action = this.action(step);
        if (action === undefined) {
            // an error detected when generating the harness (e.g. an unknown event: a compile time error in C++)
            if (step.expectError === undefined) {
                throw new Error(`step ${index}: cannot be translated to C++`);
            }
            lines.push('// rejected when generating the harness (compile time error in C++)');
            return lines;
        }
        lines.push(
            'error.clear();',
            'try {',
            ...indent(action),
            '} catch (const sc::StatemachineError& e) {',
            '    error = e.what();',
            '}'
        );
        if (step.expectError !== undefined) {
            lines.push(
                `if (error.empty() || error.find(${cString(step.expectError)}) == std::string::npos) {`,
                `    fail(${index}, std::string("expected an error containing '") + ${cString(step.expectError)} + "' but got: " + (error.empty() ? "no error" : error));`,
                '}'
            );
        } else {
            lines.push('if (!error.empty()) {', `    fail(${index}, error);`, '    return 1;', '}');
        }
        return lines;
    }

    /** The statements of an action; `undefined` if the action is rejected at generation time. */
    private action(step: ScenarioStep): string[] | undefined {
        if (step.enter) {
            return ['enter_time = now;', `next_cycle = now + ${this.periodNs()};`, 'machine.enter();'];
        }
        if (step.exit) {
            return ['machine.exit();'];
        }
        if (step.raise !== undefined) {
            const event = this.index.findEvent(step.raise);
            if (!event || this.index.eventDirection(event) !== 'in') {
                return undefined;
            }
            const type = typeOfEvent(event);
            const hasValue = type !== 'void' && type !== 'error';
            const value = !hasValue ? '' : step.value === undefined ? defaultLiteral(type) : this.literal(step.value, type);
            return [`machine.${this.api.interfaceAccess(event)}${this.api.raise(event)}(${value});`];
        }
        if (step.runCycle !== undefined) {
            const count = step.runCycle === true ? 1 : step.runCycle;
            return count === 1 ? ['run_cycle(machine);'] : [`for (int n = 0; n < ${count}; n++) {`, '    run_cycle(machine);', '}'];
        }
        if (step.advance !== undefined) {
            return [`advance(machine, ${cInteger(BigInt(Math.round(step.advance * NS_PER_MS)))});`];
        }
        if (step.runFor !== undefined) {
            return [`run_for(machine, ${cInteger(BigInt(Math.round(step.runFor * NS_PER_MS)))});`];
        }
        if (step.set) {
            const lines: string[] = [];
            for (const [name, value] of Object.entries(step.set)) {
                const variable = this.index.findVariable(name);
                if (!variable || variable.const || variable.readonly) {
                    return undefined;
                }
                const literal = this.literal(value, this.api.variableType(variable));
                if (this.api.isInternal(variable)) {
                    lines.push(`${this.internalsName()}::set_${variable.name}(machine, ${literal});`);
                } else {
                    lines.push(`machine.${this.api.interfaceAccess(variable)}${this.api.setter(variable)}(${literal});`);
                }
            }
            return lines;
        }
        return [];
    }

    private internalsName(): string {
        return this.api.namespace ? `${this.api.namespace}::${this.api.internalsStruct}` : `::${this.api.internalsStruct}`;
    }

    private periodNs(): string {
        return cInteger(BigInt(Math.round(this.api.cyclePeriod * NS_PER_MS)));
    }

    private expect(expect: ScenarioExpectation, index: number): string[] {
        const lines: string[] = [];
        const fail = (message: string) => `fail(${index}, ${message});`;
        for (const name of expect.active ?? []) {
            const state = this.stateOf(name);
            lines.push(
                `if (!machine.isStateActive(Machine::${this.api.state(state)})) {`,
                `    ${fail(`${cString(`expected '${name}' to be active; active: `)} + describe_states(machine, false)`)}`,
                '}'
            );
        }
        for (const name of expect.inactive ?? []) {
            const state = this.stateOf(name);
            lines.push(
                `if (machine.isStateActive(Machine::${this.api.state(state)})) {`,
                `    ${fail(`${cString(`expected '${name}' to be inactive; active: `)} + describe_states(machine, false)`)}`,
                '}'
            );
        }
        if (expect.configuration) {
            const expected = new Set(expect.configuration.map(name => this.stateOf(name)));
            const conditions = this.index.states.map((state, i) => expected.has(state) ? `!leaf_active(machine, ${i})` : `leaf_active(machine, ${i})`);
            const names = [...expected].map(s => this.index.stateName(s)).sort().join(', ');
            lines.push(
                `if (${conditions.join('\n        || ')}) {`,
                `    ${fail(`${cString(`expected configuration [${names}] but was `)} + describe_states(machine, true)`)}`,
                '}'
            );
        }
        if (expect.final !== undefined) {
            lines.push(
                `if (${expect.final ? '!' : ''}machine.isFinal()) {`,
                `    ${fail(cString(`expected the state machine ${expect.final ? '' : 'not '}to be final`))}`,
                '}'
            );
        }
        for (const [name, value] of Object.entries(expect.variables ?? {})) {
            const variable = this.index.findVariable(name);
            if (!variable) {
                lines.push(fail(cString(`unknown variable '${name}'`)));
                continue;
            }
            const getter = this.api.isInternal(variable)
                ? `${this.internalsName()}::get_${variable.name}(machine)`
                : `machine.${this.api.interfaceAccess(variable)}${this.api.getter(variable)}()`;
            const type = this.api.variableType(variable);
            let check: string;
            switch (type) {
                case 'real':
                    check = typeof value === 'number' ? `!same_real(${getter}, ${realLiteral(value)})` : 'true';
                    break;
                case 'boolean':
                    check = typeof value === 'boolean' ? `${getter} != ${value}` : 'true';
                    break;
                case 'string':
                    check = typeof value === 'string' ? `${getter} != ${cString(value)}` : 'true';
                    break;
                default:
                    check = typeof value === 'number' && Number.isInteger(value) ? `${getter} != ${cInteger(BigInt(value))}` : 'true';
            }
            lines.push(
                `if (${check}) {`,
                `    ${fail(`${cString(`expected variable '${name}' = ${JSON.stringify(value)} but was `)} + format(${getter})`)}`,
                '}'
            );
        }
        if (expect.outEvents) {
            lines.push(...this.compareList('out events', expect.outEvents, 'out_events', index));
        }
        if (expect.calls) {
            lines.push(...this.compareList('calls', expect.calls, 'calls', index));
        }
        lines.push('out_events.clear();', 'calls.clear();');
        return lines;
    }

    private compareList(what: string, expected: string[], log: string, index: number): string[] {
        const normalized = expected.map(normalize);
        return [
            `if (${log} != std::vector<std::string>{${normalized.map(cString).join(', ')}}) {`,
            `    fail(${index}, std::string(${cString(`expected ${what} [${expected.join('; ')}] but got `)}) + describe(${log}, "; "));`,
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

    private literal(value: ScenarioValue, type: HsmType): string {
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
                return `sc::string(${cString(value)})`;
            default:
                if (typeof value !== 'number' || !Number.isInteger(value)) {
                    throw new Error(`${JSON.stringify(value)} is not an integer`);
                }
                return cInteger(BigInt(value));
        }
    }
}

function defaultLiteral(type: HsmType): string {
    switch (type) {
        case 'real': return '0.0';
        case 'boolean': return 'false';
        case 'string': return 'sc::string()';
        default: return '0';
    }
}

function realLiteral(value: number): string {
    if (!Number.isFinite(value)) {
        return Number.isNaN(value) ? 'std::numeric_limits<double>::quiet_NaN()'
            : `${value < 0 ? '-' : ''}std::numeric_limits<double>::infinity()`;
    }
    const text = String(value);
    return /^-?\d+$/.test(text) ? `${text}.0` : text;
}

/** Removes white space outside of string literals (like the scenario runner). */
function normalize(text: string): string {
    return text.replace(/("(?:\\.|[^"\\])*")|\s+/g, (_match, literal: string | undefined) => literal ?? '');
}

function commentOf(step: ScenarioStep): string {
    const { comment: _comment, ...rest } = step;
    return JSON.stringify(rest).replace(/\\$/, '\\ .');
}

/** Formatting and comparison of values like the interpreter; shared by all harnesses in a translation unit. */
const RUNTIME: string[] = [
    '#ifndef HSM_SCENARIO_RUNTIME_',
    '#define HSM_SCENARIO_RUNTIME_',
    '',
    '#include <cstdio>',
    '#include <cstdlib>',
    '#include <limits>',
    '#include <string>',
    '#include <vector>',
    '',
    'namespace hsm_scenario {',
    '',
    'inline std::string format(sc::integer value) {',
    '    return std::to_string(value);',
    '}',
    '',
    'inline std::string format(bool value) {',
    '    return value ? "true" : "false";',
    '}',
    '',
    '// A JSON string literal, like JSON.stringify.',
    'inline std::string format(const std::string& value) {',
    '    std::string result = "\\"";',
    '    for (const char ch : value) {',
    '        switch (ch) {',
    '        case \'"\': result += "\\\\\\""; break;',
    '        case \'\\\\\': result += "\\\\\\\\"; break;',
    '        case \'\\n\': result += "\\\\n"; break;',
    '        case \'\\r\': result += "\\\\r"; break;',
    '        case \'\\t\': result += "\\\\t"; break;',
    '        case \'\\b\': result += "\\\\b"; break;',
    '        case \'\\f\': result += "\\\\f"; break;',
    '        default:',
    '            if (static_cast<unsigned char>(ch) < 0x20) {',
    '                char buffer[8];',
    '                std::snprintf(buffer, sizeof buffer, "\\\\u%04x", static_cast<unsigned>(static_cast<unsigned char>(ch)));',
    '                result += buffer;',
    '            } else {',
    '                result += ch;',
    '            }',
    '        }',
    '    }',
    '    return result + "\\"";',
    '}',
    '',
    '// A real like the interpreter formats it (JavaScript number to string, integral values with ".0").',
    'inline std::string format(double value) {',
    '    if (value != value) {',
    '        return "NaN";',
    '    }',
    '    if (value == 0) {',
    '        return "0.0";',
    '    }',
    '    std::string sign = value < 0 ? "-" : "";',
    '    if (value < 0) {',
    '        value = -value;',
    '    }',
    '    if (value > std::numeric_limits<double>::max()) {',
    '        return sign + "Infinity";',
    '    }',
    '    char buffer[64];',
    '    for (int precision = 1; precision <= 17; precision++) {',
    '        std::snprintf(buffer, sizeof buffer, "%.*e", precision - 1, value);',
    '        if (std::strtod(buffer, nullptr) == value) {',
    '            break;',
    '        }',
    '    }',
    '    std::string digits;',
    '    const char* p = buffer;',
    '    for (; *p != \'e\'; p++) {',
    '        if (*p >= \'0\' && *p <= \'9\') {',
    '            digits += *p;',
    '        }',
    '    }',
    '    while (digits.size() > 1 && digits.back() == \'0\') {',
    '        digits.pop_back();',
    '    }',
    '    const int k = static_cast<int>(digits.size());',
    '    const int point = std::atoi(p + 1) + 1;',
    '    std::string result;',
    '    if (k <= point && point <= 21) {',
    '        result = digits + std::string(static_cast<std::size_t>(point - k), \'0\') + ".0";',
    '    } else if (0 < point && point <= 21) {',
    '        result = digits.substr(0, static_cast<std::size_t>(point)) + "." + digits.substr(static_cast<std::size_t>(point));',
    '    } else if (-6 < point && point <= 0) {',
    '        result = "0." + std::string(static_cast<std::size_t>(-point), \'0\') + digits;',
    '    } else {',
    '        result = digits.substr(0, 1) + (k > 1 ? "." + digits.substr(1) : "") + "e" + (point - 1 >= 0 ? "+" : "-")',
    '            + std::to_string(point - 1 >= 0 ? point - 1 : 1 - point);',
    '    }',
    '    return sign + result;',
    '}',
    '',
    'inline bool same_real(double actual, double expected) {',
    '    const double difference = actual > expected ? actual - expected : expected - actual;',
    '    const double magnitude = expected < 0 ? -expected : expected;',
    '    return actual == expected || difference <= 1e-9 * (magnitude > 1 ? magnitude : 1);',
    '}',
    '',
    'inline std::string describe(const std::vector<std::string>& items, const char* separator) {',
    '    std::string result = "[";',
    '    for (std::size_t i = 0; i < items.size(); i++) {',
    '        result += (i > 0 ? separator : "") + items[i];',
    '    }',
    '    return result + "]";',
    '}',
    '',
    '} // namespace hsm_scenario',
    '',
    '#endif // HSM_SCENARIO_RUNTIME_',
    ''
];
