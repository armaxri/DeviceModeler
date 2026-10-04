// Types of the application used by restart-controller.devm.
#ifndef EPIC_PROJECT_CONFIG_H
#define EPIC_PROJECT_CONFIG_H

#include <cstdint>

namespace EpicProject {

/// Configuration of the controller.
struct Config {
    /// Number of failures after which the controller gives up.
    std::uint32_t maxErrors = 3;
};

/// The hardware driver (defined in driver.h); the controller holds a reference to it.
class Driver;

}  // namespace EpicProject

#endif
