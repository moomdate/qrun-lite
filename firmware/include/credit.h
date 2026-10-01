// The "crafted by birdlab.th" credit shown on the boot splash and the idle screen (see ../NOTICE).
// Its CRC32 (logic.h: creditCrc) is checked against include/credit_crc.h; if you change anything here or the logo
// headers, the kiosk still works but its header reads "UNOFFICIAL". Builds you distribute must keep this credit.
#pragma once

namespace credit {

constexpr const char* WORDMARK  = "QRun Lite";    // splash wordmark: fixed, not cfg::BRAND_NAME
constexpr const char* CRAFTED_BY = "crafted by";   // splash label left of the logo
constexpr const char* UNOFFICIAL = "UNOFFICIAL";   // header text when the credit was changed or the splash skipped
constexpr const char* SITE      = "birdlab.moomdate.tech";

}  // namespace credit
