// Expected CRC32 of the birdlab.th credit (see credit.h, logic.h: creditCrc, ../NOTICE). Kept apart from the splash
// code on purpose. Not a secret and not a lock: it only decides whether the header says "UNOFFICIAL".
// If you edit credit.h or the logo headers, the unit test fails and prints the new value.
#pragma once
#include <stdint.h>

namespace credit {

constexpr uint32_t EXPECTED_CRC = 0x1535C92Cu;

}  // namespace credit
