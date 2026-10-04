/**
 * @file sensor_codes.h
 * The codes of a temperature sensor (examples/cpp-enum-values/sensor.devm imports this header). The
 * enums show how C and C++ number enumerators; hover an enumerator in the model to see its value as
 * the compiler computes it, completion lists the values too (docs/cpp-integration.md §3.5).
 */
#ifndef SENSOR_CODES_H
#define SENSOR_CODES_H

#include <cstdint>

#define SENSOR_BIT(n) (1u << (n))
#define SENSOR_VENDOR_BASE 0x80

namespace sensor {

/// Implicit numbering: the first enumerator is 0, every other one the previous value + 1.
enum class State : std::uint8_t {
    Off,               ///< 0: the first enumerator
    Booting,           ///< 1
    Ready,             ///< 2
    Measuring = 10,    ///< an explicit value
    Calibrating,       ///< 11: previous + 1, also after an explicit value
    Error = 0xF0,      ///< 240
    Fatal              ///< 241
};

/// Status flags: values computed from macros and from earlier enumerators.
enum Status : std::uint16_t {
    kNone = 0,
    kPowered = SENSOR_BIT(0),             ///< 1
    kCalibrated = SENSOR_BIT(1),          ///< 2
    kOverTemperature = SENSOR_BIT(4),     ///< 16 (0x10)
    kReady = kPowered | kCalibrated,      ///< 3: combined flags
    kVendor = SENSOR_VENDOR_BASE << 4,    ///< 2048 (0x800)
    kAll = 0xFFFF                         ///< 65535: the largest value of the underlying type
};

/// Commands of the serial protocol: character literals are the character codes.
enum class Command : char {
    Start = 'S',      ///< 83
    Stop = 'X',       ///< 88
    Query = '?',      ///< 63
    Newline = '\n'    ///< 10 (escape sequence)
};

/// Levels: negative values, octal literals and arithmetic with character literals.
enum Level : std::int8_t {
    kMinLevel = -3,          ///< -3
    kLow,                    ///< -2
    kNormal,                 ///< -1
    kZero,                   ///< 0
    kOctal = 010,            ///< 8, not 10: a leading 0 means octal
    kMaxLevel = 'z' - 'a'    ///< 25
};

}  // namespace sensor

/// C style result codes (an unscoped enum of the global namespace).
typedef enum {
    SENSOR_OK,                          ///< 0
    SENSOR_TIMEOUT = -110,              ///< -110
    SENSOR_BUSY,                        ///< -109
    SENSOR_LAST_ERROR = SENSOR_BUSY,    ///< -109: same value as SENSOR_BUSY
    SENSOR_RESULT_COUNT = 3
} sensor_result_t;

#endif  // SENSOR_CODES_H
