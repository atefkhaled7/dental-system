require("dotenv").config();
const pool = require("../db");

const BASE_URL = process.env.TEST_API_URL || "http://localhost:5000/api";

const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

const logPass = (title, detail = "") =>
  console.log(
    `${colors.green}  ✔ [PASS]${colors.reset} ${title} ${
      detail ? `(${detail})` : ""
    }`
  );

const logFail = (title, reason) =>
  console.log(`${colors.red}  ✖ [FAIL]${colors.reset} ${title} -> ${reason}`);

const logSkip = (title, reason) =>
  console.log(
    `${colors.yellow}  ⚠ [SKIPPED]${colors.reset} ${title} -> ${reason}`
  );

// دالة مساعدة لجلب Token عبر الـ Login إذا توفرت بيانات الدخول
async function getAuthToken(email, password) {
  try {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    return res.status === 200 ? data.token : null;
  } catch {
    return null;
  }
}

async function runSecuritySuite() {
  console.log("\n========================================================");
  console.log(
    `${colors.bold}${colors.cyan}🛡️  SaaS Security & Tenant Isolation Test${colors.reset}`
  );
  console.log("========================================================\n");

  // 1. صمام الأمان: منع التشغيل خارج Localhost
  try {
    const targetUrl = new URL(BASE_URL);
    const isLocalhost =
      targetUrl.hostname === "localhost" || targetUrl.hostname === "127.0.0.1";

    if (!isLocalhost) {
      console.error(
        `${colors.red}خطأ أمني فادح: هذا الاختبار مخصص لـ Localhost فقط وممنوع تشغيله على الإنتاج: ${BASE_URL}${colors.reset}\n`
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(`${colors.red}الرابط غير صالح: ${BASE_URL}${colors.reset}\n`);
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // ----------------------------------------------------
  // السيناريو الأول: Tenant Isolation
  // ----------------------------------------------------
  console.log(
    `${colors.bold}1. فحص عزل المستأجرين (Tenant Isolation):${colors.reset}`
  );

  const userAToken =
    process.env.TEST_CLINIC_A_TOKEN ||
    (process.env.TEST_CLINIC_A_EMAIL && process.env.TEST_CLINIC_A_PASSWORD
      ? await getAuthToken(
          process.env.TEST_CLINIC_A_EMAIL,
          process.env.TEST_CLINIC_A_PASSWORD
        )
      : null);

  const targetClinicBPatientId = process.env.TEST_CLINIC_B_PATIENT_ID;

  if (!userAToken || !targetClinicBPatientId) {
    logSkip(
      "منع وصول عيادة A لبيانات عيادة B",
      "يتطلب توفير TEST_CLINIC_A_TOKEN (أو TEST_CLINIC_A_EMAIL/PASSWORD) و TEST_CLINIC_B_PATIENT_ID في ملف .env"
    );
    skipped++;
  } else {
    try {
      // محاولة مريض عيادة B بواسطة مستخدم عيادة A
      const res = await fetch(
        `${BASE_URL}/patients/${targetClinicBPatientId}`,
        {
          headers: {
            Authorization: `Bearer ${userAToken}`,
          },
        }
      );

      // السلوك السليم: إما 404 (المريض غير موجود في نطاق عيادتك) أو 403
      // الفشل: لو السيرفر رجع 200 وسرب بيانات المريض
      if (res.status === 404 || res.status === 403) {
        logPass(
          "عزل المستأجرين ناجح",
          `تم رفض الوصول بكود ${res.status} ومنع تسريب بيانات عيادة B`
        );
        passed++;
      } else if (res.status === 200) {
        logFail(
          "تسريب أمني في عزل المستأجرين!",
          `تمكن مستخدم عيادة A من قراءة مريض عيادة B (كود 200)`
        );
        failed++;
      } else {
        logFail("رد غير متوقع من السيرفر", `كود الرد: ${res.status}`);
        failed++;
      }
    } catch (err) {
      logFail("فشل تنفيذ اختبار عزل المستأجرين", err.message);
      failed++;
    }
  }

  // ----------------------------------------------------
  // السيناريو الثاني: Disabled Staff
  // ----------------------------------------------------
  console.log(
    `\n${colors.bold}2. فحص طرد الموظف المعطل (Disabled Staff):${colors.reset}`
  );

  const testStaffId = process.env.TEST_STAFF_USER_ID;
  const staffToken =
    process.env.TEST_STAFF_TOKEN ||
    (process.env.TEST_STAFF_EMAIL && process.env.TEST_STAFF_PASSWORD
      ? await getAuthToken(
          process.env.TEST_STAFF_EMAIL,
          process.env.TEST_STAFF_PASSWORD
        )
      : null);

  if (!testStaffId || !staffToken) {
    logSkip(
      "حظر الموظف المعطل فوراً",
      "يتطلب توفير TEST_STAFF_USER_ID و TEST_STAFF_TOKEN (أو TEST_STAFF_EMAIL/PASSWORD) في ملف .env"
    );
    skipped++;
  } else {
    let originalIsActive = null;
    try {
      // 1. جلب وحفظ الحالة الحالية
      const userRes = await pool.query(
        "SELECT id, is_active FROM users WHERE id = $1",
        [testStaffId]
      );

      if (userRes.rows.length === 0) {
        throw new Error(
          `المستخدم ذو المعرف ${testStaffId} غير موجود بقاعدة البيانات`
        );
      }

      originalIsActive = userRes.rows[0].is_active;

      // 2. تعطيل الموظف في الداتابيز
      await pool.query("UPDATE users SET is_active = FALSE WHERE id = $1", [
        testStaffId,
      ]);

      // 3. محاولة طلب endpoint محمي بالتوكن القديم
      const testRes = await fetch(`${BASE_URL}/patients`, {
        headers: {
          Authorization: `Bearer ${staffToken}`,
        },
      });

      const body = await testRes.json();

      if (testRes.status === 403 && body.error?.includes("إيقاف")) {
        logPass(
          "طرد الموظف المعطل بنجاح",
          `تم الرد بـ 403 والرسالة: "${body.error}"`
        );
        passed++;
      } else {
        logFail(
          "الموظف المعطل تمكن من المرور أو الكود غير مطابق",
          `كود الرد: ${testRes.status}, الرسالة: ${JSON.stringify(body)}`
        );
        failed++;
      }
    } catch (err) {
      logFail("فشل تنفيذ سيناريو تعطيل الموظف", err.message);
      failed++;
    } finally {
      // 4. استرجاع الحالة الأصلية دائماً لضمان Non-destructive test
      if (originalIsActive !== null) {
        await pool.query("UPDATE users SET is_active = $1 WHERE id = $2", [
          originalIsActive,
          testStaffId,
        ]);
      }
    }
  }

  // ----------------------------------------------------
  // السيناريو الثالث: Expired Subscription
  // ----------------------------------------------------
  console.log(
    `\n${colors.bold}3. فحص انتهاء الاشتراك (Expired Subscription):${colors.reset}`
  );

  const testClinicId = process.env.TEST_EXPIRED_CLINIC_ID;
  const clinicUserToken =
    process.env.TEST_EXPIRED_CLINIC_USER_TOKEN ||
    (process.env.TEST_EXPIRED_CLINIC_USER_EMAIL &&
    process.env.TEST_EXPIRED_CLINIC_USER_PASSWORD
      ? await getAuthToken(
          process.env.TEST_EXPIRED_CLINIC_USER_EMAIL,
          process.env.TEST_EXPIRED_CLINIC_USER_PASSWORD
        )
      : null);

  if (!testClinicId || !clinicUserToken) {
    logSkip(
      "حظر العيادة منتهية الاشتراك",
      "يتطلب توفير TEST_EXPIRED_CLINIC_ID و TEST_EXPIRED_CLINIC_USER_TOKEN (أو EMAIL/PASSWORD) في ملف .env"
    );
    skipped++;
  } else {
    let originalEndsAt;
    try {
      // 1. جلب وحفظ تاريخ انتهاء الاشتراك الأصلي
      const clinicRes = await pool.query(
        "SELECT id, subscription_ends_at FROM clinics WHERE id = $1",
        [testClinicId]
      );

      if (clinicRes.rows.length === 0) {
        throw new Error(`العيادة ذات المعرف ${testClinicId} غير موجودة`);
      }

      originalEndsAt = clinicRes.rows[0].subscription_ends_at;

      // 2. تعديل تاريخ الاشتراك ليصبح منتهياً (أمس)
      await pool.query(
        "UPDATE clinics SET subscription_ends_at = NOW() - INTERVAL '1 day' WHERE id = $1",
        [testClinicId]
      );

      // 3. طلب مسار محمي بتوكن من نفس العيادة
      const testRes = await fetch(`${BASE_URL}/patients`, {
        headers: {
          Authorization: `Bearer ${clinicUserToken}`,
        },
      });

      const body = await testRes.json();

      if (testRes.status === 403 && body.error?.includes("انتهت فترة اشتراك")) {
        logPass(
          "حظر العيادة المنتهية بنجاح",
          `تم الرد بـ 403 والرسالة: "${body.error}"`
        );
        passed++;
      } else {
        logFail(
          "العيادة المنتهية لم تُحظر أو الكود غير مطابق",
          `كود الرد: ${testRes.status}, الرسالة: ${JSON.stringify(body)}`
        );
        failed++;
      }
    } catch (err) {
      logFail("فشل تنفيذ سيناريو انتهاء الاشتراك", err.message);
      failed++;
    } finally {
      // 4. استرجاع التاريخ الأصلي لضمان سلامة البيانات
      if (originalEndsAt !== null) {
        await pool.query(
          "UPDATE clinics SET subscription_ends_at = $1 WHERE id = $2",
          [originalEndsAt, testClinicId]
        );
      }
    }
  }

  // إغلاق الـ Database Pool
  await pool.end();

  // ----------------------------------------------------
  // الملخص النهائي
  // ----------------------------------------------------
  console.log("\n--------------------------------------------------------");
  console.log(`${colors.bold}نتائج الاختبار الأمنية:${colors.reset}`);
  console.log(`passed: ${passed} / failed: ${failed} / skipped: ${skipped}`);
  console.log("--------------------------------------------------------\n");
}

runSecuritySuite();
