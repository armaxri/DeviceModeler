// The forms of enum declarations supported by the header analyzer (test/cpp-enums.test.ts).
#pragma once
#include <cstdint>

#define FLAG_BASE 0x10

/// Colors of the status LED (unscoped: the enumerators are also members of the global namespace).
enum Color { Red, Green = 2, Blue, /**< blue light */ };

/// Scoped enum with the default underlying type int.
enum class Mode { Off, On };

/// `enum struct` with a fixed underlying type and character literals.
enum struct Key : std::uint8_t { Enter = '\n', Space = ' ', A = 'a' };

/// Unscoped enum with a fixed underlying type and values computed from earlier enumerators and macros.
enum Flags : int {
    kNone = 0,
    kLow = -5,             ///< negative
    kNext,                 ///< kLow + 1
    kHex = 0xFF,
    kExpr = kHex << 1 | 1,
    kMacro = FLAG_BASE,
};

/// C style: anonymous enum named by a typedef.
typedef enum { LED_OFF = 1, LED_ON } led_state_t;

/// C style: tagged enum with a typedef.
typedef enum motor_dir_tag { DIR_LEFT, DIR_RIGHT } motor_dir_t;

namespace app::io {
/// Nested namespace (C++17 `namespace a::b`).
enum class Level : std::int8_t { Low = -1, Mid = 0, High = 1 };
}

namespace app {
struct Sensor {
    /// Unscoped enum in a class.
    enum State { Idle, Busy };
    /// Scoped enum in a class.
    enum class Kind : std::uint16_t { Temperature = 100, Pressure };
    /// Opaque declaration, defined out of line below.
    enum class Unit : std::uint8_t;
    int id;
};
enum class Sensor::Unit : std::uint8_t { Celsius, Bar };

/// Opaque declaration without definition: the type is known, its enumerators are not.
enum class Handle : std::uint32_t;

/// Opaque declaration followed by the definition.
enum class Phase : int;
enum class Phase : int { Init, Run };

/// C++20 `using enum`: the enumerators of Color are members of app.
using enum ::Color;
}

enum class [[nodiscard]] Attributed {
    First [[deprecated("use Second")]],
#if FLAG_BASE > 8
    Second = 3,
#else
    Wrong,
#endif
    Third,  // trailing comma follows
};

/// Values referring to other enums.
enum class Derived : long { Value = static_cast<long>(Mode::On) + Blue };
