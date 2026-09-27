[← All state machines](index.md)

# Keyboard

LEDs of a keyboard; suspending the keyboard keeps the lock states.

Source: [`examples/keyboard.hsm`](../../examples/keyboard.hsm)

![Keyboard diagram](Keyboard.svg)

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
| `capsLock` | in |   |   |
| `numLock` | in |   |   |
| `suspend` | in |   |   |
| `wakeUp` | in |   |   |
| `unplug` | in |   |   |
| `led` | out | `integer` |   |

**Operations**

| Operation | Return type | Description |
| --- | --- | --- |
| `setLed(led : integer, on : boolean)` | `void` | Switches the LED `led` (`CAPS` or `NUM`) on or off. |

### Internal scope

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `CAPS` | const | `integer` | `1` |   |
| `NUM` | const | `integer` | `2` |   |

## States

| State | Kind | Description | Entry | Exit | Local reactions | Sub states |
| --- | --- | --- | --- | --- | --- | --- |
| `Active` | orthogonal state |   |   |   |   | CapsLock: CapsOff, CapsOn<br>NumLock: NumOff, NumOn |
| `Active.CapsOff` | state |   |   |   |   |   |
| `Active.CapsOn` | state |   | `setLed(CAPS, true); raise led : CAPS` | `setLed(CAPS, false)` |   |   |
| `Active.NumOff` | state |   |   |   |   |   |
| `Active.NumOn` | state |   | `setLed(NUM, true)` | `setLed(NUM, false)` |   |   |
| `Suspended` | state | The keyboard is suspended: the LED states are kept. |   |   |   |   |

## Transitions

| Source | Target | Trigger | Guard | Effect | Priority | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `[*]` (initial, Keyboard) | `Active` |   |   |   |   |   |
| `[*]` (initial, Active (region CapsLock)) | `Active.CapsOff` |   |   |   |   |   |
| `Active.CapsOff` | `Active.CapsOn` | `capsLock` |   |   |   |   |
| `Active.CapsOn` | `Active.CapsOff` | `capsLock` |   |   |   |   |
| `[*]` (initial, Active (region NumLock)) | `Active.NumOff` |   |   |   |   |   |
| `Active.NumOff` | `Active.NumOn` | `numLock` |   |   |   |   |
| `Active.NumOn` | `Active.NumOff` | `numLock` |   |   |   |   |
| `Active` | `Suspended` | `suspend` |   |   | 1 |   |
| `Suspended` | `Active` | `wakeUp` |   |   |   |   |
| `Active` | `[*]` (final, Keyboard) | `unplug` |   |   | 2 |   |
