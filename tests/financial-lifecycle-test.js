/**
 * CUROSTA SaaS - Phase 0
 * Comprehensive Financial Lifecycle, Concurrency & DB Verification Tests
 *
 * التشغيل:
 * node tests/financial-lifecycle-test.js
 */
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
    `${colors.green}  ✔ [PASS]${colors.reset} ${title}${
      detail ? ` (${detail})` : ""
    }`
  );

const logFail = (title, reason) =>
  console.log(`${colors.red}  ✖ [FAIL]${colors.reset} ${title} -> ${reason}`);

let passed = 0;
let failed = 0;

async function request(endpoint, options = {}, token = null) {
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function runFinancialTests() {
  console.log("\n========================================================");
  console.log(
    `${colors.bold}${colors.cyan}💰 CUROSTA - Financial Tests + Concurrency & DB Audit${colors.reset}`
  );
  console.log("========================================================\n");

  let token = process.env.TEST_USER_TOKEN;
  let testPatientId = null;
  const createdInvoiceIds = [];

  try {
    // ----------------------------------------------------
    // 1. تسجيل الدخول
    // ----------------------------------------------------
    if (!token) {
      const email = process.env.TEST_USER_EMAIL;
      const password = process.env.TEST_USER_PASSWORD;
      if (!email || !password) {
        throw new Error(
          "يرجى ضبط TEST_USER_EMAIL و TEST_USER_PASSWORD أو TEST_USER_TOKEN في ملف .env"
        );
      }
      const loginRes = await request("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      if (loginRes.status !== 200 || !loginRes.data.token) {
        throw new Error(
          `فشل تسجيل الدخول: ${loginRes.data.error || loginRes.status}`
        );
      }
      token = loginRes.data.token;
      logPass("تسجيل الدخول للاختبار المالي");
      passed++;
    }

    // ----------------------------------------------------
    // 2. إنشاء مريض تجريبي
    // ----------------------------------------------------
    const patientRes = await request(
      "/patients",
      {
        method: "POST",
        body: {
          name: "مريض اختبارات مالية",
          phone_number: `010${Math.floor(10000000 + Math.random() * 90000000)}`,
          gender: "Male",
        },
      },
      token
    );
    if (patientRes.status !== 201 || !patientRes.data.patient?.id) {
      throw new Error(`فشل إنشاء مريض الاختبار: ${patientRes.data.error}`);
    }
    testPatientId = patientRes.data.patient.id;
    logPass("إنشاء مريض تجريبي للاختبار");
    passed++;

    // ----------------------------------------------------
    // 3. فحص رفض إنشاء فاتورة بدفعة فورية أكبر من الإجمالي
    // ----------------------------------------------------
    const overpaidInvoiceRes = await request(
      "/invoices",
      {
        method: "POST",
        body: {
          patient_id: testPatientId,
          items: [{ description: "كشف أولي", quantity: 1, unit_price: 200 }],
          initial_payment: { amount: 300, payment_method: "cash" },
        },
      },
      token
    );
    if (overpaidInvoiceRes.status === 400) {
      logPass("منع إنشاء فاتورة بدفعة فورية زائدة", "رُفض بـ 400 كما هو متوقع");
      passed++;
    } else {
      logFail(
        "منع الدفعة الفورية الزائدة",
        `الرد كان: ${overpaidInvoiceRes.status}`
      );
      failed++;
    }

    // ----------------------------------------------------
    // 4. إنشاء فاتورة عادية (إجمالي 500 ج.م بدفعة فورية 150 ج.م)
    // ----------------------------------------------------
    const createInvRes = await request(
      "/invoices",
      {
        method: "POST",
        body: {
          patient_id: testPatientId,
          items: [
            { description: "حشو تجميلي عصب", quantity: 1, unit_price: 350 },
            { description: "أشعة ديجيتال", quantity: 1, unit_price: 150 },
          ],
          initial_payment: {
            amount: 150,
            payment_method: "cash",
            notes: "دفعة أولى عند الحجز",
          },
        },
      },
      token
    );
    if (createInvRes.status === 201 && createInvRes.data.invoice?.id) {
      const inv = createInvRes.data.invoice;
      createdInvoiceIds.push(inv.id);
      if (Number(inv.total_amount) === 500 && inv.status === "partially_paid") {
        logPass(
          "إنشاء الفاتورة واحتساب القروش والدفعة الجزئية الأولى",
          "إجمالي 500، حالة partially_paid"
        );
        passed++;
      } else {
        logFail(
          "حسابات الفاتورة الأولى غير دقيقة",
          `total: ${inv.total_amount}, status: ${inv.status}`
        );
        failed++;
      }
    } else {
      logFail("فشل إنشاء الفاتورة", createInvRes.data.error);
      failed++;
    }

    const mainInvoiceId = createdInvoiceIds[0];

    // ----------------------------------------------------
    // 5. جلب الفاتورة والتحقق من حساب المدفوع والمتبقي
    // ----------------------------------------------------
    if (mainInvoiceId) {
      const getInvRes = await request(
        `/invoices/${mainInvoiceId}`,
        { method: "GET" },
        token
      );
      if (
        getInvRes.status === 200 &&
        Number(getInvRes.data.paid_amount) === 150 &&
        Number(getInvRes.data.remaining_amount) === 350
      ) {
        logPass(
          "صحة حساب المتبقي والمدفوع للفاتورة",
          "المدفوع: 150، المتبقي: 350"
        );
        passed++;
      } else {
        logFail(
          "خطأ في قراءة المدفوع والمتبقي",
          `paid: ${getInvRes.data?.paid_amount}, remaining: ${getInvRes.data?.remaining_amount}`
        );
        failed++;
      }

      // ----------------------------------------------------
      // 6. محاولة دفع يدوي زائد (Overpayment) يتجاوز المتبقي
      // ----------------------------------------------------
      const overpayRes = await request(
        "/payments/record",
        {
          method: "POST",
          body: {
            invoice_id: mainInvoiceId,
            amount: 400, // المتبقي 350 فقط
            payment_method: "cash",
          },
        },
        token
      );
      if (overpayRes.status === 400) {
        logPass("منع تسجيل دفعة تتجاوز المبلغ المتبقي", "رُفضت بـ 400 بنجاح");
        passed++;
      } else {
        logFail(
          "ثغرة: تم قبول دفعة تتجاوز المتبقي",
          `الرد كان: ${overpayRes.status}`
        );
        failed++;
      }

      // ----------------------------------------------------
      // 7. دفع جزئي ثانٍ بمبلغ 150 ج.م
      // ----------------------------------------------------
      const payPartial2 = await request(
        "/payments/record",
        {
          method: "POST",
          body: {
            invoice_id: mainInvoiceId,
            amount: 150,
            payment_method: "bank_transfer",
          },
        },
        token
      );
      if (
        payPartial2.status === 201 &&
        payPartial2.data.invoice_status === "partially_paid" &&
        Number(payPartial2.data.remaining_amount) === 200
      ) {
        logPass(
          "تسجيل دفعة جزئية ثانية وتحديث المتبقي",
          "المتبقي الآن: 200 ج.م"
        );
        passed++;
      } else {
        logFail("فشل تسجيل الدفعة الجزئية الثانية", payPartial2.data?.error);
        failed++;
      }

      // ----------------------------------------------------
      // 8. سداد باقي المبلغ بالكامل (200 ج.م) والتحقق من حالة paid
      // ----------------------------------------------------
      const payFinal = await request(
        "/payments/record",
        {
          method: "POST",
          body: {
            invoice_id: mainInvoiceId,
            amount: 200,
            payment_method: "card",
          },
        },
        token
      );
      if (
        payFinal.status === 201 &&
        payFinal.data.invoice_status === "paid" &&
        Number(payFinal.data.remaining_amount) === 0
      ) {
        logPass("سداد كامل الفاتورة والتحول لحالة paid", "المتبقي: 0 ج.م");
        passed++;
      } else {
        logFail("فشل سداد باقي الفاتورة", payFinal.data?.error);
        failed++;
      }

      // ----------------------------------------------------
      // 9. DB Verification: التحقق المباشر من جداول الداتابيز
      // ----------------------------------------------------
      const dbInvoiceRes = await pool.query(
        "SELECT status, total_amount FROM invoices WHERE id = $1",
        [mainInvoiceId]
      );
      const dbPaymentsRes = await pool.query(
        "SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE invoice_id = $1 AND status = 'paid'",
        [mainInvoiceId]
      );
      const dbInv = dbInvoiceRes.rows[0];
      const dbPay = dbPaymentsRes.rows[0];

      if (
        dbInv.status === "paid" &&
        Number(dbInv.total_amount) === 500 &&
        Number(dbPay.total_paid) === 500 &&
        Number(dbPay.count) === 3 // دفعة فورية + دفعتين لاحقتين
      ) {
        logPass(
          "DB Verification: تطابق مالي 100% في قاعدة البيانات",
          `إجمالي: ${dbInv.total_amount} ج.م | مدفوع بالداتابيز: ${dbPay.total_paid} ج.م عبر 3 دفعات`
        );
        passed++;
      } else {
        logFail(
          "DB Verification: تضارب في أرقام قاعدة البيانات",
          JSON.stringify({ dbInv, dbPay })
        );
        failed++;
      }

      // ----------------------------------------------------
      // 10. Audit Logs Verification: التحقق من توثيق الرقابة
      // ----------------------------------------------------
      const auditRes = await pool.query(
        "SELECT action FROM audit_logs WHERE entity_id = $1",
        [mainInvoiceId]
      );
      const auditActions = auditRes.rows.map((r) => r.action);
      const hasCreateInvoice = auditActions.includes("CREATE_INVOICE");
      const hasRecordPayment = auditActions.includes("RECORD_PAYMENT");

      if (hasCreateInvoice && hasRecordPayment) {
        logPass("DB Verification: توثيق عمليات الفاتورة والدفع في audit_logs");
        passed++;
      } else {
        logFail(
          "DB Verification: غياب سجلات الرقابة للفاتورة",
          `الموجود: ${auditActions.join(", ")}`
        );
        failed++;
      }

      // ----------------------------------------------------
      // 11. محاولة إلغاء فاتورة مسددة
      // ----------------------------------------------------
      const cancelPaidRes = await request(
        `/invoices/${mainInvoiceId}/cancel`,
        { method: "PATCH" },
        token
      );
      if (cancelPaidRes.status === 404 || cancelPaidRes.status === 400) {
        logPass("منع إلغاء فاتورة مسددة", "تم الرفض بنجاح");
        passed++;
      } else {
        logFail(
          "ثغرة: تم إلغاء فاتورة مسددة",
          `الرد كان: ${cancelPaidRes.status}`
        );
        failed++;
      }

      // ----------------------------------------------------
      // 12. أرشفة الفاتورة المسددة بنجاح
      // ----------------------------------------------------
      const archiveRes = await request(
        `/invoices/${mainInvoiceId}/archive`,
        { method: "PATCH" },
        token
      );
      if (
        archiveRes.status === 200 &&
        archiveRes.data.invoice?.is_archived === true
      ) {
        logPass("أرشفة الفاتورة المسددة بنجاح");
        passed++;
      } else {
        logFail("فشل أرشفة الفاتورة المسددة", archiveRes.data?.error);
        failed++;
      }
    }

    // ----------------------------------------------------
    // 13. Concurrency Test: اختبار الدفع المزدوج المتزامن (Race Condition)
    // ----------------------------------------------------
    console.log(
      `\n${colors.bold}⚡ اختبار التزامن ومنع الـ Double Payment:${colors.reset}`
    );
    const concInvRes = await request(
      "/invoices",
      {
        method: "POST",
        body: {
          patient_id: testPatientId,
          items: [
            { description: "اختبار تزامن", quantity: 1, unit_price: 100 },
          ],
        },
      },
      token
    );
    if (concInvRes.status === 201 && concInvRes.data.invoice?.id) {
      const concId = concInvRes.data.invoice.id;
      createdInvoiceIds.push(concId);

      // إرسال طلبين دفع متزامنين في نفس اللحظة كل منهما بقيمة 100 ج.م
      const [pay1, pay2] = await Promise.all([
        request(
          "/payments/record",
          {
            method: "POST",
            body: { invoice_id: concId, amount: 100, payment_method: "cash" },
          },
          token
        ),
        request(
          "/payments/record",
          {
            method: "POST",
            body: { invoice_id: concId, amount: 100, payment_method: "cash" },
          },
          token
        ),
      ]);

      const isSuccess = (status) => status === 200 || status === 201;
      const oneAcceptedOneRejected =
        (isSuccess(pay1.status) && pay2.status === 400) ||
        (isSuccess(pay2.status) && pay1.status === 400);
      const bothAccepted = isSuccess(pay1.status) && isSuccess(pay2.status);

      if (oneAcceptedOneRejected) {
        logPass(
          "حماية الـ Concurrency المالية ناجحة 100%",
          "طلب واحد قُبل والآخر رُفض بـ 400"
        );
        passed++;
      } else if (bothAccepted) {
        logFail(
          "ثغرة Concurrency خطيرة: تم قبول الدفعتين المتزامنتين معاً",
          `ردود: ${pay1.status}, ${pay2.status}`
        );
        failed++;
      } else {
        logFail(
          "نتيجة غير متوقعة في اختبار التزامن",
          `pay1: ${pay1.status}, pay2: ${pay2.status}`
        );
        failed++;
      }

      // التحقق من أن إجمالي المدفوع في الداتابيز لم يتجاوز 100 ج.م
      const dbConcPay = await pool.query(
        "SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE invoice_id = $1 AND status = 'paid'",
        [concId]
      );
      if (Number(dbConcPay.rows[0].total_paid) === 100) {
        logPass(
          "DB Verification: رصيد الفاتورة بعد التزامن 100 ج.م بالضبط بدون زيادة"
        );
        passed++;
      } else {
        logFail(
          "DB Verification: خلل في رصيد الفاتورة بعد التزامن",
          `المدفوع الفعلي: ${dbConcPay.rows[0].total_paid}`
        );
        failed++;
      }
    } else {
      logFail(
        "فشل إنشاء فاتورة اختبار التزامن",
        concInvRes.data?.error || `الرد كان: ${concInvRes.status}`
      );
      failed++;
    }

    // ----------------------------------------------------
    // 14. تجربة الفاتورة الصفرية (0 EGP) والتأكد أنها تبدأ paid
    // ----------------------------------------------------
    const zeroInvRes = await request(
      "/invoices",
      {
        method: "POST",
        body: {
          patient_id: testPatientId,
          items: [
            { description: "استشارة مجانية", quantity: 1, unit_price: 0 },
          ],
        },
      },
      token
    );
    if (zeroInvRes.status === 201) {
      createdInvoiceIds.push(zeroInvRes.data.invoice.id);
      if (zeroInvRes.data.invoice.status === "paid") {
        logPass("الفاتورة الصفرية تبدأ بحالة paid مباشرة");
        passed++;
      } else {
        logFail(
          "الفاتورة الصفرية لم تبدأ بحالة paid",
          `الحالة: ${zeroInvRes.data.invoice.status}`
        );
        failed++;
      }
    }

    // ----------------------------------------------------
    // 15. إنشاء فاتورة غير مدفوعة وإلغاؤها بنجاح
    // ----------------------------------------------------
    const unpaidInvRes = await request(
      "/invoices",
      {
        method: "POST",
        body: {
          patient_id: testPatientId,
          items: [{ description: "إجراء مؤجل", quantity: 1, unit_price: 250 }],
        },
      },
      token
    );
    if (unpaidInvRes.status === 201) {
      const unpaidId = unpaidInvRes.data.invoice.id;
      createdInvoiceIds.push(unpaidId);
      const cancelUnpaid = await request(
        `/invoices/${unpaidId}/cancel`,
        { method: "PATCH" },
        token
      );
      if (
        cancelUnpaid.status === 200 &&
        cancelUnpaid.data.invoice?.status === "cancelled"
      ) {
        logPass("إلغاء فاتورة غير مسددة بنجاح وفك ارتباطاتها");
        passed++;
      } else {
        logFail("فشل إلغاء الفاتورة غير المسددة", cancelUnpaid.data?.error);
        failed++;
      }
    }
  } catch (error) {
    console.error(
      `${colors.red}خطأ أثناء تنفيذ الاختبارات المالية:${colors.reset}`,
      error.message
    );
    failed++;
  } finally {
    // ----------------------------------------------------
    // 16. تنظيف كل بيانات الاختبار من الداتابيز
    // ----------------------------------------------------
    console.log("\n🧹 جاري تنظيف بيانات الاختبار...");
    if (createdInvoiceIds.length > 0) {
      try {
        await pool.query(
          "DELETE FROM payments WHERE invoice_id = ANY($1::uuid[])",
          [createdInvoiceIds]
        );
        await pool.query(
          "DELETE FROM invoice_items WHERE invoice_id = ANY($1::uuid[])",
          [createdInvoiceIds]
        );
        await pool.query(
          "DELETE FROM audit_logs WHERE entity_id::text = ANY($1::text[])",
          [createdInvoiceIds]
        );
        await pool.query("DELETE FROM invoices WHERE id = ANY($1::uuid[])", [
          createdInvoiceIds,
        ]);
      } catch (e) {
        console.error("فشل تنظيف الفواتير:", e.message);
      }
    }
    if (testPatientId) {
      try {
        await pool.query("DELETE FROM audit_logs WHERE entity_id::text = $1", [
          testPatientId,
        ]);
        await pool.query("DELETE FROM patients WHERE id = $1", [testPatientId]);
      } catch (e) {
        console.error("فشل تنظيف المريض التجريبي:", e.message);
      }
    }
    await pool.end();
  }

  // ----------------------------------------------------
  // الملخص
  // ----------------------------------------------------
  console.log("\n--------------------------------------------------------");
  console.log(`${colors.bold}نتائج الاختبارات المالية الكاملة:${colors.reset}`);
  console.log(`Passed: ${passed} / Failed: ${failed}`);
  console.log("--------------------------------------------------------\n");

  process.exitCode = failed > 0 ? 1 : 0;
}

runFinancialTests();
