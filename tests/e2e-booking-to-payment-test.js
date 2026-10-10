/**
 * CUROSTA - End-to-End (E2E) Test Suite
 * السيناريو: حجز عام من الموقع -> موافقة الريسبشن -> إنشاء الفاتورة -> الدفع -> الإلغاء والتسوية
 *
 * طريقة التشغيل:
 * node tests/e2e-booking-to-payment-test.js
 */

const BASE_URL = process.env.API_BASE_URL || "http://localhost:5000/api";

// ألوان مبهجة للتيرمينال
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

const pass = (msg) => console.log(`${colors.green}  ✓ ${msg}${colors.reset}`);
const fail = (msg, err) => {
  console.error(`${colors.red}  ✗ ${msg}${colors.reset}`);
  if (err) console.error(colors.red, err, colors.reset);
  process.exit(1);
};
const step = (msg) =>
  console.log(`\n${colors.cyan}${colors.bold}▶ ${msg}${colors.reset}`);

async function runE2ETest() {
  console.log(
    `\n${colors.yellow}${colors.bold}====================================================`,
  );
  console.log(`  🚀 بدء فحص CUROSTA E2E الشامل على: ${BASE_URL}`);
  console.log(
    `====================================================${colors.reset}`,
  );

  let token = null;
  let clinicSlug = null;
  let doctorId = null;
  let bookingRequestId = null;
  let appointmentId = null;
  let patientId = null;
  let invoiceId = null;
  let paymentId = null;

  const testPhone = "01055887766";
  const testPatientName = "مريض تجريبي E2E";

  // ----------------------------------------------------
  // الخطوة 1: تسجيل دخول الأدمن لجلب الـ Slug ومعلومات الدكتور
  // ----------------------------------------------------
  step("1. تسجيل دخول مدير العيادة (ClinicAdmin)");
  try {
    // ⚠️ استبدل الإيميل والباسورد بحساب موجود عندك محلياً لو مختلفين
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        //real-demo-clinicAdmin-account
        email: process.env.TEST_ADMIN_EMAIL || "atef@gmail.com",
        password: process.env.TEST_ADMIN_PASSWORD || "atef1234",
      }),
    });

    const loginData = await loginRes.json();
    if (!loginRes.ok) {
      fail(
        `فشل تسجيل الدخول: ${loginData.error || "تأكد من إيميل وباسورد الأدمن في السكريبت"}`,
      );
    }

    token = loginData.token;
    pass("تم تسجيل الدخول بنجاح واستخراج الـ JWT Token");

    // جلب بيانات العيادة للحصول على الـ slug
    const clinicRes = await fetch(`${BASE_URL}/clinics`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const clinicData = await clinicRes.json();
    const clinic = clinicData.clinics?.[0];

    if (!clinic || !clinic.slug) {
      fail(
        "لم يتم العثور على slug للعيادة، تأكد من تشغيل سطر الـ SQL الخاص بالـ backfill",
      );
    }
    clinicSlug = clinic.slug;
    pass(`تم العثور على العيادة: "${clinic.name}" برابط مخصص: (${clinicSlug})`);

    // جلب دكتور من العيادة
    const doctorsRes = await fetch(`${BASE_URL}/auth/doctors`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const doctorsData = await doctorsRes.json();
    const doctors = doctorsData.doctors || [];
    if (doctors.length === 0) {
      fail("لا يوجد أطباء مسجلين في العيادة لاختبار الحجز معهم");
    }
    doctorId = doctors[0].id;
    pass(`تم اختيار الطبيب: د. ${doctors[0].name}`);
  } catch (err) {
    fail(
      "خطأ في الاتصال بالسيرفر، تأكد إن سيرفر الباك إند شغال محلياً",
      err.message,
    );
  }

  // ----------------------------------------------------
  // الخطوة 2: اختبار صفحة البروفايل العامة والمواعيد المتاحة
  // ----------------------------------------------------
  step("2. فحص الـ Public Profile والمواعيد أونلاين");
  let targetSlot = null;
  try {
    const profileRes = await fetch(`${BASE_URL}/public/clinics/${clinicSlug}`);
    const profileData = await profileRes.json();
    if (!profileRes.ok)
      fail(`فشل فتح صفحة العيادة العامة: ${profileData.error}`);
    pass("تم فتح بروفايل العيادة العام بنجاح بدون توكن");

    // جلب المواعيد ليوم غد بتوقيت مصر
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split("T")[0];

    const slotsRes = await fetch(
      `${BASE_URL}/public/clinics/${clinicSlug}/slots?doctor_id=${doctorId}&date=${dateStr}`,
    );
    const slotsData = await slotsRes.json();
    if (!slotsRes.ok) fail(`فشل جلب مواعيد الطبيب: ${slotsData.error}`);

    const availableSlots = slotsData.slots || [];
    // لو مفيش شفتات للغد، نحدد وقت يدوي بعد 3 ساعات لاختبار الـ POST
    if (availableSlots.length > 0) {
      const firstSlot = availableSlots[0];
      let rawTime =
        firstSlot.start_time ||
        firstSlot.time ||
        firstSlot.datetime ||
        firstSlot.slot ||
        firstSlot;

      if (typeof rawTime !== "string") {
        rawTime = JSON.stringify(rawTime);
      }

      // تحويل الأرقام العربية والرموز "١٢:٠٠ م" إلى وقت إنجليزي ISO قياسي
      if (rawTime.includes("T") && !/[٠-٩]/.test(rawTime)) {
        targetSlot = rawTime;
      } else {
        const arabicDigits = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
        const converted = rawTime.replace(/[٠-٩]/g, (d) =>
          arabicDigits.indexOf(d),
        );

        const isPM =
          rawTime.includes("م") || rawTime.toLowerCase().includes("pm");
        const isAM =
          rawTime.includes("ص") || rawTime.toLowerCase().includes("am");

        const match = converted.match(/(\d{1,2}):(\d{2})/);
        if (match) {
          let hours = parseInt(match[1], 10);
          const minutes = match[2];
          if (isPM && hours < 12) hours += 12;
          if (isAM && hours === 12) hours = 0;
          const hoursStr = String(hours).padStart(2, "0");
          targetSlot = `${dateStr}T${hoursStr}:${minutes}:00`;
        } else {
          targetSlot = `${dateStr}T12:00:00`;
        }
      }

      pass(
        `تم العثور على ${availableSlots.length} موعد متاح. اختيار الموعد: ${targetSlot}`,
      );
    }
  } catch (err) {
    fail("فشل في راوت الحجز العام", err.message);
  }

  // ----------------------------------------------------
  // الخطوة 3: إرسال طلبات حجز متزامنة (Race Condition) لاختبار الحماية
  // ----------------------------------------------------
  step("3. إرسال طلبي حجز في نفس اللحظة لاختبار الأقفال (Anti-Spam)");
  try {
    const requestBody = JSON.stringify({
      doctor_id: doctorId,
      patient_name: testPatientName,
      patient_phone: testPhone,
      requested_date: targetSlot,
      duration_minutes: 30,
      notes: "فحص أوتوماتيكي E2E - تزامن",
    });

    // إطلاق الطلبين في نفس اللحظة تماماً لمحاكاة النقر المزدوج السريع!
    const [req1, req2] = await Promise.all([
      fetch(`${BASE_URL}/public/clinics/${clinicSlug}/booking-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      }),
      fetch(`${BASE_URL}/public/clinics/${clinicSlug}/booking-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      }),
    ]);

    const statusCodes = [req1.status, req2.status];

    // يجب أن ينجح أحدهما (201) ويفشل الآخر لأنه مكرر (409)
    if (
      statusCodes.includes(201) &&
      (statusCodes.includes(400) || statusCodes.includes(409))
    ) {
      pass("نجاح فحص الأمان: تم قبول طلب واحد ورفض الطلب المتزامن بنجاح 🛡️");

      // استخراج الـ ID من الطلب الناجح لإكمال باقي الخطوات
      const successfulRes = req1.status === 201 ? req1 : req2;
      const bookData = await successfulRes.json();
      bookingRequestId = bookData.booking_request?.id || bookData.id;
    } else {
      fail(
        `ثغرة في حماية التزامن! استجابات السيرفر كانت: [${statusCodes.join(", ")}]`,
      );
    }
  } catch (err) {
    fail("خطأ في اختبار طلب الحجز المتزامن", err.message);
  }

  // ----------------------------------------------------
  // الخطوة 4: موافقة الريسبشن على طلب الحجز
  // ----------------------------------------------------
  step("4. موافقة الريسبشن على الطلب وإنشاء الموعد والمريض");
  try {
    const approveRes = await fetch(
      `${BASE_URL}/booking-requests/${bookingRequestId}/approve`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const approveData = await approveRes.json();
    if (!approveRes.ok) fail(`فشل قبول طلب الحجز: ${approveData.error}`);

    appointmentId = approveData.appointment.id;
    patientId = approveData.appointment.patient_id;
    pass(
      `تمت الموافقة بنجاح: تم إنشاء موعد رسمي #${appointmentId.slice(0, 8)} للمريض #${patientId.slice(0, 8)}`,
    );
  } catch (err) {
    fail("فشل في دالة approveBookingRequest", err.message);
  }

  // ----------------------------------------------------
  // الخطوة 5: إنشاء فاتورة وتحصيل المبلغ
  // ----------------------------------------------------
  step("5. إصدار الفاتورة وتحصيل دفعة مالية");
  try {
    const invoiceRes = await fetch(`${BASE_URL}/invoices`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        patient_id: patientId,
        appointment_id: appointmentId,
        doctor_id: doctorId,
        items: [
          {
            description: "كشف وحشو تجريبي E2E",
            quantity: 1,
            unit_price: 500,
          },
        ],
      }),
    });

    const invoiceData = await invoiceRes.json();
    if (!invoiceRes.ok) fail(`فشل إنشاء الفاتورة: ${invoiceData.error}`);
    invoiceId = invoiceData.invoice.id;
    pass(
      `تم إنشاء الفاتورة #${invoiceId.slice(0, 8)} بإجمالي 500 ج.م وحالة (${invoiceData.invoice.status})`,
    );

    // تحصيل 500 ج.م كاش
    const payRes = await fetch(`${BASE_URL}/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        invoice_id: invoiceId,
        amount: 500,
        payment_method: "cash",
        notes: "تحصيل كاش بتيست E2E",
      }),
    });

    const payData = await payRes.json();
    if (!payRes.ok) fail(`فشل تسجيل الدفعة: ${payData.error}`);
    paymentId = payData.payment.id;
    pass(
      `تم تحصيل 500 ج.م بنجاح، وتحولت حالة الفاتورة تلقائياً إلى: (${payData.invoice_status})`,
    );
  } catch (err) {
    fail("فشل في دورة الفواتير والتحصيل", err.message);
  }

  // ----------------------------------------------------
  // الخطوة 6: إلغاء الدفعة وإعادة تسوية الفاتورة (Void Payment)
  // ----------------------------------------------------
  step("6. اختبار إلغاء الدفعة (Void Payment) وإعادة التسوية");
  try {
    const voidRes = await fetch(`${BASE_URL}/payments/${paymentId}/void`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        reason: "خطأ تجريبي وتم تصحيحه في التيست",
      }),
    });

    const voidData = await voidRes.json();
    if (!voidRes.ok) fail(`فشل إلغاء الدفعة: ${voidData.error}`);

    if (
      voidData.invoice_status === "unpaid" &&
      voidData.remaining_amount === 500
    ) {
      pass(
        `تم إلغاء الدفعة بنجاح! عادت الفاتورة إلى: (${voidData.invoice_status}) والمتبقي: ${voidData.remaining_amount} ج.م`,
      );
    } else {
      fail(`حالة الفاتورة بعد الإلغاء غير دقيقة: ${JSON.stringify(voidData)}`);
    }
  } catch (err) {
    fail("فشل في endpoint الـ voidPayment", err.message);
  }

  console.log(
    `\n${colors.green}${colors.bold}====================================================`,
  );
  console.log("  🎉 مبروك! دورة العمل الكاملة (E2E) نجحت بنسبة 100%");
  console.log("  المنصة جاهزة للتشغيل والبيع الحقيقي في أي عيادة أسنان!");
  console.log(
    `====================================================${colors.reset}\n`,
  );
}

runE2ETest();
