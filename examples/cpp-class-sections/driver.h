// The hardware driver of the application (not imported by the model: the model only stores a pointer).
#ifndef EPIC_PROJECT_DRIVER_H
#define EPIC_PROJECT_DRIVER_H

#include <cstdio>

namespace EpicProject {

class Driver {
public:
    void powerOn() {
        std::printf("power on\n");
    }

    void powerOff() {
        std::printf("power off\n");
    }
};

}  // namespace EpicProject

#endif
