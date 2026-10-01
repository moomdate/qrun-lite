// Every text the kiosk shows, in one place. To translate: edit the right-hand sides (UTF-8, Thai or ASCII).
//
// Rules of thumb:
//  - The two smooth fonts in src/fonts hold ASCII + Thai only. Other scripts need a new font (see fonts/OFL.txt).
//  - Keep them short: the screen is 320 px wide (about 28 Thai characters in the body font).
//  - "%lu" is filled by the firmware; keep it (and only one of it) where it is.
#pragma once

namespace str {

// Boot splash (the wordmark and the "crafted by" credit are fixed: include/credit.h)
constexpr const char* TAGLINE     = "สแกนจ่าย แล้วเครื่องทำงาน";

// Header status pill
constexpr const char* ONLINE      = "ออนไลน์";
constexpr const char* CONNECTING  = "กำลังเชื่อมต่อ";
constexpr const char* NO_WIFI     = "ไม่มี WiFi";
constexpr const char* TEST        = "TEST";               // Stripe test mode badge

// Price screen
constexpr const char* CURRENCY    = "฿";                   // put before the amount
constexpr const char* TAP_TO_PAY  = "แตะเพื่อจ่าย";
constexpr const char* WAITING     = "กำลังเชื่อมต่อ...";
constexpr const char* RUN_INFO    = "จ่ายแล้วทำงาน %lu วินาที";   // %lu = RUN_SECONDS

// Creating the QR
constexpr const char* CREATING    = "กำลังสร้าง QR...";

// QR screen
constexpr const char* SCAN_TO_PAY = "สแกนจ่าย PromptPay";   // printed on the white QR card
constexpr const char* QR_ERROR    = "QR error";
constexpr const char* TIME_LEFT   = "เหลือเวลา";
constexpr const char* HURRY       = "ใกล้หมดเวลา";          // last seconds of the QR
constexpr const char* OFFLINE     = "ออฟไลน์";
constexpr const char* CANCEL      = "ยกเลิก";
constexpr const char* CANCELLING  = "กำลังยกเลิก";

// Paid, relay running
constexpr const char* PAID        = "ชำระแล้ว";
constexpr const char* RUNNING     = "กำลังทำงาน";
constexpr const char* THANKS      = "ชำระเงินสำเร็จ ขอบคุณครับ";

// Result messages, in the order of lite::Message: canceled, expired, failed, error
constexpr const char* MSG_TITLE[] = {"ยกเลิกแล้ว", "QR หมดอายุ", "ชำระเงินไม่สำเร็จ", "เกิดข้อผิดพลาด"};
constexpr const char* NO_CHARGE   = "ไม่มีการตัดเงิน";       // under canceled / expired / failed
constexpr const char* TRY_AGAIN   = "กรุณาลองใหม่อีกครั้ง";   // under error
constexpr const char* TAP_BACK    = "แตะเพื่อกลับ";

}  // namespace str
