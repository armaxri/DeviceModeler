[← All state machines](index.md)

# Controller

> Restarts a device after failures

Source: [`examples/cpp-class-sections/controller.hsm`](../../examples/cpp-class-sections/controller.hsm)

![Controller diagram](Controller.svg)

## Execution

| Property | Value |
| --- | --- |
| Execution | cycle based, period `200 ms` |
| Order | parent first (parent states react before their sub states) |
| Namespace | `example` |

## Interfaces

### Interface

**Events**

| Event | Direction | Type | Description |
| --- | --- | --- | --- |
| `start` | in |   |   |
| `failure` | in |   |   |
| `stop` | in |   |   |
| `gaveUp` | out |   |   |

### C++ class section `public:`

**Operations**

| Operation | Return type | Description |
| --- | --- | --- |
| `setConfig(config : const EpicProject::Config&)` | `void` | Config setter. |
| `const retryAllowed()` | `bool` | Whether the device may be restarted after a failure. |

### C++ class section `protected:`

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `shutdownErrors` | var | `std::vector<unsigned int>` | (default) | The number of failures at each shutdown (only used by the C++ code). |

**Operations**

| Operation | Return type | Description |
| --- | --- | --- |
| `setup()` | `void` | Setup function: switches the device on. |
| `shutdown()` | `void` | Switches the device off. |

### C++ class section `private:`

**Variables and constants**

| Name | Kind | Type | Initial value | Description |
| --- | --- | --- | --- | --- |
| `errorCnt` | var | `unsigned int` | `0` | Number of failures since the last start. |
| `config` | var | `EpicProject::Config` | (default) | The configuration (setConfig). |
| `driver` | var | `EpicProject::Driver&` | (default) | The hardware driver (bound by the constructor), only used by the C++ code. |

## States

| State | Kind | Description | Entry | Exit | Local reactions | Sub states |
| --- | --- | --- | --- | --- | --- | --- |
| `Off` | state |   |   |   |   |   |
| `Running` | state |   | `setup()` | `shutdown()` |   |   |

## Transitions

| Source | Target | Trigger | Guard | Effect | Priority | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `[*]` (initial, Controller) | `Off` |   |   |   |   |   |
| `Off` | `Running` | `start` |   | `errorCnt = 0` |   |   |
| `Running` | `Running` | `failure` | `retryAllowed()` | `errorCnt++` | 1 |   |
| `Running` | `Off` | `failure` |   | `errorCnt++; raise gaveUp` | 2 |   |
| `Running` | `Off` | `stop` |   |   | 3 |   |
