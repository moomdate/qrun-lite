// QRun Lite settings. Edit these, then build and flash again.
#pragma once
#include <stdint.h>

namespace cfg {

// Price of one run, in satang (2000 = ฿20). Stripe's minimum for THB is ฿10 (1000).
// MUST be the same number as PRICE_SATANG in worker/wrangler.jsonc: the Worker refuses any other amount.
static constexpr uint32_t PRICE_SATANG = 2000;

// How long the relay stays on after a payment, in seconds.
static constexpr uint32_t RUN_SECONDS = 60;

// Relay (or SSR / MOSFET driver) input. GPIO 22 is free on the CYD's CN1/P3 connector.
// Set RELAY_ACTIVE_HIGH to false for low-trigger relay boards.
static constexpr int  RELAY_PIN         = 22;
static constexpr bool RELAY_ACTIVE_HIGH = true;

static_assert(PRICE_SATANG >= 1000, "Stripe's minimum for THB is 1000 satang (10 baht)");
static_assert(PRICE_SATANG <= 15000000, "PromptPay maximum is 150,000 baht");
static_assert(RUN_SECONDS >= 1 && RUN_SECONDS <= 3600, "RUN_SECONDS must be 1..3600");

}  // namespace cfg
