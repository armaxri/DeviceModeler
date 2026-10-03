# Execution semantics

This document defines how a state machine of the Device Modeler executes. The interpreter (simulation) and all
code generators implement exactly these rules, and they share the scenario tests in
`packages/language/test/scenarios`. The rules follow the statechart semantics of itemis CREATE
(formerly YAKINDU Statechart Tools) where that is practical; deliberate differences are marked
as **Deviation**.

## 1. Structure

- The state machine itself is the **top-level region**. A composite state contains either
  sub vertices directly (one implicit region) or several orthogonal `region`s.
- The **active configuration** is the set of active states. If a state is active, its parent
  state is active; in every region of an active composite state exactly one vertex is active
  (states and final states only – pseudo states are never active).
- **Transition priority**: the outgoing transitions of a vertex are checked in document order
  (depth-first order of the text). The first enabled transition is taken.
- **Region order**: orthogonal regions are processed in document order. Sub regions are processed
  in the order described in §4.

## 2. Data

- Types: `integer` (64-bit signed in the interpreter, `int64_t` in C and C++), `real` (double), `boolean`,
  `string`, `void`. Integer division truncates toward zero; `%` has the sign of the dividend.
  An `integer` is implicitly converted to `real` where a `real` is expected (mixed arithmetic,
  comparisons, assignments, arguments, event values), never the other way around (use
  `as integer`, which truncates toward zero).
- Integer arithmetic wraps around on overflow (two's complement). Integer division or `%` by zero
  and shift amounts outside `0..63` are runtime errors. Real arithmetic follows IEEE 754 (division
  by zero yields an infinity).
- **Type aliases** (`alias Name : type`) are other names for their base type (resolved through
  chains of aliases); they have no semantics of their own.
- **`null`** (itemis CREATE) has its own type, which can only be assigned to `string` variables,
  parameters and event values and compared (`==`, `!=`) with strings and `null`. It denotes the
  **empty string**: `s = null` sets `s` to `""`, `s == null` is `true` iff `s` is empty, `null == null`
  is `true`. The type of a variable cannot be inferred from `null`.
  **Deviation:** in itemis CREATE the type of `null` is not compatible with `string` in the default
  domain (it is meant for pointer types of the C/C++ domains, `null == null` is valid); the Device Modeler allows it
  for strings because `std::string` in the generated C++ code and the string buffers in C cannot be
  null, all implementations use the empty string. Pointer types may follow with C/C++ header types.
- `+` on two strings concatenates them. `%` and the bitwise and shift operators apply to integers
  only, relational operators (`<` ...) to numbers only (see `typesystem.ts`).
- A variable without declared type has the type of its initializer (no initializer: `integer`).
- Variables and constants are initialized in declaration order when the state machine is entered
  (`enter`). Without initializer: `0`, `0.0`, `false`, `""`.
- **Operations** are implemented by the host (the application using the state machine). The
  interpreter lets the host register callbacks; an unregistered operation returns the default
  value of its return type. A result that does not fit the return type is a runtime error.
- Expressions are evaluated left to right, `&&` / `||` short-circuit, assignments are expressions
  (value = assigned value). Bitwise operators apply to integers only.
- Events: `in` events are raised by the host, `out` events are raised by the state machine and
  observed by the host, events of the `internal` scope are raised and consumed by the machine.
  Interface events without direction are `in` events. When the machine raises an `in` event it is
  treated like an internal event. `out` events are only reported to the host; they do not trigger
  reactions. `raise e : v` stores `v` as the value of `e` immediately; `valueof(e)` returns the
  value of the most recent occurrence (initially the default value of the event type).
- `active(S)` is true if the state `S` is in the active configuration.
- An event used as an expression (e.g. the guard `[e1 && x > 0]`) is `true` if the event is present
  in the current step.
- `x++` / `x--` increment / decrement the numeric variable `x`; the value of the expression is the
  value before the operation.
- Values of **imported C/C++ types** (enums, structs, arrays, integer widths) follow §10.

## 3. Execution modes

Selected by annotations in the state machine (`@CycleBased(period)` is the default, with a period
of 200 ms):

### Cycle based (`@CycleBased(period)`)

- In events raised by the host are **collected** and all become present at the beginning of the
  next run cycle (`runCycle()`), which is triggered by the host periodically.
- A run cycle performs **one step** (§4) in which all collected events are present at once.
- Internal events raised during a cycle become present immediately and are visible to regions that
  are processed later in the same cycle. At the end of the cycle all events are cleared. Internal
  events raised outside of a cycle (by entry reactions executed by `enter()`) are present in the
  next cycle.
- Out events raised in a cycle are reported to the host during the cycle.

### Event driven (`@EventDriven`)

- Every in event raised by the host triggers a **run-to-completion step** immediately, in which
  only this event is present.
- Internal events raised during a step are appended to an **internal queue**. After the step, the
  queued internal events are processed one per step, before the next in event of the host is
  processed.
- Time events (§6) are processed like in events.
- In events raised by the host while a step is running (e.g. from an operation callback) are queued
  and processed after the internal queue.
- Additionally a step without events is performed after entering the state machine, so that
  transitions and reactions without event trigger (`always`, guard only, §5) can fire.
  **Deviation:** itemis CREATE only performs such steps with `@SuperSteps(yes)`.

`@SuperSteps` and `@EventBuffering` are not supported yet (the validator reports a warning).

## 4. Step

A step processes the active configuration top down. Let `react(s)` be the processing of the active
state `s`; it returns whether a transition was taken that left `s` (or one of its ancestors).

**Parent first** (default, `@ParentFirstExecution`):

1. Check the outgoing transitions of `s` in priority order; take the first enabled one and return
   `true`.
2. Otherwise execute all enabled **local reactions** of `s` (in document order).
3. Then, for each region of `s` in order, call `react` for its active state (a taken transition in
   one region does not prevent the processing of the next region, unless it left `s`).
4. Return `false`.

**Child first** (`@ChildFirstExecution`):

1. For each region of `s` in order, call `react` for its active state. If a transition left `s`,
   return `true`.
2. If no transition was taken in any sub region, check the outgoing transitions of `s`; take the
   first enabled one and return `true`.
3. If neither a sub region nor `s` took a transition, execute the enabled local reactions of `s`
   (in document order). Return `false`.

A step first executes the enabled local reactions of the state machine itself (reactions declared
directly in the `statemachine` block, in document order, as in itemis CREATE), then calls `react` for
the active state of the top-level region. Every state takes part in
at most one transition per step: states entered during the step are not processed again in the
same step.

## 5. Transitions and reactions

A reaction (transition or local reaction) is **enabled** if

- one of its triggers matches: an event trigger whose event is present, a time trigger whose timer
  expired (§6), `always` / `oncycle` (always matches), or – **if the reaction has no trigger but
  a guard** – it matches in every step (like `always`);
- and its guard evaluates to `true` (no guard = `true`).

As in itemis CREATE, a transition leaving a **state** or a local reaction that has **neither a
trigger nor a guard** is never taken / executed (use `always` or `oncycle`; the validator warns); a guard-only transition (`A -> B : [x > 3]`)
is enabled in every step in which its guard holds. This also applies to the incoming transitions
of a join (§7). Transitions leaving pseudo states (initial transitions, choices, junctions, entry
points, history defaults, forks) have no triggers by design and are taken as described in §7 / §8.

`entry` and `exit` reactions are not evaluated in steps; they are executed when the state is
entered / exited (their guards are evaluated at that time, reactions in document order). `else` /
`default` are only allowed on transitions leaving a choice (§7). Transitions with `# X>` are not
checked in steps; they are only taken when the exit node `X` is reached (§7).

**Taking a transition** from source `s` to target `t`:

1. Determine the **transition scope**: the innermost region containing both `s` and `t`
   (for a self transition or a transition from a state to its own sub state: the region
   containing `s`; for a transition to an ancestor of `s`: the region containing the ancestor,
   which is exited and entered again; if `s` and `t` are in different orthogonal regions of a
   composite state, which is only possible through a synchronization: the region containing that
   composite state).
2. **Exit** the active state of that region below the scope: exit the innermost active states
   first (exit reactions, then cancel timers, then record history), up to the state in the scope.
3. Execute the effect of the transition.
4. **Enter** `t` (§8).

## 6. Time events

- `after n unit` starts a timer when the state owning the reaction is entered (for transitions:
  the source state) and fires once when it expires, even if the guard of the reaction is false
  at that time. `every n unit` fires periodically. Timers are cancelled when the state is exited.
  `n` is evaluated on entering the state (after its entry reactions). The timers of a state are
  started in document order; timers expiring at the same time fire in the order they were started.
- Units: `s`, `ms`, `us`, `ns`.
- The interpreter uses a **virtual clock** advanced by the host (`advanceTime(ms)`); expired timers
  are raised as time events:
  - cycle based: at the beginning of each run cycle all timers expired at the current time are
    present; an `every` timer is then rescheduled to its first period after the current time (it
    fires at most once per cycle). `runFor(ms)` advances the clock and runs a cycle whenever the
    clock reaches a multiple of the cycle period, counted from `enter()`.
  - event driven: each expired timer triggers a step, in expiry order; the clock is set to the
    expiry time for that step, so timers started in it are relative to the expiry time.
- Generated code asks the host to start / stop timers through a timer service interface.

## 7. Pseudo states

- **Choice / junction** (treated identically): when a transition reaches a choice, its outgoing
  transitions are evaluated immediately in priority order; transitions with `else` / `default` or
  without guard are taken only if no guarded transition is enabled. The effects of the incoming and
  the outgoing transition are both executed (incoming first); guards are evaluated after the
  incoming effect. If the outgoing transition leaves states the incoming transition did not exit
  (e.g. a choice inside a composite state targets a state outside of it), they are exited after the
  incoming and before the outgoing effect. If no transition is enabled, the runtime reports an
  error and the configuration is left inconsistent (validator warns about a missing `else`).
- **History** (`history`, `deephistory`): when a region is exited (because its state is exited),
  its last active state (or its final state) is recorded; transitions inside the region do not
  change the record. Entering a shallow history restores the recorded direct sub state (and enters it by
  default below); a deep history restores the recorded configuration recursively. Without recorded
  history the outgoing (default) transition of the history pseudo state is taken, otherwise the
  initial transition of the region.
- **Entry points** (`entry E` inside composite `C`): a transition to `C` with `# >E` enters `C`
  via `E` by taking the outgoing transition of `E`. Entry points with the same name may be placed in
  several orthogonal regions of `C` (as in itemis CREATE): every region of `C` that has an entry point
  `E` is entered through it (regions in document order), orthogonal regions without such an entry
  point are entered by default. A transition may list several entry points (`# >E1 >E2`); as in itemis
  CREATE, only the **first** one is used (the validator warns about the others).
- **Exit nodes** (`exit X` inside composite `C`): when a transition reaches `X`, `C` is exited
  completely and the first transition from `C` whose exit specification lists `X` (`# X>`, also
  `# X> Y>`: one transition may handle several exit nodes) and whose guard holds is taken (priority
  order); its triggers are ignored. If there is none, the runtime reports an error. Exit nodes with the
  same name may be placed in several orthogonal regions of `C`; reaching any of them has the same
  effect.
- **Synchronization** (`sync`): a sync with more than one incoming transition is a join. It is
  checked when the first of its source states is processed in a step (as one of that state's
  outgoing transitions) and fires when all incoming transitions are enabled in the same step
  (their source states are active, were not entered in this step and triggers / guards match);
  all sources are exited, the
  effects of the incoming transitions are executed in priority order, then the outgoing
  transitions (fork) are taken: their effects are executed and all targets are entered (the
  target states in different regions of the same composite state are entered together, the
  remaining regions by default).
- **Final state** (`X -> [*]`): entering the final state of a region makes the region *final*.
  When the top-level region is final, the state machine is final (`isFinal()`); no further steps
  are performed.

## 8. Entering states

Entering vertex `t` (target of a transition):

1. Enter all ancestors of `t` below the transition scope that are not active yet, outermost first
   (entry reactions, then timers). Orthogonal regions of these ancestors that do not contain `t`
   are entered by default.
2. Enter `t`: execute its entry reactions, start its timers.
3. If `t` is a composite state, enter each of its regions by default: take the initial transition
   (`[*] -> x`) of the region (executing its effect) and enter `x` recursively.
   **Deviation:** a composite state without initial transition that is entered by default is a
   runtime error.
4. If `t` is a pseudo state, continue as described in §7.

Entering the state machine (`enter()`): initialize variables, execute the `entry` reactions of the
state machine and start the timers of its reactions, then enter the top-level region by default.
`exit()` exits all active states (innermost first), then executes the `exit` reactions of the
state machine.

## 9. Submachine instances

A state machine may import other state machines (`import "motor.devm"`, resolved relative to the
importing file). A variable whose type is an imported state machine (`var motor : Motor`) is a
**submachine instance**; a state bound to it (`state Moving : motor`) runs the instance while it is
active. The instance is a separate object – its state machine is not inlined: it has its own active
configuration, history, variables, event values and timers. Two instances of the same state machine are
independent.

**Structure and scoping** (checked by the validator)

- An instance can be bound to at most one state; the bound state is a simple state (no sub states or
  regions, local reactions are allowed). An instance that is not bound never runs (warning).
- The parent uses the instance only through the **interfaces** of its state machine: it raises its `in`
  events (`raise motor.start`), observes its `out` events (`motor.stopped` as trigger or condition,
  `valueof(motor.failed)`), reads its interface variables and constants and assigns its interface
  variables (not constants or `readonly` variables), and tests its states (`active(motor.On)`). The
  internal scope, the operations and the instances of the instance's machine are not visible. Raising an
  out event of an instance or observing one of its in events is an error. Instances cannot be assigned,
  compared or used as values.
- Entry points (`entry E`) and exit nodes (`exit X`) declared at the top level of a state machine are its
  entry points / exit nodes as a submachine (`# >E`, `# X>` on transitions of the parent).
- The instance is executed with the execution mode and order of the top-level state machine; a
  different `@CycleBased` / `@EventDriven` / `@ParentFirstExecution` / `@ChildFirstExecution` of the
  instance's machine is ignored (warning).

**Data**: the variables of the instance are initialized when the top-level state machine is entered
(`enter()`, in declaration order; the variables of an instance are initialized where the instance is
declared). They **keep their values** when the instance is exited and entered again, as do its event
values and the history of its regions (entering the instance again re-enters its states, it does not
reset its data). **Deviation:** in the multi-state-machine models of itemis CREATE the parent controls the
lifecycle of an instance explicitly (`motor.enter()`, `motor.exit()`); the Device Modeler binds it to the state.

**Entering and exiting** (extends §5 and §8)

- Entering the bound state `S`: the entry reactions of `S` are executed and its timers started, then the
  instance is **entered**: the `entry` reactions of its state machine are executed, the timers of the
  machine's own reactions are started, and its top-level region is entered through the entry point `E` if
  the transition that entered `S` selects one (`# >E`), otherwise by default (initial transition). `S`
  entered through a history pseudo state of the parent enters the instance by default as well.
- Exiting `S`: the instance is **exited** first – its active states are exited (innermost first, history of
  its sub regions recorded), then the `exit` reactions of its state machine are executed and its timers
  cancelled; then the exit reactions of `S` are executed and its timers cancelled.
- When the instance reaches an **exit node** `X` of its state machine, it has already exited the source of
  the transition to `X`; `S` is then left by the first transition `S -> T : ... # X>` (also `# X> Y>`) of the
  parent whose guard holds (priority order, triggers ignored, like §7), which exits the instance and `S`.
  Without such a transition the runtime reports an error. A state machine that is not an instance becomes
  final when it reaches one of its top-level exit nodes.
- When the instance reaches its **final state**, it stays there (no further processing, no completion
  transition – as in itemis CREATE there are no completion events) until `S` is exited. The parent can
  observe it through out events or variables of the instance.

**Steps** (extends §4): the instance is processed like the only **sub region** of `S`. When `S` is
processed (`react(S)`) and was not entered in the current step:

- **Parent first**: the transitions of `S` are checked; if none is taken, the local reactions of `S` are
  executed, then the instance is processed.
- **Child first**: the instance is processed first; if it took a transition (or left `S` through an exit
  node), the transitions and local reactions of `S` are not checked in this step (like for sub regions);
  otherwise the transitions of `S` are checked, then its local reactions.
- Processing the instance: the events raised on it become present (see below), then the local reactions of
  its state machine are executed and its top-level active state is processed with the rules of §4 (states of
  the instance entered in this step are not processed again). At the end of the processing, its events are
  cleared.

**Events raised on the instance** (`raise motor.start`):

- Cycle based: the event is stored with the instance and becomes present at the beginning of the **next
  processing of the instance** – later in the same run cycle if the instance is processed after the raise
  (e.g. raised by a local reaction of `S` with parent first, by an earlier region, or by the transition
  entering `S`: the instance is not processed in the step it was entered, so it processes the event in the
  next cycle), otherwise in the next cycle. All stored events are present at once. Events stored for an
  instance that is not active at the end of the parent's step are discarded (also when the instance is exited).
- Event driven: the event is appended to the internal queue of the top-level machine (§3); when it is its
  turn, a step is performed in which only this event is present, in the instance (no event of the parent
  is present in this step). If the instance is not active any more, the event is discarded.
- Internal events of the instance and `in` events raised by the instance itself follow §3 within the
  instance (cycle based: present for the rest of its processing, otherwise at its next processing; event
  driven: queued in the internal queue of the top-level machine).

**Out events of the instance** (`motor.stopped`):

- They are not reported to the host as out events of the parent (they appear in the trace as
  `raise out motor.stopped`).
- An occurrence is visible to the parent from the moment it is raised until the end of the **next** step,
  but every trigger (and every event used as a condition) of the parent **sees it only once**: in the step it
  is raised in, it is visible to the reactions that are evaluated after the raise; in the next step, only to
  the reactions that did not evaluate it in the first step. Hence reactions processed after the instance see
  it in the same step, the others (e.g. the transitions of `S` with parent first) in the next step. Raising the
  same out event again replaces the occurrence.
- Event driven: raising an out event of an instance also queues a step without events (in the internal queue),
  in which the reactions that were processed before the instance see it.

**Time events**: the instance uses the virtual clock of the top-level machine. Cycle based: at the
beginning of a run cycle all expired timers of the machine and of all its instances are present (each in its
own machine). Event driven: each expiring timer of an instance triggers a step at its expiry time in which
only this time event is present in the instance.

**Names**: the states of an instance are reported by the interpreter as `motor.On` (the referable name of
the instance, then the qualified name of the state; nested instances `motor.gear.Idle`), directly after the
bound state in `activeStates`; the bound state is not a leaf of `activeLeafStates` while the instance has
active states. Traces, scenarios (`active`, `configuration`, `variables: { "motor.speed": 1 }`) and the unit
test language use these names. Operations of an instance are implemented by the host under the name
`motor.setPwm` (scenarios: `operations: { "motor.setPwm": [...] }`). The host cannot raise events of an
instance (they are raised by the state machine).

The conformance scenarios `s9-*` of `packages/language/test/scenarios` cover these rules (the C and C++
generators do not support submachine instances yet and skip them).

## 10. Types and constants of C/C++ headers

`import "motor_types.h"` makes the types and constants of a C/C++ header usable in a model
([docs/cpp-integration.md](cpp-integration.md) describes the supported C++ subset and the tools).

- **Integer types** (`std::uint8_t`, `int`, `char`, aliases of them) are `integer`. Expressions are
  evaluated with 64-bit integers as always (§2); a value is **converted to the C++ type of the place it is
  stored in** – a variable, a struct member, an array element, an event value, an argument of an operation
  – like the implicit conversion in C++: it wraps around to the width of the type (two's complement:
  `uint8_t u = 250; u += 10` gives `4`, `int8_t` `120 + 10` gives `-126`). Constant values out of the range
  of the type are warnings of the validator. `x as uint8_t` converts explicitly (wrap-around), the result is
  an `integer`.
- `float` is `real`, values stored in `float` places are rounded to single precision (`0.1` becomes
  `0.10000000149011612`); `double` / `long double` are `real`. `bool` is `boolean`. `std::string` is `string`;
  `const char*` and `std::string_view` constants can be read as strings, but no place can have these types.
- **Enums** are types of their own. A value is the numeric value of an enumerator (also values without
  enumerator after a cast). Values of the same enum are compared with `==` / `!=`; values of **unscoped**
  enums are integers in arithmetic, bitwise and relational operations and are assignable to `integer` /
  `real` (C++ integral promotion), values of `enum class` are not. `n as motor::Mode` converts an integer (or
  the value of another enum) to an enum value (wrapped to the underlying type), `mode as integer` the other
  way round. The default value is `T{}`, i.e. the value `0`.
- **Structs** are values (copied on assignment, never shared): members are read and assigned (`pos.x`,
  `cfg.timing.periodMs += 1`, `pos.x++`); an assignment to a member changes only that member of the variable.
  Structs are assigned as a whole (same type), **not compared** (C++ aggregates have no `==`). The default
  value is `T{}`: the default member initializers, zero (`0`, `0.0`, `false`, `""`, the value `0` of enums,
  `T{}` of nested structs) for the other members.
- **Arrays** (`std::array<T, N>`, `T[N]` members): elements `a[i]` are read and assigned; an index outside
  `0..N-1` is a runtime error ("Index … is out of bounds"). `std::array` values are assigned as a whole,
  C arrays only element by element. The default value has `N` default elements.
- **Constants** and enumerators of the headers (`motor::kMaxSpeed`, `motor::Mode::Fast`, `motor::kHome`)
  have the values computed by the analyzer with C++ semantics (widths, promotions, wrap-around of the
  header's constant expressions).
- **Host values**: enum values are exchanged as the qualified name of the first enumerator with the value
  (`"motor::Mode::Fast"`; a number if there is none); the host may also give the simple name or the number.
  Structs are objects with one entry per member (members the host does not give get their default value),
  arrays are arrays. Canonical text (traces, scenarios, calls): `motor::Mode::Fast`, `motor::Mode(7)` for a
  value without enumerator, `{x: 1, y: 2}`, `[1, 2, 3]`.

The conformance scenarios `s10-cpp-*` cover these rules (the C generator does not support C++ types and skips
them).
