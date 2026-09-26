# Execution semantics

This document defines how an HSM state machine executes. The interpreter (simulation) and all
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

- Types: `integer` (64-bit signed in the interpreter, `int64_t` in C), `real` (double), `boolean`,
  `string`, `void`. Integer division truncates toward zero; `%` has the sign of the dividend.
  An `integer` is implicitly converted to `real` where a `real` is expected, never the other way
  around (use `as integer`, which truncates toward zero).
- Variables and constants are initialized in declaration order when the state machine is entered
  (`enter`). Without initializer: `0`, `0.0`, `false`, `""`.
- **Operations** are implemented by the host (the application using the state machine). The
  interpreter lets the host register callbacks; an unregistered operation returns the default
  value of its return type.
- Expressions are evaluated left to right, `&&` / `||` short-circuit, assignments are expressions
  (value = assigned value). Bitwise operators apply to integers only.
- Events: `in` events are raised by the host, `out` events are raised by the state machine and
  observed by the host, events of the `internal` scope are raised and consumed by the machine.
  `raise e : v` stores `v` as the value of `e`; `valueof(e)` returns the value of the most recent
  occurrence (initially the default value of the event type).
- `active(S)` is true if the state `S` is in the active configuration.

## 3. Execution modes

Selected by annotations in the state machine (`@CycleBased(period)` is the default, with a period
of 200 ms):

### Cycle based (`@CycleBased(period)`)

- In events raised by the host are **collected** and all become present at the beginning of the
  next run cycle (`runCycle()`), which is triggered by the host periodically.
- A run cycle performs **one step** (§4) in which all collected events are present at once.
- Internal events raised during a cycle become present immediately and are visible to regions that
  are processed later in the same cycle. At the end of the cycle all events are cleared.
- Out events raised in a cycle are reported to the host during the cycle.

### Event driven (`@EventDriven`)

- Every in event raised by the host triggers a **run-to-completion step** immediately, in which
  only this event is present.
- Internal events raised during a step are appended to an **internal queue**. After the step, the
  queued internal events are processed one per step, before the next in event of the host is
  processed.
- Time events (§6) are processed like in events.
- Additionally a step without events is performed after entering the state machine, so that
  transitions without trigger (§5) can fire. **Deviation:** itemis CREATE only performs such steps
  with `@SuperSteps(yes)`.

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
3. Otherwise execute the enabled local reactions of `s` and return `false`.

A step starts with `react` for the active state of the top-level region. Every state takes part in
at most one transition per step: states entered during the step are not processed again in the
same step.

## 5. Transitions and reactions

A reaction (transition or local reaction) is **enabled** if

- one of its triggers matches: an event trigger whose event is present, a time trigger whose timer
  expired (§6), `always` / `oncycle` (always matches), or – **if the reaction has no trigger at
  all** – it matches in every step (like `always`);
- and its guard evaluates to `true` (no guard = `true`).

`entry` and `exit` reactions are not evaluated in steps; they are executed when the state is
entered / exited (their guards are evaluated at that time). `else` / `default` are only allowed on
transitions leaving a choice (§7).

**Taking a transition** from source `s` to target `t`:

1. Determine the **transition scope**: the innermost region containing both `s` and `t`
   (for a self transition or a transition from a state to its own sub state: the region
   containing `s`).
2. **Exit** the active state of that region below the scope: exit the innermost active states
   first (exit reactions, then cancel timers, then record history), up to the state in the scope.
3. Execute the effect of the transition.
4. **Enter** `t` (§8).

## 6. Time events

- `after n unit` starts a timer when the state owning the reaction is entered (for transitions:
  the source state) and fires once when it expires. `every n unit` fires periodically.
  Timers are cancelled when the state is exited. `n` is evaluated on entering the state.
- Units: `s`, `ms`, `us`, `ns`.
- The interpreter uses a **virtual clock** advanced by the host (`advanceTime(ms)`); expired timers
  are raised as time events (cycle based: present in the next cycle; event driven: each expired
  timer triggers a step, in expiry order).
- Generated code asks the host to start / stop timers through a timer service interface.

## 7. Pseudo states

- **Choice / junction** (treated identically): when a transition reaches a choice, its outgoing
  transitions are evaluated immediately in priority order; transitions with `else` / `default` or
  without guard are taken only if no guarded transition is enabled. The effects of the incoming and
  the outgoing transition are both executed (incoming first). If no transition is enabled, the
  runtime reports an error and the configuration is left inconsistent (validator warns about a
  missing `else`).
- **History** (`history`, `deephistory`): when a region is exited, its last active state is
  recorded. Entering a shallow history restores the recorded direct sub state (and enters it by
  default below); a deep history restores the recorded configuration recursively. Without recorded
  history the outgoing (default) transition of the history pseudo state is taken, otherwise the
  initial transition of the region.
- **Entry points** (`entry E` inside composite `C`): a transition to `C` with `# >E` enters `C`
  via `E` by taking the outgoing transition of `E`. Orthogonal regions of `C` not entered through
  the entry point are entered by default.
- **Exit nodes** (`exit X` inside composite `C`): when a transition reaches `X`, `C` is exited
  completely and the transition from `C` with `# X>` is taken (its guard must hold; otherwise
  the runtime reports an error).
- **Synchronization** (`sync`): a join fires when all incoming transitions are enabled in the same
  step (their source states are active and triggers / guards match); all sources are exited, the
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

Entering the state machine (`enter()`): initialize variables, then enter the top-level region by
default. `exit()` exits all active states (innermost first).
