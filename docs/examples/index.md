# Example state machines

| State machine | Description | Source |
| --- | --- | --- |
| [CdPlayer](CdPlayer.md) | Hierarchical CD player<br>CD player with a history state: after closing the lid the player resumes the mode it was in before. | [`examples/cd-player.hsm`](../../examples/cd-player.hsm) |
| [Conveyor](Conveyor.md) | Belt conveyor using the types of a C++ header | [`examples/cpp-types/conveyor.hsm`](../../examples/cpp-types/conveyor.hsm) |
| [Door](Door.md) | Automatic door with obstacle detection and a service mode. | [`examples/door.hsm`](../../examples/door.hsm) |
| [Gate](Gate.md) | Opens on request; the motor instance runs while the gate is moving. | [`examples/door-with-motor/gate.hsm`](../../examples/door-with-motor/gate.hsm) |
| [Keyboard](Keyboard.md) | LEDs of a keyboard; suspending the keyboard keeps the lock states. | [`examples/keyboard.hsm`](../../examples/keyboard.hsm) |
| [Motor](Motor.md) | Drives the gate: ramps up after being started and reports when it has stopped. | [`examples/door-with-motor/motor.hsm`](../../examples/door-with-motor/motor.hsm) |
| [TrafficLight](TrafficLight.md) | Traffic light with a pedestrian request button. The lights are switched by the host through the internal operation `switchOn`. | [`examples/traffic-light.hsm`](../../examples/traffic-light.hsm) |
