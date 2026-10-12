require("dotenv").config();
const pool = require("../db");
const bcrypt = require("bcrypt");

const seedDemoClinic = async () => {
  const client = await pool.connect();
  try {
    console.log("⏳ جاري تنظيف وبناء الحساب التجريبي المحدث (CUROSTA Demo)...");
    await client.query("BEGIN");

    // 1. فحص هل عيادة الديمو موجودة مسبقاً لحذف بياناتها بالترتيب العكسي للـ Foreign Keys
    const existingClinicRes = await client.query(
      "SELECT id FROM clinics WHERE slug = 'curosta-demo';",
    );

    if (existingClinicRes.rows.length > 0) {
      const clinicId = existingClinicRes.rows[0].id;
      // ترتيب الحذف الدقيق لمنع كسر أي Foreign Key
      await client.query("DELETE FROM support_tickets WHERE clinic_id = $1;", [
        clinicId,
      ]);
      await client.query("DELETE FROM prescriptions WHERE clinic_id = $1;", [
        clinicId,
      ]);
      await client.query("DELETE FROM payments WHERE clinic_id = $1;", [
        clinicId,
      ]);
      await client.query("DELETE FROM invoice_items WHERE clinic_id = $1;", [
        clinicId,
      ]);
      await client.query("DELETE FROM invoices WHERE clinic_id = $1;", [
        clinicId,
      ]);
      await client.query("DELETE FROM lab_orders WHERE clinic_id = $1;", [
        clinicId,
      ]);
      await client.query("DELETE FROM booking_requests WHERE clinic_id = $1;", [
        clinicId,
      ]);
      await client.query("DELETE FROM appointments WHERE clinic_id = $1;", [
        clinicId,
      ]);
      await client.query("DELETE FROM doctor_leaves WHERE clinic_id = $1;", [
        clinicId,
      ]);
      await client.query(
        "DELETE FROM doctor_availability WHERE clinic_id = $1;",
        [clinicId],
      );
      await client.query("DELETE FROM procedure_codes WHERE clinic_id = $1;", [
        clinicId,
      ]);
      await client.query("DELETE FROM patients WHERE clinic_id = $1;", [
        clinicId,
      ]);
      await client.query("DELETE FROM users WHERE clinic_id = $1;", [clinicId]);
      await client.query("DELETE FROM clinics WHERE id = $1;", [clinicId]);
    }

    // 2. إنشاء عيادة الديمو باشتراك سنوي سارٍ
    const clinicRes = await client.query(
      `INSERT INTO clinics (
        name,
        slug,
        phone_number,
        address,
        bio,
        is_active,
        subscription_plan,
        subscription_status,
        subscription_starts_at,
        subscription_ends_at,
        default_appointment_duration
      ) VALUES (
        'مركز كوروستا التخصصي لطب الأسنان (تجريبي)',
        'curosta-demo',
        '01012345678',
        'ميدان المساحة، الدقي، الجيزة',
        'مركز متكامل لجراحة وزراعة وتجميل الأسنان وعلاج الجذور بأحدث التقنيات.',
        TRUE,
        'yearly',
        'active',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '1 year',
        30
      ) RETURNING id;`,
    );
    const clinicId = clinicRes.rows[0].id;

    // 3. إنشاء حسابين (مدير العيادة + طبيب معالج)
    const salt = await bcrypt.genSalt(10);
    const demoPassword = await bcrypt.hash("Demo@123456", salt);

    // حساب المدير الأساسي للديمو
    const adminRes = await client.query(
      `INSERT INTO users (clinic_id, name, email, password, role, is_active)
       VALUES ($1, 'د. حازم القاضي (المدير)', 'demo@curosta.com', $2, 'ClinicAdmin', TRUE)
       RETURNING id;`,
      [clinicId, demoPassword],
    );
    const adminId = adminRes.rows[0].id;

    // حساب الطبيب المعالج (عشان الحجز الأونلاين وتقرير الأطباء والـ Onboarding)
    const doctorRes = await client.query(
      `INSERT INTO users (clinic_id, name, email, password, role, is_active)
       VALUES ($1, 'د. سارة أحمد المنشاوي', 'doctor.demo@curosta.com', $2, 'Doctor', TRUE)
       RETURNING id;`,
      [clinicId, demoPassword],
    );
    const doctorId = doctorRes.rows[0].id;

    // 4. إنشاء قائمة الخدمات والأسعار
    const procRes = await client.query(
      `INSERT INTO procedure_codes (clinic_id, code, description, default_price, duration_minutes) VALUES
        ($1, 'CONS-01', 'كشف واستشارة وتشخيص شامل', 200, 20),
        ($1, 'ENDO-01', 'علاج جذور وحشو عصب ضرس خلفي', 1200, 45),
        ($1, 'REST-01', 'حشو تجميلي كومبوزيت ليزر', 600, 30),
        ($1, 'SURG-01', 'خلع ضرس عقل جراحي', 1000, 45),
        ($1, 'SCAL-01', 'تنظيف جير وتلميع وإزالة ترسبات', 500, 30),
        ($1, 'PROS-01', 'تركيبة زيركون ألماني للضرس', 2500, 30)
      RETURNING id, code, default_price;`,
      [clinicId],
    );
    const endoProc = procRes.rows.find((p) => p.code === "ENDO-01");
    const scalProc = procRes.rows.find((p) => p.code === "SCAL-01");

    // 5. شفتات عمل الطبيبة (طوال الأسبوع ما عدا الجمعة من 2 ظهراً لـ 10 مساءً)
    for (let day = 0; day <= 6; day++) {
      if (day !== 5) {
        await client.query(
          `INSERT INTO doctor_availability (clinic_id, doctor_id, day_of_week, start_time, end_time, is_active)
           VALUES ($1, $2, $3, '14:00', '22:00', TRUE);`,
          [clinicId, doctorId, day],
        );
      }
    }

    // 6. إضافة مرضى ببيانات مصرية صحيحة
    const patientsRes = await client.query(
      `INSERT INTO patients (clinic_id, name, phone_number, gender, date_of_birth, medical_alerts, is_active) VALUES
        ($1, 'أحمد محمود إبراهيم', '01098765432', 'Male', '1992-05-14', 'حساسية شديدة من البنسلين ومشتقاته', TRUE),
        ($1, 'سارة عبد الرحمن', '01123456789', 'Female', '1998-11-20', 'ضغط دم منخفض', TRUE),
        ($1, 'محمد طارق حسن', '01234567890', 'Male', '1985-03-01', 'مريض سكري نوع ثاني منتظم', TRUE),
        ($1, 'مريم خالد يوسف', '01555554433', 'Female', '2001-08-15', NULL, TRUE)
      RETURNING id, name;`,
      [clinicId],
    );
    const p1 = patientsRes.rows[0];
    const p2 = patientsRes.rows[1];
    const p3 = patientsRes.rows[2];

    // 7. مواعيد منطقية: موعد مكتمل في الماضي، ومواعيد مجدولة في المستقبل
    const apptRes = await client.query(
      `INSERT INTO appointments (clinic_id, patient_id, doctor_id, appointment_date, duration_minutes, status, notes) VALUES
        ($1, $2, $3, CURRENT_TIMESTAMP - INTERVAL '3 hours', 45, 'completed', 'تمت جلسة حشو العصب بنجاح'),
        ($1, $4, $3, CURRENT_TIMESTAMP + INTERVAL '2 hours', 30, 'scheduled', 'جلسة تنظيف وتلميع أسنان دورية'),
        ($1, $5, $3, CURRENT_TIMESTAMP + INTERVAL '1 day', 45, 'scheduled', 'أخذ مقاسات تركيبة زيركون')
      RETURNING id, patient_id;`,
      [clinicId, p1.id, doctorId, p2.id, p3.id],
    );

    // 8. فواتير ومدفوعات مع بنود الـ invoice_items
    // فاتورة 1: 1200 ج.م، مدفوع 800 وباقي 400
    const inv1Res = await client.query(
      `INSERT INTO invoices (clinic_id, patient_id, appointment_id, total_amount, status)
       VALUES ($1, $2, $3, 1200, 'partially_paid') RETURNING id;`,
      [clinicId, p1.id, apptRes.rows[0].id],
    );
    await client.query(
      `INSERT INTO invoice_items (clinic_id, invoice_id, procedure_code_id, description, quantity, unit_price, total_price)
       VALUES ($1, $2, $3, 'علاج جذور وحشو عصب ضرس خلفي', 1, 1200, 1200);`,
      [clinicId, inv1Res.rows[0].id, endoProc?.id || null],
    );
    await client.query(
      `INSERT INTO payments (clinic_id, invoice_id, amount, payment_method, status, paid_at, created_by)
       VALUES ($1, $2, 800, 'cash', 'paid', CURRENT_TIMESTAMP, $3);`,
      [clinicId, inv1Res.rows[0].id, adminId],
    );

    // فاتورة 2: 500 ج.م مسددة بالكامل
    const inv2Res = await client.query(
      `INSERT INTO invoices (clinic_id, patient_id, appointment_id, total_amount, status)
       VALUES ($1, $2, $3, 500, 'paid') RETURNING id;`,
      [clinicId, p2.id, apptRes.rows[1].id],
    );
    await client.query(
      `INSERT INTO invoice_items (clinic_id, invoice_id, procedure_code_id, description, quantity, unit_price, total_price)
       VALUES ($1, $2, $3, 'تنظيف جير وتلميع وإزالة ترسبات', 1, 500, 500);`,
      [clinicId, inv2Res.rows[0].id, scalProc?.id || null],
    );
    await client.query(
      `INSERT INTO payments (clinic_id, invoice_id, amount, payment_method, status, paid_at, created_by)
       VALUES ($1, $2, 500, 'card', 'paid', CURRENT_TIMESTAMP, $3);`,
      [clinicId, inv2Res.rows[0].id, adminId],
    );

    // 9. طلب معمل بحالة معتمدة
    await client.query(
      `INSERT INTO lab_orders (clinic_id, patient_id, doctor_id, lab_name, case_number, status, expected_at, notes)
       VALUES ($1, $2, $3, 'معمل الدلتا لتركيبات الأسنان', 'CASE-9842', 'sent_to_lab', (CURRENT_TIMESTAMP + INTERVAL '2 days')::date, 'كراون زيركون A2 للضرس 36');`,
      [clinicId, p3.id, doctorId],
    );

    // 10. روشتة طبية متوافقة طبياً (Dalacin C بديل آمن للبنسلين)
    await client.query(
      `INSERT INTO prescriptions (clinic_id, patient_id, doctor_id, prescription_date, diagnosis, medications, instructions)
       VALUES ($1, $2, $3, CURRENT_DATE, 'التهاب عصب ضرس حاد (مريض حساسية بنسلين)', $4, 'ممنوع الأكل على الجانب المعالج لمدة ساعتين - كمادات باردة عند اللزوم');`,
      [
        clinicId,
        p1.id,
        doctorId,
        JSON.stringify([
          {
            name: "Dalacin C 300mg",
            dosage: "كبسولة كل 8 ساعات بعد الأكل",
            duration: "لمدة 5 أيام",
            notes: "بديل آمن لحساسية البنسلين",
          },
          {
            name: "Cataflam 50mg",
            dosage: "قرص كل 8 ساعات بعد الأكل عند اللزوم",
            duration: "لمدة 3 أيام",
            notes: "مسكن ومضاد للالتهاب",
          },
        ]),
      ],
    );

    await client.query("COMMIT");
    console.log("✅ تم تجهيز الحساب التجريبي بنجاح تام وبدون أي تعارضات!");
    console.log(
      "-------------------------------------------------------------",
    );
    console.log("👤 مدير العيادة (ClinicAdmin): demo@curosta.com");
    console.log("👩‍⚕️ الطبيبة المعالجة (Doctor):  doctor.demo@curosta.com");
    console.log("🔑 كلمة المرور للحسابين:      Demo@123456");
    console.log("🌐 رابط الحجز العام:           /c/curosta-demo");
    console.log(
      "-------------------------------------------------------------",
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("فشل التراجع عن المعاملة:", rollbackErr.message);
    }

    console.error("❌ فشل تجهيز حساب الديمو:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
};

seedDemoClinic();
