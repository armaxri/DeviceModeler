[← All state machines](index.md)

# TrafficLight

Traffic light with a pedestrian request button. The lights are switched
by the host through the internal operation `switchOn`.

Source: [`examples/traffic-light.hsm`](../../examples/traffic-light.hsm)

![TrafficLight diagram](TrafficLight.svg)

## Execution

| Property | Value |
| --- | --- |
| Execution | cycle based, period `100 ms` |
| Order | parent first (parent states react before their sub states) |
| Annotations | `@CycleBased(100)` |

## Interfaces

### Interface

**Events**

| Event | Direction | Type | Description |
| --- | --- | --- | --- |
| `powerOn` | in |   |   |
| `powerOff` | in |   |   |
| `failure` | in |   |   |
| `reset` | in |   |   |
| `lightsChanged` | out | `integer` | Raised with the bit mask of the lights when the light turns red. |

### Interface `Pedestrian`

Push button of the pedestrian crossing.

**Events**

| Event | Direction | Type | Description |
| --- | --- | --- | --- |
| `request` | in |   |   |

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `waiting` | var | `boolean` | `false` | A pedestrian has pressed the button and waits for red. |

### Internal scope

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `RED` | const | `integer` | `1` |   |
| `YELLOW` | const | `integer` | `2` |   |
| `GREEN` | const | `integer` | `4` |   |
| `lights` | var | `integer` | `0` | Bit mask of the lights that are on (`RED`, `YELLOW`, `GREEN`). |

**Operations**

| Operation | Return type | Description |
| --- | --- | --- |
| `switchOn(mask : integer)` | `void` | Switches the lamps of the mask on and all others off. |

## States

| State | Kind | Description | Entry | Exit | Local reactions | Sub states |
| --- | --- | --- | --- | --- | --- | --- |
| `Off` | state |   | `lights = 0; switchOn(0)` |   |   |   |
| `Operating` | composite state |   |   |   |   | Red<br>RedYellow<br>Green<br>Yellow |
| `Operating.Red` | state |   | `lights = RED; switchOn(lights); raise lightsChanged : lights` |   |   |   |
| `Operating.RedYellow` | state |   | `lights = RED \| YELLOW; switchOn(lights)` |   |   |   |
| `Operating.Green` | state |   | `lights = GREEN; switchOn(lights)` |   | `Pedestrian.request / Pedestrian.waiting = true` |   |
| `Operating.Yellow` | state |   | `lights = YELLOW; switchOn(lights)` |   |   |   |
| `Blinking` | state | Failure mode: the yellow light blinks. |   |   | `every 500 ms / lights = lights ^ YELLOW; switchOn(lights)` |   |

## Transitions

| Source | Target | Trigger | Guard | Effect | Priority | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `[*]` (initial, TrafficLight) | `Off` |   |   |   |   |   |
| `[*]` (initial, Operating) | `Operating.Red` |   |   |   |   |   |
| `Operating.Red` | `Operating.RedYellow` | `after 20 s` |   |   |   |   |
| `Operating.RedYellow` | `Operating.Green` | `after 2 s` |   |   |   |   |
| `Operating.Green` | `Operating.Yellow` | `after 30 s` | `Pedestrian.waiting` |   |   | Green lasts at least 30 s and only ends when a pedestrian is waiting. |
| `Operating.Yellow` | `Operating.Red` | `after 3 s` |   | `Pedestrian.waiting = false` |   |   |
| `Off` | `Operating` | `powerOn` |   |   |   |   |
| `Operating` | `Blinking` | `failure` |   |   | 1 |   |
| `Blinking` | `Operating` | `reset` |   |   | 1 |   |
| `Operating` | `Off` | `powerOff` |   |   | 2 |   |
| `Blinking` | `Off` | `powerOff` |   |   | 2 |   |
