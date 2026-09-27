#pragma once

#include "motor_types.h"

#include <functional>
#include <vector>

// Everything the analyzer must skip robustly lives next to the declarations it extracts.

namespace app::control {

namespace m = motor;

/// Controller configuration.
struct [[nodiscard]] Config final {
    m::Mode mode = m::kDefaultMode;
    motor::Rpm targetSpeed = motor::kMaxSpeed / 2;
    motor::Position target = motor::kParkPosition;
    std::uint8_t retries = 3;

    enum class State { Idle, Running, Error = -1 };
    State initialState = State::Idle;

    struct Timing {
        std::uint32_t periodMs = 10;
        std::uint32_t timeoutMs = periodMs * 100;
    } timing;
};

class Controller {
public:
    explicit Controller(const Config& config) : config_(config), speed_{0} {}
    virtual ~Controller() = default;

    Controller(const Controller&) = delete;
    Controller& operator=(const Controller&) = delete;
    bool operator==(const Controller& other) const { return speed_ == other.speed_; }
    explicit operator bool() const { return speed_ != 0; }

    template <typename F>
    void forEach(F&& f) {
        for (auto& callback : callbacks_) {
            f(callback);
        }
    }

    static constexpr std::uint32_t kQueueSize = 16;

    virtual void step(std::uint32_t nowMs) = 0;
    [[nodiscard]] motor::Rpm speed() const { return speed_; }

protected:
    void notify() {
        auto lambda = [this](int x) { return x + speed_; };
        (void)lambda(1);
    }

private:
    Config config_;
    motor::Rpm speed_;
    std::vector<std::function<void(int)>> callbacks_;
};

template <typename T, std::size_t N = 4>
struct RingBuffer {
    std::array<T, N> data{};
    std::size_t head = 0;
};

template <>
struct RingBuffer<int, 1> {
    int value;
};

using IntBuffer = RingBuffer<int, 8>;

inline int clamp(int value, int low, int high) {
    return value < low ? low : (value > high ? high : value);
}

constexpr int square(int x) { return x * x; }

static_assert(sizeof(Config) > 0, "config must not be empty");

extern "C" {
typedef enum { LED_OFF, LED_ON, LED_BLINK = 5 } led_state_t;
typedef struct led_config { led_state_t state; unsigned int period_ms; } led_config_t;
void led_set(led_state_t state);
}

inline namespace v2 {
enum class Protocol : unsigned char { CanOpen = 1, Modbus = 2 };
}

namespace {
constexpr int kHidden = 7;
}

constexpr auto kDefaultProtocol = Protocol::Modbus;
constexpr int kDerived = kHidden * 6;
constexpr int kNotConstant = square(3);  // function calls cannot be evaluated

}  // namespace app::control
