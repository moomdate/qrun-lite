// Host tests for include/logic.h: `pio test -e native` (no board, no secrets.h).
#include <string>
#include <unity.h>
#include "config.h"
#include "logic.h"

using namespace lite;

void setUp() {}
void tearDown() {}

static State at(Screen s, const char* ref = "", const char* pi = "", const char* last = "") { return State{s, ref, pi, last}; }

void test_payment_is_shown_only_when_ours() {
  TEST_ASSERT_EQUAL(SHOW_QR, onPayment(at(CREATING, "r1"), "pi_1", "r1", "QR"));
  TEST_ASSERT_EQUAL(IGNORE, onPayment(at(CREATING, "r1"), "pi_1", "r0", "QR"));      // answer to an older create
  TEST_ASSERT_EQUAL(SHOW_QR, onPayment(at(QR, "r1", "pi_1"), "pi_1", "r1", "QR"));   // re-sent after reconnect
  TEST_ASSERT_EQUAL(IGNORE, onPayment(at(QR, "r1", "pi_1"), "pi_2", "r2", "QR"));
  TEST_ASSERT_EQUAL(DISCARD_QR, onPayment(at(IDLE), "pi_1", "r1", "QR"));            // pending after a reboot: cancel, don't pop up
  TEST_ASSERT_EQUAL(IGNORE, onPayment(at(RUNNING), "pi_1", "r1", "QR"));
  TEST_ASSERT_EQUAL(IGNORE, onPayment(at(MESSAGE), "pi_1", "r1", "QR"));
  TEST_ASSERT_EQUAL(IGNORE, onPayment(at(CREATING, "r1"), "", "r1", "QR"));
  TEST_ASSERT_EQUAL(IGNORE, onPayment(at(CREATING, "r1"), "pi_1", "r1", ""));
}

void test_payment_too_big_is_rejected() {
  std::string longPi(PI_MAX + 1, 'p'), longQr(QR_MAX + 1, 'q');
  TEST_ASSERT_EQUAL(REJECT_QR, onPayment(at(CREATING, "r1"), longPi.c_str(), "r1", "QR"));
  TEST_ASSERT_EQUAL(REJECT_QR, onPayment(at(CREATING, "r1"), "pi_1", "r1", longQr.c_str()));
  TEST_ASSERT_EQUAL(SHOW_QR, onPayment(at(CREATING, "r1"), "pi_1", "r1", longQr.substr(1).c_str()));
}

void test_paid_always_runs_once() {
  TEST_ASSERT_EQUAL(RUN, onStatus(at(QR, "r1", "pi_1"), "pi_1", "succeeded"));
  TEST_ASSERT_EQUAL(RUN, onStatus(at(IDLE), "pi_1", "succeeded"));          // paid while offline / after a cancel timeout
  TEST_ASSERT_EQUAL(RUN, onStatus(at(MESSAGE), "pi_1", "succeeded"));
  TEST_ASSERT_EQUAL(RUN, onStatus(at(CREATING, "r2"), "pi_1", "succeeded"));   // cancel lost the race to a payment
  TEST_ASSERT_EQUAL(IGNORE, onStatus(at(IDLE, "", "", "pi_1"), "pi_1", "succeeded"));   // already ran
  TEST_ASSERT_EQUAL(IGNORE, onStatus(at(RUNNING, "", "", "pi_1"), "pi_2", "succeeded"));   // never extend a run
  std::string longPi(PI_MAX + 1, 'p');
  TEST_ASSERT_EQUAL(IGNORE, onStatus(at(IDLE), longPi.c_str(), "succeeded"));
}

void test_other_statuses_only_for_the_qr_on_screen() {
  TEST_ASSERT_EQUAL(SHOW_RESULT, onStatus(at(QR, "r1", "pi_1"), "pi_1", "canceled"));
  TEST_ASSERT_EQUAL(SHOW_RESULT, onStatus(at(QR, "r1", "pi_1"), "pi_1", "expired"));
  TEST_ASSERT_EQUAL(SHOW_RESULT, onStatus(at(QR, "r1", "pi_1"), "pi_1", "failed"));
  TEST_ASSERT_EQUAL(IGNORE, onStatus(at(QR, "r1", "pi_1"), "pi_0", "canceled"));
  TEST_ASSERT_EQUAL(IGNORE, onStatus(at(IDLE), "pi_1", "expired"));
  TEST_ASSERT_EQUAL(IGNORE, onStatus(at(CREATING, "r2"), "pi_1", "canceled"));   // the replaced payment
  TEST_ASSERT_EQUAL(MSG_CANCELED, messageFor("canceled"));
  TEST_ASSERT_EQUAL(MSG_EXPIRED, messageFor("expired"));
  TEST_ASSERT_EQUAL(MSG_FAILED, messageFor("failed"));
  TEST_ASSERT_EQUAL(MSG_ERROR, messageFor("???"));
}

void test_errors() {
  TEST_ASSERT_EQUAL(SHOW_ERROR, onError(at(CREATING, "r1"), "r1"));
  TEST_ASSERT_EQUAL(SHOW_ERROR, onError(at(CREATING, "r1"), ""));
  TEST_ASSERT_EQUAL(IGNORE, onError(at(CREATING, "r1"), "r0"));
  TEST_ASSERT_EQUAL(CANCEL_FAILED, onError(at(QR, "r1", "pi_1"), "r1"));
  TEST_ASSERT_EQUAL(IGNORE, onError(at(QR, "r1", "pi_1"), ""));   // "no such payment"
  TEST_ASSERT_EQUAL(IGNORE, onError(at(RUNNING), "r1"));
  TEST_ASSERT_EQUAL(IGNORE, onError(at(IDLE), ""));
}

void test_seconds_left() {
  const int64_t now = 1800000000;
  TEST_ASSERT_EQUAL_UINT32(120, secondsLeft(now + 120, now, 99));
  TEST_ASSERT_EQUAL_UINT32(0, secondsLeft(now - 5, now, 99));
  TEST_ASSERT_EQUAL_UINT32(3600, secondsLeft(now + 99999, now, 99));
  TEST_ASSERT_EQUAL_UINT32(99, secondsLeft(now + 120, 1000, 99));   // clock not synced yet
  TEST_ASSERT_EQUAL_UINT32(99, secondsLeft(0, now, 99));
}

void test_formatting() {
  char b[24];
  TEST_ASSERT_EQUAL_STRING("20", formatBaht(2000, b, sizeof b));
  TEST_ASSERT_EQUAL_STRING("20.50", formatBaht(2050, b, sizeof b));
  TEST_ASSERT_EQUAL_STRING("10.05", formatBaht(1005, b, sizeof b));
  TEST_ASSERT_EQUAL_STRING("1:05", formatClock(65, b, sizeof b));
  TEST_ASSERT_EQUAL_STRING("0:00", formatClock(0, b, sizeof b));
  TEST_ASSERT_EQUAL_STRING("deadbeef1234", formatRef(0xdeadbeef, 0xabcd1234, b, sizeof b));
  TEST_ASSERT_EQUAL_STRING("000000000000", formatRef(0, 0, b, sizeof b));
}

void test_qr_version() {
  TEST_ASSERT_EQUAL_UINT8(3, qrVersionFor(10));
  TEST_ASSERT_EQUAL_UINT8(15, qrVersionFor(QR_MAX));
  TEST_ASSERT_EQUAL_UINT8(0, qrVersionFor(QR_MAX + 1));
  TEST_ASSERT_EQUAL_UINT8(5, qrVersionFor(106));
  TEST_ASSERT_EQUAL_UINT8(6, qrVersionFor(107));
}

void test_config() {
  TEST_ASSERT_TRUE(cfg::PRICE_SATANG >= 1000);
  TEST_ASSERT_TRUE(cfg::RUN_SECONDS >= 1);
}

static void test_tap_filter() {
  TapFilter f;
  TEST_ASSERT_FALSE(f.update(true, 1000, 100, 100));    // press starts
  TEST_ASSERT_FALSE(f.update(true, 1020, 100, 100));    // 20 ms: not yet
  TEST_ASSERT_FALSE(f.update(false, 1025, -1, -1));     // glitch released: nothing
  TEST_ASSERT_FALSE(f.update(true, 2000, 100, 100));
  TEST_ASSERT_TRUE(f.update(true, 2045, 100, 100));     // held 45 ms: one tap
  TEST_ASSERT_FALSE(f.update(true, 2500, 100, 100));    // still held: no repeat
  TEST_ASSERT_FALSE(f.update(false, 2600, -1, -1));
  TEST_ASSERT_FALSE(f.update(true, 3000, 400, 100));
  TEST_ASSERT_FALSE(f.update(true, 3100, 400, 100));    // off-screen reading: ignored
  TEST_ASSERT_TRUE(f.update(true, 3150, 200, 100));     // same press, now on screen
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_payment_is_shown_only_when_ours);
  RUN_TEST(test_payment_too_big_is_rejected);
  RUN_TEST(test_paid_always_runs_once);
  RUN_TEST(test_other_statuses_only_for_the_qr_on_screen);
  RUN_TEST(test_errors);
  RUN_TEST(test_seconds_left);
  RUN_TEST(test_formatting);
  RUN_TEST(test_qr_version);
  RUN_TEST(test_tap_filter);
  RUN_TEST(test_config);
  return UNITY_END();
}
