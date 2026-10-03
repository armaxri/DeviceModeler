# Scenario tests (conformance suite)

Every `*.json` file in this directory describes one run of a state machine and the observations
expected along the way. The scenarios pin down the execution semantics of
[`docs/semantics.md`](../../../../docs/semantics.md): scenarios named `sN-...` check a rule of
section N, `example-...` scenarios run the models in [`examples/`](../../../../examples).

All implementations run the same scenarios: the interpreter (`test/scenarios.test.ts`, and
`devm simulate <model> --script <scenario>`) and the code generators (`test/cpp-generator.test.ts`,
`test/c-generator.test.ts`), which compile a scenario into a test harness. The format therefore only
uses plain JSON values and no JS specifics.

## File format

```json
{
    "name": "s7-choice",
    "description": "What the scenario checks.",
    "text": ["statemachine M {", "    ...", "}"],
    "operations": { "discInserted": [true, false] },
    "steps": [
        { "enter": true },
        { "expect": { "configuration": ["Closed.Stopped"], "variables": { "track": 1 } } },
        { "raise": "play" },
        { "runCycle": true },
        { "expect": { "active": ["Playing"], "calls": ["discInserted()", "startMotor()"] } }
    ]
}
```

| Key           | Meaning |
|---------------|---------|
| `name`        | Name of the scenario (the file name without `.json`). |
| `description` | The rule or behavior the scenario checks. |
| `model`       | Path of a `.devm` file, relative to the scenario file. Exactly one of `model` and `text` is required. |
| `text`        | Inline model; a string or an array of lines (joined with `\n`). |
| `files`       | Optional inline texts of further files the model imports (`import "motor.devm"`, `import "motor_types.h"`), by path relative to the model: `{ "motor.devm": ["statemachine Motor {", "...", "}"] }` (strings or arrays of lines; headers may include each other, e.g. `include/base/errors.h`). Used by the submachine scenarios `s9-*`, which the C and C++ generator tests skip (explicit list `SUBMACHINE_SCENARIOS` in `test/helpers.ts`) because the generators do not support submachine instances yet, and by the scenarios of C/C++ header imports `s10-cpp-*`, which the C generator test skips (`CPP_TYPE_SCENARIOS`); the C++ generator test writes the headers next to the generated code and compiles each of these scenarios separately. |
| `operations`  | Optional scripted results of operations by declared name (`op` or `Iface.op`, `motor.op` for an operation of the submachine instance `motor`): the values are returned in call order, the last value is repeated. Operations not listed return the default value of their return type (`0`, `0.0`, `false`, `""`). |
| `steps`       | The steps, executed in order. |

### Steps

Every step contains exactly one of the following keys (plus an optional `comment`):

| Step                               | Action |
|------------------------------------|--------|
| `{ "enter": true }`                | Enter the state machine (`enter()`). |
| `{ "exit": true }`                 | Exit the state machine (`exit()`). |
| `{ "raise": "e" }`                 | Raise the in event `e` (`Iface.e` for named interfaces). Optional `"value": v` for events with a type (values of C++ types as in `variables`; members of a struct that are not given get their default value). Cycle based: collected for the next cycle; event driven: processed immediately. |
| `{ "runCycle": true }`             | Run one cycle (`runCycle()`); `"runCycle": n` runs `n` cycles. Event driven: a step without events. |
| `{ "advance": ms }`                | Advance the virtual clock by `ms` milliseconds (`advanceTime`). Cycle based: no cycle is run, expired timers are present in the next cycle. Event driven: each expiring timer triggers its step. |
| `{ "runFor": ms }`                 | Advance the clock by `ms` and run a cycle whenever the clock reaches a multiple of the cycle period, counted from `enter` (`runFor`). Event driven: same as `advance`. |
| `{ "set": { "x": v, ... } }`       | Set variables (`setVariable`); enums also by the simple enumerator name (`"Fast"`), structs by an object (missing members get their default value). |
| `{ "expect": { ... } }`            | Check observations (see below). |

An action step may carry `"expectError": "text"`: the action must fail with a runtime error whose
message contains `text` (for example a choice without enabled branch). The interpreter continues
with the next step (the configuration may be inconsistent). Implementations without runtime error
detection may skip scenarios containing `expectError`; the C++ harness checks the message of the
`sc::StatemachineError` exception, the C harness the message passed to the error hook (an unknown event
is rejected when the harness is generated: a compile time error in C / C++).

### Expectations

All keys are optional:

| Key             | Check |
|-----------------|-------|
| `active`        | Each listed state is active. States are given by fully qualified name (`Closed.Active.Playing`, regions are not part of the name) or a unique suffix (`Playing`); states of submachine instances as `motor.On` (docs/semantics.md §9). |
| `inactive`      | Each listed state is not active. |
| `configuration` | The set of active **leaf** states (active states without active sub states) is exactly the listed set (order does not matter). A composite state whose regions are all final is a leaf. |
| `final`         | Whether the state machine is final (`isFinal()`). |
| `variables`     | Values of variables and constants by declared name (`x`, `Iface.x`). Integers and booleans are compared exactly, reals with a relative tolerance of `1e-9`. Values of C++ types: enums as the qualified enumerator name (`"motor::Mode::Fast"`), structs as objects – only the listed members are compared (`{"x": 1}`) –, arrays as arrays. |
| `outEvents`     | The out events raised since the previous `expect` step, in order. |
| `calls`         | The operation calls made since the previous `expect` step, in order. |

Every `expect` step clears the recorded out events and calls, whether it checks them or not.

Out events and calls are written in a canonical text form: `name` for an out event without value,
`name(value)` for an out event with value, and `name(arg1, arg2)` for calls (`name()` without
arguments), with the arguments in parameter order (variable arguments flattened). Values are
formatted as integers `42`, reals with a decimal point or exponent `2.0`, `0.5`, booleans `true` /
`false`, strings as JSON strings `"text"`, enum values as `motor::Mode::Fast` (`motor::Mode(7)` without
enumerator), structs as `{x: 1, y: 2}` and arrays as `[1, 2]`. White space outside of strings is ignored in the
comparison. The declared name is used for named interfaces: `Panel.shown(2)`.

## Running

```sh
npm test                                                     # all scenarios against the interpreter
node packages/language/bin/cli.js simulate examples/door.devm \
    --script packages/language/test/scenarios/example-door.json   # after npm run build
```
