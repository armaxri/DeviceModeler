/**
 * @file motor_types.h
 * Types shared by the motor controller firmware and its state machines.
 */
#ifndef MOTOR_TYPES_H
#define MOTOR_TYPES_H

#include <cstdint>
#include <string>
#include <array>
#include "platform/compiler.h"

#define MOTOR_BIT(n) (1u << (n))
#define MOTOR_MAX_AXES 3

namespace motor {

/// Operating mode of the motor.
enum class Mode : std::uint8_t {
    Off = 0,    ///< motor is switched off
    Slow,       ///< reduced speed
    Fast = 10,  ///< full speed
    Boost,      ///< temporary overdrive
};

/** Error flags (can be combined). */
enum ErrorFlags : std::uint16_t {
    kNoError = 0,
    kOverCurrent = MOTOR_BIT(0),
    kOverTemperature = MOTOR_BIT(1),
    kStall = MOTOR_BIT(2),
    kAnyError = kOverCurrent | kOverTemperature | kStall,
};

enum Direction { Forward = 'F', Backward = 'B' };

/// Rotational speed in rpm.
using Rpm = std::int32_t;
typedef float Celsius;

/// Maximum speed of the motor.
constexpr Rpm kMaxSpeed = 6'000;
constexpr Rpm kMinSpeed = -kMaxSpeed;
constexpr Celsius kMaxTemperature = 85.5f;
constexpr double kGearRatio = 1.0 / 3.0;
constexpr bool kHasEncoder = true;
constexpr const char* kName = "motor";
constexpr char kVendor[] = "ACME";
inline const std::string kVersion = "1.2.3";
constexpr std::size_t kAxes = MOTOR_MAX_AXES;
constexpr Mode kDefaultMode = Mode::Slow;
constexpr std::uint32_t kAllOnes = ~0u;
constexpr std::uint8_t kMask = 0xF0 >> 4;

/// A position in millimeters.
struct Position {
    std::int32_t x = 0;   ///< x coordinate
    std::int32_t y = 0;   ///< y coordinate
    std::int32_t z{};     ///< z coordinate
};

struct Limits {
    Rpm maxSpeed = kMaxSpeed;
    Celsius maxTemperature = kMaxTemperature;
    Position home{1, 2, 3};
    Mode startMode = Mode::Off;
    std::array<std::uint8_t, kAxes> gains{};
    std::uint16_t calibration[2] = {10, 20};
    bool enabled : 1;
    std::uint8_t reserved : 7;

    static constexpr int kVersion = 2;

    /// Methods are ignored.
    bool isValid() const noexcept { return maxSpeed > 0; }
};

constexpr Position kOrigin{};
constexpr Position kParkPosition{.x = 100, .y = -50};

namespace detail {
constexpr int kInternal = 42;
}

}  // namespace motor

#endif  // MOTOR_TYPES_H
