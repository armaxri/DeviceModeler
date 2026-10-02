/**
 * @file door_types.h
 * Types shared by the structure model of the garage door (components.dmf) and its state machines
 * (controller.hsm).
 */
#ifndef DOOR_TYPES_H
#define DOOR_TYPES_H

#include <cstdint>

namespace door {

/// Position of the door leaf, measured by the encoder.
struct Position {
    std::int32_t mm = 0;    ///< opening in millimeters (0: closed)
    bool valid = false;     ///< the encoder is referenced
};

/// Opening of the fully open door in millimeters.
constexpr std::int32_t kOpenMm = 2000;

}  // namespace door

#endif
