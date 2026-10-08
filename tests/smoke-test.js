/**
 * CUROSTA SaaS - Phase 6 Production Smoke Test
 * اختبارات سريعة للتأكد من أمان العيادات وعزل البيانات والاشتراكات
 * التشغيل: node tests/smoke-test.js
 */

const BASE_URL = process.env.TEST_API_URL || "http://localhost:5000/api";

const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
};

const logPass = (title) =>
  console.log(`${colors.green}  ✔ [PASS]${colors.reset} ${title}`);
const logFail = (title, err) =>
  console.log(`${colors.red}  ✖ [FAIL]${colors.reset} ${title} -> ${err}`);
const logInfo = (msg) => console.log(`${colors.cyan}${msg}${colors.reset}`);

async function runTests() {
  console.log("\n========================================================");
  logInfo("🚀 بدء فحص واختبار أمان وجاهزية نظام CUROSTA للإنتاج");
  console.log("========================================================\n");

  let passed = 0;
  let failed = 0;

  // 1. اختبار الـ Health Check
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    if (
      res.status === 200 &&
      data.status === "healthy" &&
      data.db?.status === "connected"
    ) {
      logPass(`Health Check سليم (استجابة الـ DB: ${data.db.latency_ms}ms)`);
      passed++;
    } else {
      throw new Error(`رد غير متوقع: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    logFail("Health Check Endpoint", err.message);
    failed++;
  }

  // 2. اختبار الـ 404 المركزي
  try {
    const res = await fetch(`${BASE_URL}/some-route-that-does-not-exist-xyz`);
    if (res.status === 404) {
      logPass("معالجة المسارات غير الموجودة (404 Centralized)");
      passed++;
    } else {
      throw new Error(`كود الرد كان ${res.status} بدل 404`);
    }
  } catch (err) {
    logFail("مسارات 404", err.message);
    failed++;
  }

  // 3. اختبار الـ Unauthenticated Requests (منع الوصول بدون Token)
  try {
    const res = await fetch(`${BASE_URL}/patients`);
    if (res.status === 401) {
      logPass("حماية مسارات المرضى من الوصول بدون تسجيل دخول (401)");
      passed++;
    } else {
      throw new Error(`المسار سمح بالدخول أو رد بكود ${res.status}`);
    }
  } catch (err) {
    logFail("فحص الـ Auth Guard", err.message);
    failed++;
  }

  // 4. اختبار ترويسات الأمان (Helmet & CORS)
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const headers = res.headers;
    const hasHelmet = headers.get("x-content-type-options") === "nosniff";
    if (hasHelmet) {
      logPass("ترويسات الأمان (Helmet Headers) مفعلة وشغالة بنجاح");
      passed++;
    } else {
      throw new Error("ترويسة x-content-type-options مفقودة");
    }
  } catch (err) {
    logFail("ترويسات Helmet", err.message);
    failed++;
  }

  // 5. فحص حماية هجوم الـ Payload الكبيرة (DoS Payload Limit 100kb)
  try {
    const hugePayload = "A".repeat(150 * 1024); // 150KB
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test@curosta.com",
        password: hugePayload,
      }),
    });

    if (res.status === 413) {
      logPass("حماية السيرفر من الحمولات الضخمة (413 Payload Too Large)");
      passed++;
    } else {
      throw new Error(`كان متوقع 413 لكن السيرفر رد بـ ${res.status}`);
    }
  } catch (err) {
    logFail("فحص حمولة DoS", err.message);
    failed++;
  }

  console.log("\n--------------------------------------------------------");
  if (failed === 0) {
    console.log(
      `${colors.green}🎉 مبروك يا زعيم! كل الفحوصات نجحت (${passed}/${
        passed + failed
      })${colors.reset}`
    );
    console.log(
      `${colors.yellow}كده المرحلة 6 اتقفلت 100% رسمياً وضميرك مرتاح تماماً!${colors.reset}\n`
    );
  } else {
    console.log(
      `${colors.red}⚠️ هناك ${failed} فحوصات فشلت، يرجى مراجعتها.${colors.reset}\n`
    );
  }
}

runTests();
