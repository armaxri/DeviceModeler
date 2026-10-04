[← All state machines](index.md)

# Drive

Runs the motor with the requested speed and reports why it stopped.

Source: [`examples/device/drive.devm`](../../examples/device/drive.devm)

![Drive diagram](Drive.svg)

## Execution

| Property | Value |
| --- | --- |
| Execution | cycle based, period `10 ms` |
| Order | parent first (parent states react before their sub states) |
| Annotations | `@CycleBased(10)` |

## Interfaces

### Interface

**Events**

| Event | Direction | Type | Description |
| --- | --- | --- | --- |
| `up` | in | `integer` | Opens with the given speed in percent (port `up`). |
| `down` | in | `integer` | Closes with the given speed in percent (port `down`). |
| `halt` | in |   |   |
| `endSwitch` | in |   | An end switch was reached (port `endSwitch`). |
| `overcurrent` | in |   | The motor current exceeded the limit (port `overcurrent`). |
| `stopped` | out |   |   |
| `blocked` | out |   |   |

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `speed` | var | `integer` | `0` | The current speed in percent, negative while closing (port `speed`). |
| `duty` | var | `integer` | `0` | The duty cycle of the PWM output in percent (port `duty`). |

## States

| State | Kind | Description | Entry | Exit | Local reactions | Sub states |
| --- | --- | --- | --- | --- | --- | --- |
| `Idle` | state |   | `speed = 0; duty = 0` |   |   |   |
| `Running` | state |   | `duty = speed` |   |   |   |

## Transitions

| Source | Target | Trigger | Guard | Effect | Priority | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `[*]` (initial, Drive) | `Idle` |   |   |   |   |   |
| `Idle` | `Running` | `up` |   | `speed = valueof(up)` | 1 |   |
| `Idle` | `Running` | `down` |   | `speed = -valueof(down)` | 2 |   |
| `Running` | `Idle` | `halt` |   |   | 1 |   |
| `Running` | `Idle` | `endSwitch` |   | `raise stopped` | 2 |   |
| `Running` | `Idle` | `overcurrent` |   | `raise blocked` | 3 |   |
