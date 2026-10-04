// The hardware driver of the application, imported by the model: the controller holds a reference to it (bound by
// the constructor) and only the C++ code of the application uses it.
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
