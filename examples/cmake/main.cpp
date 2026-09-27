// Host of the generated TrafficLight: a timer service based on std::chrono, the operation callback
// of the internal scope and an observer of the out event lightsChanged.
// Usage: traffic_light [seconds]   (default 60; a pedestrian presses the button after half the time)
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

#include "TrafficLight.h"

using example::TrafficLight;
using Clock = std::chrono::steady_clock;

// Timer service: the host checks the timers before every run cycle.
class TimerService : public sc::TimerServiceInterface {
public:
    void setTimer(sc::TimedInterface* machine, sc::eventid event, sc::integer durationNs, bool periodic) override {
        unsetTimer(machine, event);
        const std::chrono::nanoseconds period(durationNs);
        timers.push_back(Timer{machine, event, Clock::now() + period, period, periodic});
    }

    void unsetTimer(sc::TimedInterface* machine, sc::eventid event) override {
        timers.erase(std::remove_if(timers.begin(), timers.end(), [&](const Timer& timer) {
            return timer.machine == machine && timer.event == event;
        }), timers.end());
    }

    // Raises the time events of all expired timers.
    void raiseExpired() {
        const Clock::time_point now = Clock::now();
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
        Clock::time_point due;
        std::chrono::nanoseconds period;
        bool periodic;
    };
    std::vector<Timer> timers;
};

// Operation switchOn of the internal scope: would drive the lamps.
class Lamps : public TrafficLight::InternalOperationCallback {
public:
    void switchOn(sc::integer mask) override {
        std::printf("lamps:%s%s%s\n", (mask & 1) ? " red" : "", (mask & 2) ? " yellow" : "", (mask & 4) ? " green" : "");
    }
};

// Observer of the out event lightsChanged.
class LightsChanged : public sc::rx::Observer<sc::integer> {
public:
    void next(const sc::integer& lights) override {
        std::printf("lights changed: %d\n", static_cast<int>(lights));
    }
};

int main(int argc, char** argv) {
    const int seconds = argc > 1 ? std::atoi(argv[1]) : 60;
    const int cycles = seconds * 1000 / static_cast<int>(TrafficLight::cyclePeriodMs);

    TrafficLight light;
    TimerService timerService;
    Lamps lamps;
    LightsChanged lightsChanged;
    light.setTimerService(&timerService);
    light.setInternalOperationCallback(&lamps);
    light.getLightsChanged().subscribe(lightsChanged);

    try {
        light.enter();
        light.raise_powerOn();
        Clock::time_point next = Clock::now();
        for (int cycle = 0; cycle < cycles; cycle++) {
            next += std::chrono::milliseconds(TrafficLight::cyclePeriodMs);
            std::this_thread::sleep_until(next);
            timerService.raiseExpired();
            if (cycle == cycles / 2) {
                std::printf("pedestrian request\n");
                light.getPedestrian().raise_request();
            }
            light.runCycle();
        }
        light.exit();
    } catch (const sc::StatemachineError& error) {
        std::fprintf(stderr, "state machine error: %s\n", error.what());
        return 1;
    }
    return 0;
}
