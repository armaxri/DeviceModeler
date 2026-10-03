// Drives the generated Conveyor class (examples/cpp-types/conveyor.devm), whose API uses the types of
// the imported header conveyor_types.h directly: conveyor::Mode, conveyor::Package, conveyor::Speed.
#include <cstdio>
#include <vector>

#include "Conveyor.h"

using example::Conveyor;

static int failures = 0;

#define CHECK(condition)                                                          \
    do {                                                                          \
        if (!(condition)) {                                                       \
            std::fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
            failures++;                                                           \
        }                                                                         \
    } while (false)

// The belt drive: records the requested speeds.
class Drive : public Conveyor::OperationCallback {
public:
    std::vector<conveyor::Speed> speeds;

    void setSpeed(conveyor::Speed speed) override {
        speeds.push_back(speed);
    }
};

int main() {
    Conveyor belt;
    Drive drive;
    belt.setOperationCallback(&drive);
    belt.enter();
    CHECK(belt.get_mode() == conveyor::Mode::Stopped);

    belt.raise_start();
    belt.runCycle();
    CHECK(belt.get_mode() == conveyor::Mode::Normal);
    CHECK(!drive.speeds.empty() && drive.speeds.back() == conveyor::kDefaultSettings.normalSpeed);

    conveyor::Package fragile;
    fragile.id = 4711;
    fragile.weightGrams = 800;
    fragile.fragile = true;
    belt.raise_packageDetected(fragile);
    belt.runCycle();
    CHECK(belt.get_mode() == conveyor::Mode::Slow);
    CHECK(belt.get_last().id == 4711);
    CHECK(belt.get_count() == 1);

    conveyor::Package heavy;
    heavy.weightGrams = 30000;
    belt.raise_packageDetected(heavy);
    belt.runCycle();
    CHECK(!belt.isRaised_rejected());  // only in Running: the belt is still slow

    belt.raise_fault(conveyor::kEmergencyStop);
    belt.runCycle();
    CHECK(belt.get_mode() == conveyor::Mode::Stopped);
    CHECK((belt.get_faults() & conveyor::kEmergencyStop) != 0);

    if (failures > 0) {
        std::fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("conveyor: all checks passed\n");
    return 0;
}
