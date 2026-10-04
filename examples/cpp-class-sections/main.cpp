// Uses the generated class Controller with the member functions of ControllerMethods.cpp:
//   hsm generate cpp controller.hsm -o gen
//   g++ -std=c++17 -I. -Igen main.cpp ControllerMethods.cpp gen/Controller.cpp -o controller
#include <cstdio>
#include "Controller.h"
#include "driver.h"

// The member functions of the class sections are virtual: a subclass may override them.
class VerboseController : public example::Controller {
public:
    explicit VerboseController(EpicProject::Driver& driver_) : example::Controller(driver_) {}

    std::size_t shutdowns() const {
        return shutdownErrors.size();
    }

protected:
    void setup() override {
        std::printf("setup\n");
        example::Controller::setup();
    }
};

int main() {
    EpicProject::Driver driver;
    EpicProject::Config config;
    config.maxErrors = 2;

    VerboseController controller(driver);    // binds the reference member driver
    controller.setConfig(config);
    controller.enter();
    controller.raise_start();
    controller.runCycle();    // setup, power on
    controller.raise_failure();
    controller.runCycle();    // restart: power off, setup, power on
    controller.raise_failure();
    controller.runCycle();    // second failure: power off, gives up
    std::printf("gave up: %s, shutdowns: %d\n", controller.isRaised_gaveUp() ? "yes" : "no", static_cast<int>(controller.shutdowns()));
    controller.exit();
    return 0;
}
