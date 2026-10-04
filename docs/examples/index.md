# Example state machines

| State machine | Description | Source |
| --- | --- | --- |
| [CdPlayer](CdPlayer.md) | Hierarchical CD player<br>CD player with a history state: after closing the lid the player<br>resumes the mode it was in before. | [`examples/cd-player.devm`](../../examples/cd-player.devm) |
| [Controller](Controller.md) | Restarts a device after failures | [`examples/cpp-class-sections/restart-controller.devm`](../../examples/cpp-class-sections/restart-controller.devm) |
| [Conveyor](Conveyor.md) | Belt conveyor using the types of a C++ header | [`examples/cpp-types/conveyor.devm`](../../examples/cpp-types/conveyor.devm) |
| [Door](Door.md) | Automatic door with obstacle detection and a service mode. | [`examples/door.devm`](../../examples/door.devm) |
| [DoorController](DoorController.md) | Opens and closes the door on request and stops at obstacles. | [`examples/device/controller.devm`](../../examples/device/controller.devm) |
| [Drive](Drive.md) | Runs the motor with the requested speed and reports why it stopped. | [`examples/device/drive.devm`](../../examples/device/drive.devm) |
| [Gate](Gate.md) | Opens on request; the motor instance runs while the gate is moving. | [`examples/door-with-motor/gate.devm`](../../examples/door-with-motor/gate.devm) |
| [Keyboard](Keyboard.md) | LEDs of a keyboard; suspending the keyboard keeps the lock states. | [`examples/keyboard.devm`](../../examples/keyboard.devm) |
| [Motor](Motor.md) | Drives the gate: ramps up after being started and reports when it has stopped. | [`examples/door-with-motor/motor.devm`](../../examples/door-with-motor/motor.devm) |
| [Sensor](Sensor.md) | Temperature sensor using the enum values of a C++ header | [`examples/cpp-enum-values/sensor.devm`](../../examples/cpp-enum-values/sensor.devm) |
| [TrafficLight](TrafficLight.md) | Traffic light with a pedestrian request button. The lights are switched<br>by the host through the internal operation `switchOn`. | [`examples/traffic-light.devm`](../../examples/traffic-light.devm) |
