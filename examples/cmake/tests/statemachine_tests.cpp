// Drives the generated TrafficLight and CdPlayer classes with a virtual clock and checks their
// behavior (a plain C++ test without framework; registered with CTest).
#include <cstdio>
#include <vector>

#include "CdPlayer.hpp"
#include "TrafficLight.h"

using example::TrafficLight;
using example::player::CdPlayer;

static int failures = 0;

#define CHECK(condition)                                                          \
    do {                                                                          \
        if (!(condition)) {                                                       \
            std::fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #condition); \
            failures++;                                                           \
        }                                                                         \
    } while (false)

// Timer service with a virtual clock (nanoseconds).
class VirtualTimerService : public sc::TimerServiceInterface {
public:
    void setTimer(sc::TimedInterface* machine, sc::eventid event, sc::integer durationNs, bool periodic) override {
        unsetTimer(machine, event);
        timers.push_back(Timer{machine, event, now + durationNs, durationNs, periodic});
    }

    void unsetTimer(sc::TimedInterface* machine, sc::eventid event) override {
        for (auto it = timers.begin(); it != timers.end(); ++it) {
            if (it->machine == machine && it->event == event) {
                timers.erase(it);
                return;
            }
        }
    }

    // Advances the clock and raises the time events of the expired timers.
    void advance(sc::integer ns) {
        now += ns;
        std::vector<Timer> expired;
        for (auto it = timers.begin(); it != timers.end();) {
            if (it->due > now) {
                ++it;
                continue;
            }
            expired.push_back(*it);
            if (it->periodic) {
                it->due += it->period;
                ++it;
            } else {
                it = timers.erase(it);
            }
        }
        for (const Timer& timer : expired) {
            timer.machine->raiseTimeEvent(timer.event);
        }
    }

private:
    struct Timer {
        sc::TimedInterface* machine;
        sc::eventid event;
        sc::integer due;
        sc::integer period;
        bool periodic;
    };
    sc::integer now = 0;
    std::vector<Timer> timers;
};

class RecordingLamps : public TrafficLight::InternalOperationCallback {
public:
    void switchOn(sc::integer mask) override {
        calls.push_back(mask);
    }
    std::vector<sc::integer> calls;
};

// Runs the traffic light for the given time in cycles of cyclePeriodMs.
static void run(TrafficLight& light, VirtualTimerService& timers, sc::integer ms) {
    for (sc::integer t = 0; t < ms; t += TrafficLight::cyclePeriodMs) {
        timers.advance(TrafficLight::cyclePeriodMs * 1000000);
        light.runCycle();
    }
}

static void trafficLightCyclesThroughThePhases() {
    TrafficLight light;
    VirtualTimerService timers;
    RecordingLamps lamps;
    light.setTimerService(&timers);
    light.setInternalOperationCallback(&lamps);

    light.enter();
    CHECK(light.isStateActive(TrafficLight::State::Off));
    light.raise_powerOn();
    light.runCycle();
    CHECK(light.isStateActive(TrafficLight::State::Operating_Red));
    CHECK(light.isRaised_lightsChanged() && light.get_lightsChanged_value() == 1);
    CHECK(!lamps.calls.empty() && lamps.calls.back() == 1);

    run(light, timers, 20000);
    CHECK(light.isStateActive(TrafficLight::State::Operating_RedYellow));
    run(light, timers, 2000);
    CHECK(light.isStateActive(TrafficLight::State::Operating_Green));
    light.getPedestrian().raise_request();
    light.runCycle();
    CHECK(light.getPedestrian().get_waiting());
    run(light, timers, 30000);
    CHECK(light.isStateActive(TrafficLight::State::Operating_Yellow));
    run(light, timers, 3000);
    CHECK(light.isStateActive(TrafficLight::State::Operating_Red));
    CHECK(!light.getPedestrian().get_waiting());

    light.raise_failure();
    light.runCycle();
    CHECK(light.isStateActive(TrafficLight::State::Blinking));
    light.raise_powerOff();
    light.runCycle();
    CHECK(light.isStateActive(TrafficLight::State::Off));
    CHECK(lamps.calls.back() == 0);
}

class Drive : public CdPlayer::OperationCallback {
public:
    sc::boolean discInserted() override { return disc; }
    void startMotor() override { running = true; }
    void stopMotor() override { running = false; }
    bool disc = true;
    bool running = false;
};

static void cdPlayerResumesAfterClosingTheLid() {
    CdPlayer player;
    Drive drive;
    player.setOperationCallback(&drive);
    player.enter(); // initializes the variables
    player.set_tracks(3);
    CHECK(player.isStateActive(CdPlayer::State::Closed_Stopped));

    player.raise_play();
    player.runCycle();
    CHECK(player.isStateActive(CdPlayer::State::Closed_Active_Playing));
    CHECK(drive.running);
    player.raise_trackEnd();
    player.runCycle();
    CHECK(player.get_track() == 2);

    player.raise_eject();
    player.runCycle();
    CHECK(player.isStateActive(CdPlayer::State::Open));
    CHECK(!drive.running);
    player.raise_eject();
    player.runCycle();
    CHECK(player.isStateActive(CdPlayer::State::Closed_Active_Playing)); // history
    CHECK(player.get_track() == 2);

    player.raise_powerOff();
    player.runCycle();
    CHECK(player.isFinal());
}

int main() {
    trafficLightCyclesThroughThePhases();
    cdPlayerResumesAfterClosingTheLid();
    if (failures > 0) {
        std::fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("all checks passed\n");
    return 0;
}
