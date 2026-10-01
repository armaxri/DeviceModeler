// The member functions declared in the class sections of controller.hsm, implemented by the application.
// The generated files (Controller.h, Controller.cpp) are not edited.
#include "Controller.h"
#include "driver.h"

namespace example {

void Controller::setConfig(const EpicProject::Config& value) {
    config = value;
}

void Controller::setDriver(EpicProject::Driver* value) {
    driver = value;
}

void Controller::setup() {
    if (driver != nullptr) {
        driver->powerOn();
    }
}

void Controller::shutdown() {
    if (driver != nullptr) {
        driver->powerOff();
    }
}

}  // namespace example
