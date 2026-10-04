[← All state machines](index.md)

# Motor

Drives the gate: ramps up after being started and reports when it has stopped.

Source: [`examples/door-with-motor/motor.devm`](../../examples/door-with-motor/motor.devm)

![Motor diagram](Motor.svg)

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
| `start` | in |   |   |
| `stop` | in |   |   |
| `fault` | in |   |   |
| `stopped` | out |   |   |
| `failed` | out | `integer` |   |

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `speed` | var | `integer` | `0` |   |
| `maxSpeed` | var | `integer` | `3` |   |

**Operations**

| Operation | Return type | Description |
| --- | --- | --- |
| `setPwm(duty : integer)` | `void` |   |

## States

| State | Kind | Description | Entry | Exit | Local reactions | Sub states |
| --- | --- | --- | --- | --- | --- | --- |
| `Run` | entry point |   |   |   |   |   |
| `Failed` | exit node |   |   |   |   |   |
| `Off` | state |   | `speed = 0; setPwm(0)` |   |   |   |
| `Ramping` | state |   |   |   | `every 100 ms / speed += 1; setPwm(speed * 10)` |   |
| `Running` | state |   |   |   |   |   |

## Transitions

| Source | Target | Trigger | Guard | Effect | Priority | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `[*]` (initial, Motor) | `Off` |   |   |   |   |   |
| `Run` | `Ramping` |   |   |   |   |   |
| `Off` | `Ramping` | `start` |   |   |   |   |
| `Ramping` | `Running` |   | `speed >= maxSpeed` |   | 1 |   |
| `Ramping` | `Off` | `stop` |   | `raise stopped` | 2 |   |
| `Running` | `Off` | `stop` |   | `raise stopped` |   |   |
| `Ramping` | `Failed` | `fault` |   | `raise failed : speed` | 3 |   |
