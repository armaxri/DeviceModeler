/**
 * @file conveyor_types.h
 * Types and constants of a conveyor belt controller, shared by the firmware and its state machine
 * (examples/cpp-types/conveyor.devm imports this header).
 */
#ifndef CONVEYOR_TYPES_H
#define CONVEYOR_TYPES_H

#include <array>
#include <cstdint>

/// Status LED of the belt (a C style enum, shared with the C parts of the firmware).
typedef enum {
    LED_OFF,       ///< the belt is stopped
    LED_GREEN,     ///< the belt is running
    LED_BLINKING,  ///< a jam is being cleared
    LED_RED        ///< fault, a reset is needed
} conveyor_led_t;

namespace conveyor {

/// Operating mode of the belt drive.
enum class Mode : std::uint8_t {
    Stopped,  ///< the drive is off
    Slow,     ///< creeping speed for fragile packages
    Normal,   ///< production speed
    Reverse   ///< running backwards to clear a jam
};

/// Faults reported by the drive (flags, can be combined).
enum Fault : std::uint16_t {
    kNoFault = 0,
    kOverload = 1u << 0,        ///< motor current too high
    kJam = 1u << 1,             ///< a package is stuck
    kEmergencyStop = 1u << 2    ///< the emergency stop was pressed
};

/// Belt speed in mm/s (negative: backwards).
using Speed = std::int16_t;

/// A package detected by the light barrier at the entry of the belt.
struct Package {
    std::uint32_t id = 0;              ///< bar code
    std::uint16_t weightGrams = 0;     ///< measured by the scale
    bool fragile = false;              ///< transported at creeping speed
};

/// Settings of the belt.
struct Settings {
    Speed slowSpeed = 50;
    Speed normalSpeed = 400;
    std::uint16_t maxWeightGrams = 20000;   ///< heavier packages are rejected
    std::array<std::uint8_t, 3> zoneSensors{};
};

/// The settings used after a reset.
constexpr Settings kDefaultSettings{};

/// The number of packages after which the belt needs maintenance.
constexpr std::uint16_t kMaintenanceInterval = 1000;

/// Speed while clearing a jam.
constexpr Speed kReverseSpeed = -100;

}  // namespace conveyor

#endif  // CONVEYOR_TYPES_H
