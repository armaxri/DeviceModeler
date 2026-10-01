// The member functions declared in the class sections of controller.hsm, implemented by the application.
// The generated files (Controller.h, Controller.cpp) are not edited.
#include "Controller.h"
#include "driver.h"

namespace example {

void Controller::setConfig(const EpicProject::Config& value) {
    config = value;
}

bool Controller::retryAllowed() const {
    return errorCnt + 1 < config.maxErrors;
}

void Controller::setup() {
    driver.powerOn();
}

void Controller::shutdown() {
    shutdownErrors.push_back(errorCnt);
    driver.powerOff();
}

}  // namespace example
