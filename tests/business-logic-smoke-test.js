/**
 * CUROSTA SaaS - Phase 6
 * Test #3: Critical Business Logic & Race Conditions
 *
 * التشغيل:
 * node tests/business-logic-smoke-test.js
 *
 * Localhost فقط
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

const logSkip = (title, reason) =>
  console.log(
    `${colors.yellow}  ⚠ [SKIPPED]${colors.reset} ${title} -> ${reason}`
  );

async function getAuthToken(email, password) {
  try {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json().catch(() => ({}));

    return res.status === 200 ? data.token : null;
  } catch {
    return null;
  }
}

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function runBusinessLogicTests() {
  console.log("\n========================================================");
  console.log(
    `${colors.bold}${colors.cyan}⚡ Test #3: Critical Business Logic & Race Conditions${colors.reset}`
  );
  console.log("========================================================\n");

  // ----------------------------------------------------
  // Localhost safety check
  // ----------------------------------------------------
  try {
    const targetUrl = new URL(BASE_URL);

    const isLocalhost =
      targetUrl.hostname === "localhost" || targetUrl.hostname === "127.0.0.1";

    if (!isLocalhost) {
      console.error(
        `${colors.red}خطأ أمني: الاختبار مخصص لـ Localhost فقط: ${BASE_URL}${colors.reset}\n`
      );
      process.exit(1);
    }
  } catch {
    console.error(`${colors.red}الرابط غير صالح: ${BASE_URL}${colors.reset}\n`);
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  try {
    // ----------------------------------------------------
    // Authentication
    // ----------------------------------------------------
    const token =
      process.env.TEST_USER_TOKEN ||
      (process.env.TEST_USER_EMAIL && process.env.TEST_USER_PASSWORD
        ? await getAuthToken(
            process.env.TEST_USER_EMAIL,
            process.env.TEST_USER_PASSWORD
          )
        : null);

    // ====================================================
    // TEST #1 - Concurrent Appointment Overlap
    // ====================================================
    console.log(
      `${colors.bold}1. فحص منع الحجز المتزامن لنفس الدكتور:${colors.reset}`
    );

    const doctorId = process.env.TEST_DOCTOR_ID;
    const patientId = process.env.TEST_PATIENT_ID;

    if (!token || !doctorId || !patientId) {
      logSkip(
        "منع الحجز المزدوج",
        "يحتاج TEST_USER_TOKEN أو TEST_USER_EMAIL/PASSWORD + TEST_DOCTOR_ID + TEST_PATIENT_ID"
      );
      skipped++;
    } else {
      const createdAppointmentIds = [];

      const testDate = new Date();
      testDate.setDate(testDate.getDate() + 40);
      testDate.setHours(11, 0, 0, 0);

      const appointmentDateStr = testDate.toISOString();

      const appointmentPayload = {
        doctor_id: doctorId,
        patient_id: patientId,
        appointment_date: appointmentDateStr,
        duration_minutes: 30,
        notes: "CUROSTA-RACE-TEST",
      };

      try {
        const [res1, res2] = await Promise.all([
          fetch(`${BASE_URL}/appointments`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(appointmentPayload),
          }),

          fetch(`${BASE_URL}/appointments`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(appointmentPayload),
          }),
        ]);

        const [body1, body2] = await Promise.all([
          readJsonSafe(res1),
          readJsonSafe(res2),
        ]);

        const isCreated = (status) => status === 200 || status === 201;

        if (isCreated(res1.status)) {
          const id = body1.appointment?.id || body1.id;

          if (id) {
            createdAppointmentIds.push(id);
          }
        }

        if (isCreated(res2.status)) {
          const id = body2.appointment?.id || body2.id;

          if (id) {
            createdAppointmentIds.push(id);
          }
        }

        const oneSuccessOneConflict =
          (isCreated(res1.status) && res2.status === 409) ||
          (isCreated(res2.status) && res1.status === 409);

        const bothSuccessful = isCreated(res1.status) && isCreated(res2.status);

        if (oneSuccessOneConflict) {
          logPass(
            "حماية الـ Double-Booking ناجحة",
            "طلب واحد نجح والآخر رُفض بـ 409"
          );
          passed++;
        } else if (bothSuccessful) {
          logFail(
            "ثغرة Double-Booking",
            "تم قبول الطلبين المتزامنين لنفس الدكتور"
          );
          failed++;
        } else {
          logFail(
            "نتيجة غير متوقعة في اختبار المواعيد",
            `ردود الطلبات: ${res1.status}, ${res2.status}`
          );
          failed++;
        }
      } catch (err) {
        logFail("فشل اختبار تداخل المواعيد", err.message);
        failed++;
      } finally {
        // حذف أي موعد أنشأه الاختبار
        if (createdAppointmentIds.length > 0) {
          try {
            await pool.query(
              `DELETE FROM appointments
               WHERE id = ANY($1::uuid[])`,
              [createdAppointmentIds]
            );
          } catch (cleanupErr) {
            console.error("فشل تنظيف مواعيد الاختبار:", cleanupErr.message);
          }
        }

        // Fallback cleanup لو الـ API لم يرجع ID
        try {
          await pool.query(
            `DELETE FROM appointments
             WHERE doctor_id = $1
               AND appointment_date = $2
               AND notes = 'CUROSTA-RACE-TEST'`,
            [doctorId, appointmentDateStr]
          );
        } catch (cleanupErr) {
          console.error("فشل التنظيف الإضافي للمواعيد:", cleanupErr.message);
        }
      }
    }

    // ====================================================
    // TEST #2 - Concurrent Overpayment
    // ====================================================
    console.log(
      `\n${colors.bold}2. فحص منع الدفع الزائد بالتزامن:${colors.reset}`
    );

    const invoiceId = process.env.TEST_INVOICE_ID;

    const paymentEndpoint =
      process.env.TEST_PAYMENT_URL || `${BASE_URL}/payments/record`;

    if (!token || !invoiceId) {
      logSkip(
        "منع الـ Overpayment",
        "يحتاج TEST_USER_TOKEN أو TEST_USER_EMAIL/PASSWORD + TEST_INVOICE_ID"
      );
      skipped++;
    } else {
      let originalInvoice = null;
      let originalPaymentIds = [];
      const testStartedAt = new Date();

      try {
        // 1. جلب الفاتورة وحساب المدفوع فعلياً من payments
        const invRes = await pool.query(
          `SELECT
             i.id,
             i.clinic_id,
             i.total_amount,
             i.status,
             i.is_archived,
             COALESCE(
               SUM(
                 CASE
                   WHEN p.status = 'paid' THEN p.amount
                   ELSE 0
                 END
               ),
               0
             ) AS paid_amount
           FROM invoices i
           LEFT JOIN payments p
             ON p.invoice_id = i.id
            AND p.clinic_id = i.clinic_id
           WHERE i.id = $1
           GROUP BY
             i.id,
             i.clinic_id,
             i.total_amount,
             i.status,
             i.is_archived`,
          [invoiceId]
        );

        if (invRes.rows.length === 0) {
          throw new Error(`الفاتورة ${invoiceId} غير موجودة`);
        }

        originalInvoice = invRes.rows[0];

        if (originalInvoice.is_archived) {
          logSkip(
            "منع الـ Overpayment",
            "الفاتورة المختارة مؤرشفة. اختر فاتورة اختبار نشطة."
          );
          skipped++;
        } else if (Number(originalInvoice.paid_amount) !== 0) {
          logSkip(
            "منع الـ Overpayment",
            "الفاتورة المختارة عليها دفعات سابقة. اختر فاتورة رصيدها المسدد = 0."
          );
          skipped++;
        } else {
          // 2. حفظ كل payments الموجودة قبل الاختبار
          const existingPaymentsRes = await pool.query(
            `SELECT id
             FROM payments
             WHERE invoice_id = $1`,
            [invoiceId]
          );

          originalPaymentIds = existingPaymentsRes.rows.map((row) => row.id);

          // 3. جعل إجمالي الفاتورة 100 ج.م مؤقتاً
          await pool.query(
            `UPDATE invoices
             SET total_amount = 100
             WHERE id = $1`,
            [invoiceId]
          );

          const paymentPayload = {
            invoice_id: invoiceId,
            amount: 100,
            payment_method: process.env.TEST_PAYMENT_METHOD || "cash",
          };

          const [payRes1, payRes2] = await Promise.all([
            fetch(paymentEndpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify(paymentPayload),
            }),

            fetch(paymentEndpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify(paymentPayload),
            }),
          ]);

          const successfulStatus = (status) => status === 200 || status === 201;

          const oneSuccessOneReject =
            (successfulStatus(payRes1.status) && payRes2.status === 400) ||
            (successfulStatus(payRes2.status) && payRes1.status === 400);

          const bothSuccessful =
            successfulStatus(payRes1.status) &&
            successfulStatus(payRes2.status);

          if (oneSuccessOneReject) {
            logPass(
              "حماية الـ Overpayment ناجحة",
              "دفعة واحدة قُبلت والثانية رُفضت بـ 400"
            );
            passed++;
          } else if (bothSuccessful) {
            logFail("ثغرة Overpayment خطيرة", "تم قبول الدفعتين المتزامنتين");
            failed++;
          } else {
            logFail(
              "نتيجة غير متوقعة في اختبار الدفع",
              `ردود الطلبات: ${payRes1.status}, ${payRes2.status}`
            );
            failed++;
          }
        }
      } catch (err) {
        logFail("فشل اختبار الـ Overpayment", err.message);
        failed++;
      } finally {
        // تنظيف واسترجاع الفاتورة
        if (originalInvoice) {
          try {
            // جلب كل payments بعد الاختبار
            const currentPaymentsRes = await pool.query(
              `SELECT id
               FROM payments
               WHERE invoice_id = $1`,
              [invoiceId]
            );

            const newPaymentIds = currentPaymentsRes.rows
              .map((row) => row.id)
              .filter((id) => !originalPaymentIds.includes(id));

            // حذف payments الجديدة فقط
            if (newPaymentIds.length > 0) {
              await pool.query(
                `DELETE FROM payments
                 WHERE id = ANY($1::uuid[])`,
                [newPaymentIds]
              );
            }

            // استرجاع الفاتورة بالكامل
            await pool.query(
              `UPDATE invoices
               SET total_amount = $1,
                   status = $2
               WHERE id = $3`,
              [originalInvoice.total_amount, originalInvoice.status, invoiceId]
            );
          } catch (cleanupErr) {
            console.error(
              "فشل تنظيف/استرجاع بيانات الفاتورة:",
              cleanupErr.message
            );
          }
        }
      }
    }
  } finally {
    await pool.end();
  }

  // ----------------------------------------------------
  // Summary
  // ----------------------------------------------------
  console.log("\n--------------------------------------------------------");

  console.log(`${colors.bold}نتائج اختبار الـ Business Logic:${colors.reset}`);

  console.log(`passed: ${passed} / failed: ${failed} / skipped: ${skipped}`);

  console.log("--------------------------------------------------------\n");

  process.exitCode = failed > 0 ? 1 : 0;
}

runBusinessLogicTests().catch((err) => {
  console.error(`${colors.red}خطأ غير متوقع في الاختبار:${colors.reset}`, err);

  process.exitCode = 1;
});
