// Uses the generated class Controller with the member functions of ControllerMethods.cpp:
//   hsm generate cpp controller.hsm -o gen
//   g++ -std=c++17 -I. -Igen main.cpp ControllerMethods.cpp gen/Controller.cpp -o controller
#include <cstdio>
#include "Controller.h"
#include "driver.h"

int main() {
    EpicProject::Driver driver;
    EpicProject::Config config;
    config.maxErrors = 2;

    example::Controller controller;
    controller.setDriver(&driver);
    controller.setConfig(config);
    controller.enter();
    controller.raise_start();
    controller.runCycle();    // power on
    controller.raise_failure();
    controller.runCycle();    // restart: power off, power on
    controller.raise_failure();
    controller.runCycle();    // second failure: power off, gives up
    std::printf("gave up: %s\n", controller.isRaised_gaveUp() ? "yes" : "no");
    controller.exit();
    return 0;
}
