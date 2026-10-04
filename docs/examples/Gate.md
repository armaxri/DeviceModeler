[← All state machines](index.md)

# Gate

Opens on request; the motor instance runs while the gate is moving.

Source: [`examples/door-with-motor/gate.hsm`](../../examples/door-with-motor/gate.hsm)

![Gate diagram](Gate.svg)

## Execution

| Property | Value |
| --- | --- |
| Execution | cycle based, period `200 ms` |
| Order | parent first (parent states react before their sub states) |

## Interfaces

### Interface

**Events**

| Event | Direction | Type | Description |
| --- | --- | --- | --- |
| `open` | in |   |   |
| `openFast` | in |   |   |
| `close` | in |   |   |
| `jam` | in |   |   |
| `alarm` | out |   |   |

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `faults` | var | `integer` | `0` |   |
| `lastSpeed` | var | `integer` | `0` |   |

### Internal scope

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `motor` | var | `state machine instance` | (default) |   |

## States

| State | Kind | Description | Entry | Exit | Local reactions | Sub states |
| --- | --- | --- | --- | --- | --- | --- |
| `Closed` | state |   |   |   |   |   |
| `Moving` | state | The motor instance runs while Moving is active. |   |   | `jam / raise motor.fault` |   |
| `Opened` | state |   |   |   |   |   |
| `Error` | state |   |   |   |   |   |

## Transitions

| Source | Target | Trigger | Guard | Effect | Priority | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `[*]` (initial, Gate) | `Closed` |   |   |   |   |   |
| `Closed` | `Moving` | `open` |   | `raise motor.start` | 1 |   |
| `Closed` | `Moving` via entry `Run` | `openFast` |   | `motor.maxSpeed = 1` | 2 |   |
| `Moving` | `Opened` |   | `active(motor.Running)` | `lastSpeed = motor.speed` | 1 |   |
| `Moving` | `Closed` | `close` |   |   | 2 |   |
| `Moving` via exit `Failed` | `Error` |   |   | `faults += 1; lastSpeed = valueof(motor.failed); raise alarm` | 3 |   |
| `Opened` | `Closed` | `close` |   |   |   |   |
| `Error` | `Closed` | `close` |   |   |   |   |
