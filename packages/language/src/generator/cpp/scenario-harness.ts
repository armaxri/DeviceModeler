import { findEnumerator } from '../../cpp-enums.js';
import * as ast from '../../generated/ast.js';
import { returnTypeOf, typeOfEvent, typeOfParameter, typeOfVariable, type HsmType } from '../../hsm-typesystem.js';
import type { Scenario, ScenarioExpectation, ScenarioStep, ScenarioValue } from '../../simulation/scenario.js';
import { cInteger, cString, indent } from '../common/code.js';
import { cppSpelling } from './cpp-code.js';
import type { CppApi } from './cpp-generator.js';
import { hsmTypeOfCpp, isCppType, type CppHsmType } from '../../cpp-types.js';
import type { CppResolvedType } from '../../cpp-header/model.js';
import { isReferenceMember, isUsableInModel } from '../../class-members.js';

/** The object of the harness a reference member refers to. */
function referenceObject(variable: ast.VariableDeclaration): string {
    return `hsm_object_${variable.name}`;
}

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
            ...this.referenceObjects(),
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
            ...this.formatters(),
            ...this.callbacks(),
            ...this.observers(),
            ...this.timerService(),
            ...this.driver(),
            ...this.stateTables(),
            'int run() {',
            ...indent([
                `Machine machine${this.api.referenceMembers.length > 0 ? `(${this.api.referenceMembers.map(v => referenceObject(v)).join(', ')})` : ''};`,
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
            '',
            ...this.methods()
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
            const reference = isReferenceMember(variable);
            const type = this.api.declaredType(variable);
            const member = this.api.internalMember(variable);
            lines.push(
                `    static ${type} get_${variable.name}(const ${this.api.className}& machine) {`,
                `        return machine.${member};`,
                '    }'
            );
            if (!variable.const && !reference) { // (the objects of reference members are set directly)
                lines.push(
                    `    static void set_${variable.name}(${this.api.className}& machine, ${type} value) {`,
                    `        machine.${member} = value;`,
                    '    }'
                );
            }
        }
        lines.push('};', '');
        if (this.api.namespace) {
            lines.push(`} // namespace ${this.api.namespace}`, '');
        }
        return lines;
    }

    /**
     * The body of a mocked operation: records the call and returns the scripted values (the counter of the
     * scripted values is declared by the caller; `undefined`: no counter needed).
     */
    private mockBody(operation: ast.OperationDeclaration, counter: string, parameterNames = this.api.operationParameterNames(operation)): { body: string[], counter?: string } {
        const name = this.index.declarationName(operation);
        const returnType = returnTypeOf(operation);
        const scripted = this.scenario.operations?.[name] ?? this.scenario.operations?.[operation.name] ?? [];
        const body: string[] = [`std::string hsm_text = ${cString(`${name}(`)};`];
        let first = true;
        operation.parameters.forEach((parameter, k) => {
            const parameterName = parameterNames[k];
            const format = `${this.namespace}::format(${parameter.varArgs ? 'hsm_value' : parameterName})`;
            if (parameter.varArgs) {
                body.push(`for (const auto& hsm_value : ${parameterName}) {`, `    hsm_text += hsm_text.back() == '(' ? "" : ",";`, `    hsm_text += ${format};`, '}');
            } else {
                body.push(...(first ? [] : ['hsm_text += ",";']), `hsm_text += ${format};`);
            }
            first = false;
        });
        body.push('hsm_text += ")";', `${this.namespace}::calls.push_back(hsm_text);`);
        if (returnType === 'void') {
            return { body };
        }
        if (scripted.length === 0) {
            body.push(`return ${defaultLiteral(returnType)};`);
            return { body };
        }
        body.push(
            `static const ${this.api.declaredType(operation)} hsm_values[] = {${scripted.map(v => this.literal(v, returnType)).join(', ')}};`,
            `return hsm_values[${counter} < ${scripted.length} ? ${counter}++ : ${scripted.length - 1}];`
        );
        return { body, counter };
    }

    private callbacks(): string[] {
        const lines: string[] = [];
        this.api.operationScopes.forEach((scope, i) => {
            lines.push(`class Callbacks${i} : public Machine::${scope.callbackClass} {`, 'public:');
            const counters: string[] = [];
            scope.operations.forEach((operation, j) => {
                const { body, counter } = this.mockBody(operation, `hsm_next${j}`);
                if (counter) {
                    counters.push(`std::size_t ${counter} = 0;`);
                }
                lines.push(`    ${this.api.declaredType(operation)} ${operation.name}(${this.api.operationParameters(operation)}) override {`, ...indent(body, 2), '    }');
            });
            if (counters.length > 0) {
                lines.push('', 'private:', ...indent(counters));
            }
            lines.push('};', '');
        });
        return lines;
    }

    /** The objects the reference members of the class sections refer to (constructor arguments; `set` steps assign them). */
    private referenceObjects(): string[] {
        return this.api.referenceMembers.map(variable => {
            if (!isUsableInModel(variable)) {
                throw new Error(`The scenario harness cannot create the object of the reference member '${variable.name}' (${this.api.declaredType(variable)})`);
            }
            return `${this.api.referencedType(variable)} ${referenceObject(variable)}{};`;
        });
    }

    /** Definitions of the member functions of the class sections (implemented by the application): mocks like the callbacks. */
    private methods(): string[] {
        const lines: string[] = [];
        for (const operation of this.api.classMethods) {
            // (own parameter names: the names of the model may be names of members, -Wshadow)
            const names = operation.parameters.map((_, i) => `hsm_arg${i}`);
            const { body, counter } = this.mockBody(operation, 'hsm_next', names);
            lines.push(`${this.api.methodDefinition(operation, names)} {`, ...indent([...(counter ? [`static std::size_t ${counter} = 0;`] : []), ...body]), '}', '');
        }
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
            lines.push(`class Observer${i} : public sc::rx::Observer<${hasValue ? this.api.declaredType(event) : 'void'}> {`, 'public:');
            if (hasValue) {
                lines.push(`    void next(const ${this.api.declaredType(event)}& value) override {`, `        out_events.push_back(${cString(`${name}(`)} + format(value) + ")");`, '    }');
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
                if (isReferenceMember(variable)) {
                    lines.push(`${referenceObject(variable)} = ${literal};`);
                } else if (this.api.isInternal(variable)) {
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
            const check = this.mismatch(getter, value, type);
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

    /** The condition that the value `actual` (C++ expression) differs from the expected value (structs: the listed members). */
    private mismatch(actual: string, value: ScenarioValue, type: HsmType): string {
        if (isCppType(type)) {
            const resolved = type.resolved;
            if (resolved.kind === 'enum') {
                return `${actual} != ${this.literal(value, type)}`;
            }
            if (resolved.kind === 'struct') {
                if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                    return 'true';
                }
                const conditions = Object.entries(value).map(([member, expected]) => {
                    const field = resolved.fields.find(f => f.name === member);
                    const fieldType = field ? hsmTypeOfCpp(field.type, type.index).type : undefined;
                    return field && fieldType ? this.mismatch(`${actual}.${member}`, expected, fieldType) : 'true';
                });
                return conditions.length === 0 ? 'false' : conditions.map(c => `(${c})`).join(' || ');
            }
            const element = hsmTypeOfCpp(resolved.element, type.index).type;
            if (!Array.isArray(value) || !element || value.length !== resolved.length) {
                return 'true';
            }
            return value.map((expected, i) => `(${this.mismatch(`${actual}[${i}]`, expected, element)})`).join(' || ') || 'false';
        }
        switch (type) {
            case 'real':
                return typeof value === 'number' ? `!same_real(${actual}, ${realLiteral(value)})` : 'true';
            case 'boolean':
                return typeof value === 'boolean' ? `${actual} != ${value}` : 'true';
            case 'string':
                return typeof value === 'string' ? `${actual} != ${cString(value)}` : 'true';
            default:
                return typeof value === 'number' && Number.isInteger(value) ? `${actual} != ${cInteger(BigInt(value))}` : 'true';
        }
    }

    // ----- values of C++ types

    /** The C++ types used by the state machine (and by their members), in dependency order. */
    private cppTypes(): CppHsmType[] {
        const result: CppHsmType[] = [];
        const seen = new Set<string>();
        const visit = (type: HsmType | undefined) => {
            if (!isCppType(type) || seen.has(type.cppName) || type.cppName.includes('(anonymous)')) {
                return;
            }
            seen.add(type.cppName);
            const resolved = type.resolved;
            if (resolved.kind === 'struct') {
                resolved.fields.forEach(f => visit(hsmTypeOfCpp(f.type, type.index).type));
            } else if (resolved.kind === 'array') {
                visit(hsmTypeOfCpp(resolved.element, type.index).type);
            }
            result.push(type);
        };
        for (const variable of this.index.variables()) {
            visit(typeOfVariable(variable));
        }
        for (const event of this.index.events()) {
            visit(typeOfEvent(event));
        }
        for (const scope of this.api.operationScopes) {
            for (const operation of scope.operations) {
                visit(returnTypeOf(operation));
                operation.parameters.forEach(p => visit(typeOfParameter(p)));
            }
        }
        return result;
    }

    /** The C++ spelling of a type (for parameters of the format functions). */
    private spelling(type: CppResolvedType, index: CppHsmType['index']): string {
        if (type.kind === 'enum' || type.kind === 'struct') {
            return type.cppName;
        }
        if (type.kind === 'array') {
            return `std::array<${this.spelling(type.element, index)}, ${type.length ?? 0}>`;
        }
        return type.kind === 'string' ? 'sc::string' : cppSpelling(type);
    }

    /** The parameter declaration of a format function for a type (`const std::uint8_t (&value)[2]` for C arrays). */
    private formatParameter(type: CppHsmType): string {
        const resolved = type.resolved;
        if (resolved.kind === 'enum') {
            return `${type.cppName} value`;
        }
        if (resolved.kind === 'array' && !resolved.cppName.startsWith('std::array')) {
            return `const ${this.spelling(resolved.element, type.index)} (&value)[${resolved.length ?? 0}]`;
        }
        return `const ${resolved.kind === 'array' ? this.spelling(resolved, type.index) : type.cppName}& value`;
    }

    /** `format` functions for the values of the C++ types (canonical text like the interpreter). */
    private formatters(): string[] {
        const types = this.cppTypes();
        const lines: string[] = ['using hsm_scenario::format;', ''];
        if (types.length === 0) {
            return lines;
        }
        lines.push(...types.map(type => `std::string format(${this.formatParameter(type)});`), '');
        for (const type of types) {
            const resolved = type.resolved;
            lines.push(`std::string format(${this.formatParameter(type)}) {`);
            if (resolved.kind === 'enum') {
                const seen = new Set<bigint>();
                for (const enumerator of resolved.enumerators) {
                    if (!seen.has(enumerator.value)) {
                        seen.add(enumerator.value);
                        lines.push(`    if (value == ${type.cppName}::${enumerator.name}) {`, `        return ${cString(`${type.cppName}::${enumerator.name}`)};`, '    }');
                    }
                }
                lines.push(`    return ${cString(`${type.cppName}(`)} + std::to_string(static_cast<long long>(value)) + ")";`);
            } else if (resolved.kind === 'struct') {
                // without white space: the expected texts are compared without white space outside of strings
                const parts = resolved.fields.map((f, i) => `${cString(`${i > 0 ? ',' : ''}${f.name}:`)} + format(value.${f.name})`);
                lines.push(`    return std::string("{")${parts.map(p => ` + ${p}`).join('')} + "}";`);
            } else {
                lines.push(
                    '    std::string result = "[";',
                    `    for (std::size_t i = 0; i < ${resolved.length ?? 0}; i++) {`,
                    '        result += (i > 0 ? "," : "") + format(value[i]);',
                    '    }',
                    '    return result + "]";'
                );
            }
            lines.push('}', '');
        }
        return lines;
    }

    /** A C++ expression for a value of a C++ type given in a scenario (enumerator names, objects, arrays). */
    private cppLiteral(value: ScenarioValue, type: CppHsmType): string {
        const resolved = type.resolved;
        if (resolved.kind === 'enum') {
            if (typeof value === 'string') {
                const enumerator = findEnumerator(resolved, value);
                if (!enumerator) {
                    throw new Error(`'${value}' is not an enumerator of ${type.cppName}`);
                }
                return `${type.cppName}::${enumerator.name}`;
            }
            if (typeof value === 'number' && Number.isInteger(value)) {
                return `static_cast<${type.cppName}>(${cInteger(BigInt(value))})`;
            }
            throw new Error(`${JSON.stringify(value)} is not a value of ${type.cppName}`);
        }
        const assignments: string[] = [];
        const assign = (target: string, item: ScenarioValue, itemType: CppResolvedType) => {
            const mapped = hsmTypeOfCpp(itemType, type.index).type;
            if (isCppType(mapped) && mapped.kind !== 'enum') {
                const inner = mapped.resolved;
                if (inner.kind === 'struct' && typeof item === 'object' && item !== null && !Array.isArray(item)) {
                    for (const [member, v] of Object.entries(item)) {
                        const field = inner.fields.find(f => f.name === member);
                        if (!field) {
                            throw new Error(`${mapped.cppName} has no member '${member}'`);
                        }
                        assign(`${target}.${member}`, v, field.type);
                    }
                    return;
                }
                if (inner.kind === 'array' && Array.isArray(item)) {
                    item.forEach((v, i) => assign(`${target}[${i}]`, v, inner.element));
                    return;
                }
                throw new Error(`${JSON.stringify(item)} is not a value of ${mapped.cppName}`);
            }
            const literal = this.literal(item, mapped ?? 'integer');
            assignments.push(`${target} = ${itemType.kind === 'integer' || (itemType.kind === 'real' && itemType.bits === 32) ? `static_cast<${cppSpelling(itemType)}>(${literal})` : literal};`);
        };
        assign('v', value, resolved);
        const declared = resolved.kind === 'array' ? this.spelling(resolved, type.index) : type.cppName;
        return `[] { ${declared} v{}; ${assignments.join(' ')} return v; }()`;
    }

    private literal(value: ScenarioValue, type: HsmType): string {
        if (isCppType(type)) {
            return this.cppLiteral(value, type);
        }
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
    '#include <type_traits>',
    '#include <vector>',
    '',
    'namespace hsm_scenario {',
    '',
    'inline std::string format(sc::integer value) {',
    '    return std::to_string(value);',
    '}',
    '',
    '// Integers of other C++ types (std::uint8_t, int, ...).',
    'template <typename T>',
    'inline typename std::enable_if<std::is_integral<T>::value && !std::is_same<T, bool>::value && !std::is_same<T, sc::integer>::value, std::string>::type',
    'format(T value) {',
    '    return std::is_signed<T>::value ? std::to_string(static_cast<long long>(value)) : std::to_string(static_cast<unsigned long long>(value));',
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
