# Scenario tests (conformance suite)

Every `*.json` file in this directory describes one run of a state machine and the observations
expected along the way. The scenarios pin down the execution semantics of
[`docs/semantics.md`](../../../../docs/semantics.md): scenarios named `sN-...` check a rule of
section N, `example-...` scenarios run the models in [`examples/`](../../../../examples).

All implementations run the same scenarios: the interpreter (`test/scenarios.test.ts`, and
`hsm simulate <model> --script <scenario>`) and code generators, which compile a scenario into a
test harness. The format therefore only uses plain JSON values and no JS specifics.

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
| `model`       | Path of a `.hsm` file, relative to the scenario file. Exactly one of `model` and `text` is required. |
| `text`        | Inline model; a string or an array of lines (joined with `\n`). |
| `operations`  | Optional scripted results of operations by declared name (`op` or `Iface.op`): the values are returned in call order, the last value is repeated. Operations not listed return the default value of their return type (`0`, `0.0`, `false`, `""`). |
| `steps`       | The steps, executed in order. |

### Steps

Every step contains exactly one of the following keys (plus an optional `comment`):

| Step                               | Action |
|------------------------------------|--------|
| `{ "enter": true }`                | Enter the state machine (`enter()`). |
| `{ "exit": true }`                 | Exit the state machine (`exit()`). |
| `{ "raise": "e" }`                 | Raise the in event `e` (`Iface.e` for named interfaces). Optional `"value": v` for events with a type. Cycle based: collected for the next cycle; event driven: processed immediately. |
| `{ "runCycle": true }`             | Run one cycle (`runCycle()`); `"runCycle": n` runs `n` cycles. Event driven: a step without events. |
| `{ "advance": ms }`                | Advance the virtual clock by `ms` milliseconds (`advanceTime`). Cycle based: no cycle is run, expired timers are present in the next cycle. Event driven: each expiring timer triggers its step. |
| `{ "runFor": ms }`                 | Advance the clock by `ms` and run a cycle whenever the clock reaches a multiple of the cycle period, counted from `enter` (`runFor`). Event driven: same as `advance`. |
| `{ "set": { "x": v, ... } }`       | Set variables (`setVariable`). |
| `{ "expect": { ... } }`            | Check observations (see below). |

An action step may carry `"expectError": "text"`: the action must fail with a runtime error whose
message contains `text` (for example a choice without enabled branch). The interpreter continues
with the next step (the configuration may be inconsistent). Implementations without runtime error
detection may skip scenarios containing `expectError`; the C harness checks the message passed to
the error hook (an unknown event is rejected when the harness is generated: a compile time error in C).

### Expectations

All keys are optional:

| Key             | Check |
|-----------------|-------|
| `active`        | Each listed state is active. States are given by fully qualified name (`Closed.Active.Playing`, regions are not part of the name) or a unique suffix (`Playing`). |
| `inactive`      | Each listed state is not active. |
| `configuration` | The set of active **leaf** states (active states without active sub states) is exactly the listed set (order does not matter). A composite state whose regions are all final is a leaf. |
| `final`         | Whether the state machine is final (`isFinal()`). |
| `variables`     | Values of variables and constants by declared name (`x`, `Iface.x`). Integers and booleans are compared exactly, reals with a relative tolerance of `1e-9`. |
| `outEvents`     | The out events raised since the previous `expect` step, in order. |
| `calls`         | The operation calls made since the previous `expect` step, in order. |

Every `expect` step clears the recorded out events and calls, whether it checks them or not.

Out events and calls are written in a canonical text form: `name` for an out event without value,
`name(value)` for an out event with value, and `name(arg1, arg2)` for calls (`name()` without
arguments), with the arguments in parameter order (variable arguments flattened). Values are
formatted as integers `42`, reals with a decimal point or exponent `2.0`, `0.5`, booleans `true` /
`false` and strings as JSON strings `"text"`. White space outside of strings is ignored in the
comparison. The declared name is used for named interfaces: `Panel.shown(2)`.

## Running

```sh
npm test                                                     # all scenarios against the interpreter
node packages/language/bin/cli.js simulate examples/door.hsm \
    --script packages/language/test/scenarios/example-door.json   # after npm run build
```
