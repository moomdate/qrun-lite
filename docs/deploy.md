# คู่มือ Deploy QRun Lite (ทีละขั้น)

> **มือใหม่เริ่มที่ [start-here.md](start-here.md)** (อธิบายทุกขั้นว่าทำอะไร และถ้าสำเร็จจะเห็นอะไร)

[English](deploy.en.md) · **ภาษาไทย**

คู่มือนี้พา Worker ของ QRun Lite ขึ้นไปรันบน Cloudflare จริง แล้วแฟลชบอร์ดให้ต่อเข้ามา ตู้ใช้งานได้ตลอด 24 ชั่วโมง
โดยไม่ต้องเปิดคอมพิวเตอร์ทิ้งไว้ ใช้ plan **Workers Free** ได้

```
ตู้ (ESP32) ──wss + DEVICE_TOKEN──▶ Cloudflare Worker + Durable Object ──sk_ key──▶ Stripe
                                          ▲                                           │
                                          └────────── webhook ที่มีลายเซ็น (whsec_) ◀───┘
```

![แผนภาพการทำงานของ QRun Lite](architecture.svg)

ใช้เวลาประมาณ 15 นาที ทุกคำสั่งรันที่ root ของโปรเจกต์ เว้นแต่ขั้นนั้นบอกให้ `cd` ไปที่อื่น

---

## 0. เตรียมของ

| ต้องมี | เช็คด้วย |
|---|---|
| Node.js 20 ขึ้นไป | `node -v` |
| PlatformIO (ส่วนเสริม VS Code หรือ `pip install platformio`) | `pio --version` |
| บัญชี Cloudflare (สมัครฟรี) | https://dash.cloudflare.com |
| บัญชี Stripe ที่จดในประเทศไทย | Dashboard → Settings → Business details |
| บอร์ด ESP32-2432S028R + สาย USB ที่ส่งข้อมูลได้ | [hardware.md](hardware.md) |
| WiFi 2.4 GHz ที่ตู้จะใช้ | ESP32 ใช้ 5 GHz ไม่ได้ |

---

## 1. เตรียม Stripe

1. Stripe Dashboard → **Settings → Payment methods** → เปิด **PromptPay**
2. เริ่มจาก **test mode** ก่อน คัดลอก secret key ของโหมดทดสอบ (`sk_test_…`) จาก **Developers → API keys**

> ใช้ restricted key (`rk_…`) ที่ให้สิทธิ์แค่ **PaymentIntents: Write** แทนได้ ถ้าคีย์หลุดความเสียหายจะน้อยกว่า

---

## 2. ตั้งราคาและอีเมล (ต้องตรงกันสองที่)

**`worker/wrangler.jsonc`** ส่วน `vars`:

| ค่า | ความหมาย |
|---|---|
| `PRICE_SATANG` | ราคาเดียวที่ตู้เก็บได้ หน่วยสตางค์ (`2000` = ฿20 ขั้นต่ำ `1000`) |
| `PAYMENT_TTL_SEC` | QR จ่ายได้กี่วินาที (ค่าเริ่มต้น `120`) หมดเวลาแล้ว Worker จะยกเลิกที่ Stripe |
| `RECEIPT_EMAIL` | อีเมลร้านของคุณ Stripe บังคับให้ทุกรายการพร้อมเพย์มีอีเมล |

**`firmware/include/config.h`**:

| ค่า | ความหมาย |
|---|---|
| `PRICE_SATANG` | **ต้องเป็นเลขเดียวกับใน `wrangler.jsonc`** ไม่อย่างนั้นแตะทีไรก็ขึ้น "เกิดข้อผิดพลาด" |
| `RUN_SECONDS` | เวลาที่รีเลย์ทำงานหลังจ่ายเงิน (1–3600 วินาที) |
| `RELAY_PIN`, `RELAY_ACTIVE_HIGH` | ขารีเลย์ (ค่าเริ่มต้น GPIO 22) และขั้ว ดู [hardware.md](hardware.md) |

> Worker รับเฉพาะยอด `PRICE_SATANG` เท่านั้น ต่อให้ device token หลุด ก็เรียกเก็บยอดอื่นไม่ได้

---

## 3. Login Cloudflare แล้ว Deploy Worker

```bash
cd worker
npm install
npx wrangler login      # เปิด browser ให้กด Allow
npx wrangler whoami     # ต้องเห็นชื่อ account ของคุณ
npx wrangler deploy
```

ถ้าบัญชียังไม่เคยใช้ Workers ให้เข้า Dashboard → **Workers & Pages** หนึ่งครั้งเพื่อสร้าง subdomain `<you>.workers.dev`

ถ้าสำเร็จจะได้ URL แบบนี้ จดไว้ใช้ต่อ:
```
https://qrun-lite.<you>.workers.dev
```

ทดสอบ:
```bash
curl https://qrun-lite.<you>.workers.dev/health      # → ok
```

---

## 4. ใส่ Secrets

Lite ใช้ secret แค่ 3 ตัว และมี **device token ตัวเดียว** (`DEVICE_TOKEN`) เพราะมีตู้เดียว

```bash
cd worker
openssl rand -hex 24                            # สร้าง device token เก็บไว้ใช้ในขั้นที่ 6
npx wrangler secret put DEVICE_TOKEN            # วาง token
npx wrangler secret put STRIPE_SECRET_KEY       # วาง sk_test_… (หรือ rk_…)
```

| Secret | เอามาจาก |
|---|---|
| `DEVICE_TOKEN` | `openssl rand -hex 24` ค่าเดียวกันต้องไปอยู่ใน `firmware/include/secrets.h` |
| `STRIPE_SECRET_KEY` | Stripe Dashboard → **Developers → API keys** |
| `STRIPE_WEBHOOK_SECRET` | สร้างในขั้นที่ 5 (ยังไม่ต้องมีตอนนี้) |

- **Cloudflare เก็บ secret แบบเขียนได้อย่างเดียว** `npx wrangler secret list` แสดงได้แค่ชื่อ ถ้าจำค่าไม่ได้ให้ตั้งใหม่ทับ
- ตั้ง secret แล้วมีผลทันที ไม่ต้อง deploy ใหม่
- อย่าวางค่า secret ในแชท อย่า commit ขึ้น Git

---

## 5. ผูก Webhook ของ Stripe

Stripe ต้องรู้ว่าเมื่อลูกค้าจ่ายแล้วให้แจ้งไปที่ไหน

### แบบ Dashboard
1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**
   (โหมดของ endpoint ต้องตรงกับโหมดของ key: test กับ test, live กับ live)
2. **Endpoint URL:** `https://qrun-lite.<you>.workers.dev/stripe/webhook`
3. **Events** เลือก 3 ตัว:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `payment_intent.canceled`
4. กด Add แล้วกด **Reveal** ที่ Signing secret จะได้ค่า `whsec_…`
5. ใส่เข้า Worker:
   ```bash
   cd worker && npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

### แบบ Stripe CLI (แทน Dashboard)
```bash
stripe webhook_endpoints create \
  -d url=https://qrun-lite.<you>.workers.dev/stripe/webhook \
  -d "enabled_events[]=payment_intent.succeeded" \
  -d "enabled_events[]=payment_intent.payment_failed" \
  -d "enabled_events[]=payment_intent.canceled"
```
ใน output มี `"secret": "whsec_…"` เอาไปใส่ด้วย `wrangler secret put STRIPE_WEBHOOK_SECRET` (เพิ่ม `--live` เมื่อสร้างของโหมด live)

> `whsec_` ของ endpoint นี้ **ไม่ใช่ตัวเดียวกับ** ของ `stripe listen` ที่ใช้ตอนพัฒนาในเครื่อง ห้ามสลับกัน
> Lite **ไม่มีการถาม Stripe เป็นระยะ (polling)** ถ้า webhook ไม่เข้า ตู้จะรู้ผลตอน QR หมดอายุหรือตอนต่อกลับเท่านั้น

---

## 6. ตั้งค่า firmware แล้วแฟลช

```bash
cd firmware
cp include/secrets.h.example include/secrets.h
```

แก้ `include/secrets.h` (ไฟล์นี้อยู่ใน `.gitignore` ห้าม commit):

| ค่า | ใส่อะไร |
|---|---|
| `WIFI_SSID`, `WIFI_PASS` | WiFi 2.4 GHz |
| `WS_HOST` | `qrun-lite.<you>.workers.dev` (ไม่มี `https://` ไม่มี path) |
| `WS_PORT`, `WS_USE_TLS` | `443` และ `1` |
| `DEVICE_ID` | ชื่ออะไรก็ได้ เช่น `kiosk-01` ใช้แสดงใน log |
| `DEVICE_TOKEN` | ค่าเดียวกับ secret `DEVICE_TOKEN` ในขั้นที่ 4 |

แฟลช:
```bash
ls /dev/cu.usbserial-*                            # macOS หา port (Linux: /dev/ttyUSB*)
pio run -t upload --upload-port /dev/cu.usbserial-XXXX
```

บนบอร์ดไม่มีคีย์ Stripe เลย มีแค่ WiFi และ device token เฟิร์มแวร์ตรวจ TLS ของ Cloudflare กับ root CA ที่ปักหมุดไว้

---

## 7. ตรวจว่าใช้งานได้

**serial ของบอร์ด**
```bash
pio device monitor
```
ต้องเห็นประมาณนี้:
```
[QRun Lite] lite-1.0.0, price 2000 satang, run 60 s -> wss://qrun-lite.<you>.workers.dev:443
[WIFI] connected, IP 192.168.1.x
[WS] connected
[WS] > {"t":"hello","fw":"lite-1.0.0"}
[WS] < {"t":"hello","device":"kiosk-01","live":false}
```
`live:false` คือใช้ test key หน้าจอจะขึ้น **ออนไลน์** จุดเขียว และมีป้าย **TEST** สีเหลือง

**log ของ Worker สด ๆ** (เปิดค้างไว้ตอนทดสอบจ่าย)
```bash
cd worker && npx wrangler tail --format pretty
```
แตะปุ่มราคาแล้วสแกนจ่าย ควรเห็น:
```
created pi_… ref=… amount=2000
POST https://qrun-lite.<you>.workers.dev/stripe/webhook - Ok
pi_… succeeded (delivered)
```

**ทดสอบจ่าย (test mode):** QR ทดสอบจะเปิดหน้าทดสอบของ Stripe กด **Authorize** ตู้ต้องบี๊บ ขึ้น "กำลังทำงาน"
และรีเลย์เปิดทันที กด **Fail** ตู้ต้องขึ้น "ชำระเงินไม่สำเร็จ"

**ใน Stripe:** Dashboard → Developers → Webhooks → endpoint ของเรา การส่งต้องเป็น 200

---

## 8. เปิดใช้เงินจริง (live)

1. ปิด Test mode ใน Stripe Dashboard แล้วสร้าง live key (`sk_live_…` หรือ `rk_live_…`)
2. เพิ่ม webhook endpoint เดิมอีกครั้งใน **live mode** (ได้ `whsec_` **ของตัวเอง**)
3. ```bash
   cd worker
   npx wrangler secret put STRIPE_SECRET_KEY       # live key
   npx wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_ ของ endpoint live
   ```
ไม่ต้อง deploy หรือแฟลชบอร์ดใหม่ ป้าย **TEST** จะหายเมื่อตู้ต่อเข้ามาใหม่ (ถ้ายังอยู่ให้กดรีเซ็ตบอร์ด) serial จะขึ้น `"live":true`

---

## งานดูแลประจำ

| อยากทำอะไร | ทำอย่างไร |
|---|---|
| อัปเดตโค้ด Worker | `cd worker && npm run typecheck && npm test && npm run e2e && npx wrangler deploy` |
| ย้อนกลับเวอร์ชันก่อน | `cd worker && npx wrangler rollback` |
| ดูว่ามี secret อะไรบ้าง (ไม่แสดงค่า) | `cd worker && npx wrangler secret list` |
| เปลี่ยนราคา | แก้ `PRICE_SATANG` **ทั้ง** `wrangler.jsonc` และ `config.h` แล้ว deploy และแฟลช |
| เปลี่ยนเวลาทำงาน | แก้ `RUN_SECONDS` ใน `config.h` แล้วแฟลช |
| เปลี่ยนเวลา QR หมดอายุ | แก้ `PAYMENT_TTL_SEC` ใน `wrangler.jsonc` แล้ว deploy |
| ตู้หาย / token หลุด | `openssl rand -hex 24` → `npx wrangler secret put DEVICE_TOKEN` แล้วแฟลชบอร์ดใหม่ด้วยค่าใหม่ |
| roll Stripe key | Stripe Dashboard → API keys → Roll key แล้ว `npx wrangler secret put STRIPE_SECRET_KEY` |

## แก้ปัญหา

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| คอมไพล์แล้วขึ้น `Missing include/secrets.h` | ทำขั้นที่ 6: คัดลอก `secrets.h.example` เป็น `secrets.h` |
| หัวจอขึ้น **ไม่มี WiFi**, serial ขึ้น `[WIFI] status=1` | หา WiFi ไม่เจอ (เป็น 5 GHz อย่างเดียว หรือพิมพ์ชื่อผิด) |
| serial ขึ้น `[WIFI] status=4` | รหัส WiFi ผิด |
| ค้างที่ **กำลังเชื่อมต่อ** | `WS_HOST` ผิด หรือยังไม่ได้ deploy ลอง `curl https://<host>/health` ถ้า `wrangler tail` ขึ้น `ws auth rejected` แปลว่า `DEVICE_TOKEN` ใน `secrets.h` ไม่ตรงกับ secret ถ้าเครือข่ายบล็อก NTP (UDP 123) TLS จะต่อไม่ได้ |
| `/ws` ตอบ `server misconfigured` | ยังไม่ได้ตั้ง secret `DEVICE_TOKEN` |
| แตะทีไรขึ้น **เกิดข้อผิดพลาด** | ดู `wrangler tail`: `amount … != PRICE_SATANG` = ราคาสองที่ไม่ตรงกัน, `PRICE_SATANG is missing` = ค่าไม่ถูกต้อง, `payment provider error (…)` = ยังไม่เปิด PromptPay / บัญชีไม่ใช่ไทย / key ผิด / ไม่มี `RECEIPT_EMAIL` |
| จ่ายแล้ว ตู้เปลี่ยนตอน QR หมดเวลาเท่านั้น | webhook ไม่เข้า: เช็ค URL (`/stripe/webhook`), events ทั้ง 3 และ `STRIPE_WEBHOOK_SECRET` ต้องเป็นของ endpoint นั้นในโหมดนั้น `wrangler tail` จะขึ้น `webhook rejected: bad signature` ถ้าใช้ผิดตัว เงินไม่หาย Worker ถาม Stripe ตอน QR หมดอายุและตอนตู้ต่อกลับ |
| รีเลย์ทำงานกลับด้าน | `RELAY_ACTIVE_HIGH = false` ใน `config.h` |
| แตะไม่ตรง / สีเพี้ยน | ดูหัวข้อรุ่นของบอร์ดใน [hardware.md](hardware.md) |

ถ้ายังไม่เจอ ให้เปิด serial กับ `wrangler tail` พร้อมกัน แล้วเทียบข้อความกับ [PROTOCOL.md](../PROTOCOL.md)

## ค่าใช้จ่าย

- **Cloudflare:** ตู้หนึ่งเครื่องใช้ WebSocket ค้างไว้ 1 เส้น กับไม่กี่ request ต่อรายการ ping ทุก 20 วินาทีถูกตอบโดย runtime
  โดยไม่ปลุก Durable Object ใช้ plan Free ได้สบาย (Workers 100,000 requests ต่อวัน, Durable Objects แบบ SQLite ใช้ได้ใน Free plan)
- **Stripe:** ไม่มีค่ารายเดือน คิดค่าธรรมเนียม PromptPay ต่อรายการตามอัตราของบัญชีคุณ ดูที่ Dashboard → Pricing
- **ฮาร์ดแวร์:** บอร์ด CYD ราว 300 บาท + โมดูลรีเลย์
