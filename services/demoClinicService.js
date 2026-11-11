const pool = require("../db");
const bcrypt = require("bcrypt");

const DEMO_CLINIC_SLUG = "curosta-demo";
const DEMO_EMAILS = ["demo@curosta.com", "doctor.demo@curosta.com"];

// مدة صلاحية الجلسة بدون Heartbeat (90 ثانية)
const SESSION_TTL_SECONDS = 300;
// مهلة السماح بعد انتهاء آخر جلسة قبل السماح بالـ Auto-Reset (60 ثانية)
const GRACE_PERIOD_SECONDS = 60;

let schemaEnsured = false;

const isDemoUserEmail = (email) =>
  Boolean(email && DEMO_EMAILS.includes(String(email).trim().toLowerCase()));

/**
 * ضمان وجود جدول تتبع جلسات الديمو تلقائياً
 */
const ensureDemoSessionsTable = async (db = pool) => {
  if (schemaEnsured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.demo_sessions (
      session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      clinic_id uuid NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      started_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at timestamp with time zone
    );

    CREATE INDEX IF NOT EXISTS idx_demo_sessions_clinic_active
      ON public.demo_sessions (clinic_id, last_seen_at DESC)
      WHERE ended_at IS NULL;
  `);
  schemaEnsured = true;
};

/**
 * دالة داخلية لتنفيذ مسح بيانات التشغيل وإعادة زراعة البيانات الأساسية
 * تفترض أن الـ Transaction مفتوحة مسبقاً (BEGIN) وأن الـ Exclusive Advisory Lock تم الحصول عليه.
 * تحافظ بالكامل على نفس الـ UUIDs لعيادة الديمو وحسابَي المدير والطبيب.
 */
const executeDemoResetInTransaction = async (
  client,
  { targetClinicId = null, keepSessionId = null } = {},
) => {
  // 1. جلب أو إنشاء عيادة الديمو مع الحفاظ على نفس الـ id حتى لو تم تغيير الـ slug أثناء التجربة
  const existingClinicRes = await client.query(
    `SELECT id
     FROM public.clinics
     WHERE ($1::uuid IS NOT NULL AND id = $1)
        OR slug = $2
        OR id = (SELECT clinic_id FROM public.users WHERE email = 'demo@curosta.com' LIMIT 1)
     ORDER BY CASE WHEN slug = $2 THEN 0 ELSE 1 END
     LIMIT 1
     FOR UPDATE;`,
    [targetClinicId || null, DEMO_CLINIC_SLUG],
  );

  let clinicId;
  if (existingClinicRes.rows.length > 0) {
    clinicId = existingClinicRes.rows[0].id;

    // مسح slug_history أولاً لتجنب أي تعارض عند استعادة الـ slug الأصلي
    await client.query(
      `DELETE FROM public.slug_history WHERE clinic_id = $1;`,
      [clinicId],
    );

    await client.query(
      `UPDATE public.clinics
       SET name = 'مركز كوروستا التخصصي لطب الأسنان (تجريبي)',
           slug = $2,
           phone_number = '01012345678',
           address = 'ميدان المساحة، الدقي، الجيزة',
           bio = 'مركز متكامل لجراحة وزراعة وتجميل الأسنان وعلاج الجذور بأحدث التقنيات.',
           is_active = TRUE,
           subscription_plan = 'yearly',
           subscription_status = 'active',
           subscription_starts_at = CURRENT_TIMESTAMP,
           subscription_ends_at = CURRENT_TIMESTAMP + INTERVAL '1 year',
           default_appointment_duration = 30,
           total_chairs_count = 3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1;`,
      [clinicId, DEMO_CLINIC_SLUG],
    );
  } else {
    const clinicInsertRes = await client.query(
      `INSERT INTO public.clinics (
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
        default_appointment_duration,
        total_chairs_count
      ) VALUES (
        'مركز كوروستا التخصصي لطب الأسنان (تجريبي)',
        $1,
        '01012345678',
        'ميدان المساحة، الدقي، الجيزة',
        'مركز متكامل لجراحة وزراعة وتجميل الأسنان وعلاج الجذور بأحدث التقنيات.',
        TRUE,
        'yearly',
        'active',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '1 year',
        30,
        3
      ) RETURNING id;`,
      [DEMO_CLINIC_SLUG],
    );
    clinicId = clinicInsertRes.rows[0].id;
  }

  // 2. مسح جميع بيانات التشغيل للعيادة بالترتيب العكسي الدقيق للـ Foreign Keys
  const tablesToDeleteInOrder = [
    "commission_payouts",
    "expenses",
    "staff_compensation",
    "installments",
    "payments",
    "invoice_items",
    "treatment_plan_items",
    "treatment_plans",
    "invoices",
    "visit_procedures",
    "visits",
    "lab_orders",
    "labs",
    "prescriptions",
    "recall_logs",
    "message_templates",
    "note_templates",
    "tooth_surfaces",
    "tooth_history",
    "patient_teeth",
    "patient_images",
    "patient_allergies",
    "patient_medical_history",
    "booking_requests",
    "appointments",
    "patients",
    "procedure_codes",
    "doctor_leaves",
    "doctor_availability",
    "clinic_working_hours",
    "clinic_holidays",
    "clinic_gallery_items",
    "clinic_faqs",
    "clinic_testimonials",
    "clinic_site",
    "booking_settings",
    "slug_history",
    "support_tickets",
    "audit_logs",
  ];

  for (const tableName of tablesToDeleteInOrder) {
    await client.query(`DELETE FROM public.${tableName} WHERE clinic_id = $1;`, [
      clinicId,
    ]);
  }

  // 3. الحفاظ على حسابَي الديمو الأساسيين بنفس الـ UUIDs (أو إنشاؤهما إن لم يكونا موجودين)
  const salt = await bcrypt.genSalt(10);
  const demoPasswordHash = await bcrypt.hash("Demo@123456", salt);

  const ensureDemoUser = async ({ email, name, role }) => {
    const userRes = await client.query(
      `SELECT id FROM public.users WHERE email = $1 LIMIT 1 FOR UPDATE;`,
      [email],
    );

    if (userRes.rows.length > 0) {
      const userId = userRes.rows[0].id;
      await client.query(
        `UPDATE public.users
         SET clinic_id = $1,
             name = $2,
             password = $3,
             role = $4,
             is_active = TRUE,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5;`,
        [clinicId, name, demoPasswordHash, role, userId],
      );
      return userId;
    }

    const insertRes = await client.query(
      `INSERT INTO public.users (clinic_id, name, email, password, role, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id;`,
      [clinicId, name, email, demoPasswordHash, role],
    );
    return insertRes.rows[0].id;
  };

  const adminId = await ensureDemoUser({
    email: "demo@curosta.com",
    name: "د. حازم القاضي (المدير)",
    role: "ClinicAdmin",
  });

  const doctorId = await ensureDemoUser({
    email: "doctor.demo@curosta.com",
    name: "د. سارة أحمد المنشاوي",
    role: "Doctor",
  });

  // 4. تنظيف سجل جلسات الديمو السابقة (مع الإبقاء على الجلسة الحالية فقط في حالة الـ Reset اليدوي)
  if (keepSessionId) {
    await client.query(
      `DELETE FROM public.demo_sessions
       WHERE clinic_id = $1
         AND session_id <> $2;`,
      [clinicId, keepSessionId],
    );
    await client.query(
      `UPDATE public.demo_sessions
       SET last_seen_at = CURRENT_TIMESTAMP,
           ended_at = NULL,
           user_id = CASE
             WHEN user_id IN ($3, $4) THEN user_id
             ELSE $3
           END
       WHERE session_id = $1 AND clinic_id = $2;`,
      [keepSessionId, clinicId, adminId, doctorId],
    );
  } else {
    await client.query(
      `DELETE FROM public.demo_sessions WHERE clinic_id = $1;`,
      [clinicId],
    );
  }

  // حذف أي مستخدمين إضافيين أنشأهم الزوار أثناء التجربة بعد تأمين الجلسات
  await client.query(
    `DELETE FROM public.users
     WHERE clinic_id = $1
       AND id NOT IN ($2, $3);`,
    [clinicId, adminId, doctorId],
  );

  // 5. إعادة زراعة إعدادات الموقع العام والحجز الأونلاين ومواعيد عمل العيادة والمعرض والأسئلة والتقييمات
  await client.query(
    `INSERT INTO public.clinic_site (
       clinic_id,
       hero_title,
       hero_subtitle,
       logo_url,
       cover_url,
       logo_public_id,
       cover_public_id,
       whatsapp_number,
       facebook_url,
       instagram_url,
       tiktok_url,
       google_maps_url,
       city,
       area,
       theme_color,
       seo_title,
       seo_description,
       is_published
     ) VALUES (
       $1,
       'مركز كوروستا التخصصي لطب الأسنان',
       'مركز متكامل لجراحة وزراعة وتجميل الأسنان وعلاج الجذور بأحدث التقنيات.',
       NULL,
       NULL,
       NULL,
       NULL,
       '01012345678',
       'https://facebook.com/curosta',
       'https://instagram.com/curosta',
       NULL,
       'https://maps.google.com',
       'الجيزة',
       'الدقي',
       '#14b8a6',
       'مركز كوروستا التخصصي لطب الأسنان | احجز موعدك أونلاين',
       'مركز متكامل لجراحة وزراعة وتجميل الأسنان وعلاج الجذور في الدقي - الجيزة. احجز موعدك الآن أونلاين بسهولة.',
       TRUE
     );`,
    [clinicId],
  );

  await client.query(
    `INSERT INTO public.booking_settings (
       clinic_id,
       is_online_booking_enabled,
       min_advance_hours,
       max_advance_days,
       booking_instructions
     ) VALUES (
       $1,
       TRUE,
       2,
       30,
       'يرجى الحضور قبل الموعد بـ 10 دقائق، والدفع متاح نقداً أو بالبطاقة البنكية أو إنستا باي داخل العيادة.'
     );`,
    [clinicId],
  );

  // مواعيد عمل العيادة (طوال الأسبوع من 10 صباحاً إلى 10 مساءً ما عدا الجمعة إجازة، مع إبقاء clinic_holidays فارغاً لعدم حجب الأيام)
  for (let weekday = 0; weekday <= 6; weekday++) {
    const isFriday = weekday === 5;
    await client.query(
      `INSERT INTO public.clinic_working_hours (
         clinic_id,
         weekday,
         open_time,
         close_time,
         breaks,
         is_closed
       ) VALUES ($1, $2, '10:00:00', '22:00:00', '[]'::jsonb, $3);`,
      [clinicId, weekday, isFriday],
    );
  }

  // عناصر المعرض الافتراضية للموقع العام
  await client.query(
    `INSERT INTO public.clinic_gallery_items (
       clinic_id,
       image_url,
       before_image_url,
       caption,
       category,
       sort_order
     ) VALUES
       ($1, 'https://images.unsplash.com/photo-1629909613654-28e377c37b09?auto=format&fit=crop&w=900&q=80', NULL, 'غرفة الكشف والمعالجة الرقمية الحديثة', 'clinic', 0),
       ($1, 'https://images.unsplash.com/photo-1588776814546-1ffcf47267a5?auto=format&fit=crop&w=900&q=80', NULL, 'وحدة التعقيم المركزي الأوتوكلاف Class B', 'equipment', 1);`,
    [clinicId],
  );

  // الأسئلة الشائعة الافتراضية للموقع العام
  await client.query(
    `INSERT INTO public.clinic_faqs (clinic_id, question, answer, sort_order, is_visible) VALUES
       ($1, 'هل يتوفر حجز طوارئ في نفس اليوم؟', 'نعم، نوفر مواعيد طوارئ يومية لحالات الألم الحاد مع أولوية الكشف السريع.', 0, TRUE),
       ($1, 'ما هي طرق الدفع المتاحة داخل المركز؟', 'يتوفر الدفع نقداً (كاش)، وبجميع البطاقات البنكية (POS)، وتحويلات InstaPay وفودافون كاش.', 1, TRUE),
       ($1, 'هل يتم تعقيم الأدوات وفق المعايير الدولية؟', 'نلتزم بأعلى بروتوكولات التعقيم الأوتوكلاف Class B مع تغليف منفصل لكل مريض.', 2, TRUE);`,
    [clinicId],
  );

  // آراء وتقييمات المرضى الافتراضية للموقع العام
  await client.query(
    `INSERT INTO public.clinic_testimonials (clinic_id, patient_display_name, rating, comment, sort_order, is_visible) VALUES
       ($1, 'أ. محمود عبد العزيز', 5, 'تجربة ممتازة في حشو العصب بدون أي ألم، ومواعيد دقيقة جداً.', 0, TRUE),
       ($1, 'أ. نورهان طارق', 5, 'العيادة نظيفة جداً والتعقيم واضح، والدكتورة سارة شرحت خطة العلاج بالتفصيل.', 1, TRUE),
       ($1, 'م. كريم عادل', 5, 'حجزت أونلاين بسهولة وتم تأكيد الموعد فوراً عبر الواتساب.', 2, TRUE);`,
    [clinicId],
  );

  // 6. إعادة زراعة قائمة الخدمات والأسعار الأساسية
  const procRes = await client.query(
    `INSERT INTO public.procedure_codes (clinic_id, code, description, default_price, duration_minutes, resulting_condition) VALUES
       ($1, 'CONS-01', 'كشف واستشارة وتشخيص شامل', 200, 20, NULL),
       ($1, 'ENDO-01', 'علاج جذور وحشو عصب ضرس خلفي', 1200, 45, 'rct'),
       ($1, 'REST-01', 'حشو تجميلي كومبوزيت ليزر', 600, 30, 'filled'),
       ($1, 'SURG-01', 'خلع ضرس عقل جراحي', 1000, 45, 'missing'),
       ($1, 'SCAL-01', 'تنظيف جير وتلميع وإزالة ترسبات', 500, 30, NULL),
       ($1, 'PROS-01', 'تركيبة زيركون ألماني للضرس', 2500, 30, 'crown')
     RETURNING id, code, default_price;`,
    [clinicId],
  );
  const endoProc = procRes.rows.find((p) => p.code === "ENDO-01");
  const scalProc = procRes.rows.find((p) => p.code === "SCAL-01");

  // 7. شفتات عمل الطبيبة (طوال الأسبوع ما عدا الجمعة من 2 ظهراً لـ 10 مساءً)
  for (let day = 0; day <= 6; day++) {
    if (day !== 5) {
      await client.query(
        `INSERT INTO public.doctor_availability (clinic_id, doctor_id, day_of_week, start_time, end_time, is_active)
         VALUES ($1, $2, $3, '14:00', '22:00', TRUE);`,
        [clinicId, doctorId, day],
      );
    }
  }

  // 8. إضافة مرضى ببيانات مصرية صحيحة
  const patientsRes = await client.query(
    `INSERT INTO public.patients (clinic_id, name, phone_number, gender, date_of_birth, medical_alerts, is_active) VALUES
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

  // 9. مواعيد منطقية
  // 9. مواعيد ديمو متوافقة مع شيفت الطبيبة (2 ظهراً - 10 مساءً)
  const apptRes = await client.query(
    `WITH cairo_clock AS (
       SELECT CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo' AS now_local
     ),
     past_slot AS (
       SELECT
         ((c.now_local::date - offsets.day_offset) + TIME '15:00')
           AT TIME ZONE 'Africa/Cairo' AS appointment_date
       FROM cairo_clock c
       CROSS JOIN generate_series(1, 7) AS offsets(day_offset)
       WHERE EXTRACT(DOW FROM (c.now_local::date - offsets.day_offset)) <> 5
       ORDER BY offsets.day_offset
       LIMIT 1
     ),
     future_candidates AS (
       SELECT
         (c.now_local::date + days.day_offset + slots.slot_time) AS local_slot
       FROM cairo_clock c
       CROSS JOIN generate_series(0, 14) AS days(day_offset)
       CROSS JOIN (
         VALUES
           (TIME '14:30'),
           (TIME '16:00'),
           (TIME '17:30'),
           (TIME '19:00'),
           (TIME '20:30')
       ) AS slots(slot_time)
       WHERE EXTRACT(DOW FROM (c.now_local::date + days.day_offset)) <> 5
         AND (c.now_local::date + days.day_offset + slots.slot_time)
             >= c.now_local + INTERVAL '1 hour'
     ),
     future_slots AS (
       SELECT
         local_slot AT TIME ZONE 'Africa/Cairo' AS appointment_date,
         ROW_NUMBER() OVER (ORDER BY local_slot) AS slot_number
       FROM future_candidates
     ),
     chosen_dates AS (
       SELECT
         (SELECT appointment_date FROM past_slot) AS past_date,
         (SELECT appointment_date FROM future_slots WHERE slot_number = 1) AS future_date_1,
         (SELECT appointment_date FROM future_slots WHERE slot_number = 2) AS future_date_2
     )
     INSERT INTO public.appointments (
       clinic_id,
       patient_id,
       doctor_id,
       appointment_date,
       duration_minutes,
       status,
       notes
     ) VALUES
       ($1, $2, $3, (SELECT past_date FROM chosen_dates), 45, 'completed', 'تمت جلسة حشو العصب بنجاح'),
       ($1, $4, $3, (SELECT future_date_1 FROM chosen_dates), 30, 'scheduled', 'جلسة تنظيف وتلميع أسنان دورية'),
       ($1, $5, $3, (SELECT future_date_2 FROM chosen_dates), 45, 'scheduled', 'أخذ مقاسات تركيبة زيركون')
     RETURNING id, patient_id;`,
    [clinicId, p1.id, doctorId, p2.id, p3.id],
  );

  // 10. فواتير ومدفوعات
  const inv1Res = await client.query(
    `INSERT INTO public.invoices (clinic_id, patient_id, appointment_id, doctor_id, subtotal_amount, total_amount, status)
     VALUES ($1, $2, $3, $4, 1200, 1200, 'partially_paid') RETURNING id;`,
    [clinicId, p1.id, apptRes.rows[0].id, doctorId],
  );
  await client.query(
    `INSERT INTO public.invoice_items (clinic_id, invoice_id, procedure_code_id, description, quantity, unit_price, total_price)
     VALUES ($1, $2, $3, 'علاج جذور وحشو عصب ضرس خلفي', 1, 1200, 1200);`,
    [clinicId, inv1Res.rows[0].id, endoProc?.id || null],
  );
  await client.query(
    `INSERT INTO public.payments (clinic_id, invoice_id, amount, payment_method, status, paid_at, created_by)
     VALUES ($1, $2, 800, 'cash', 'paid', CURRENT_TIMESTAMP, $3);`,
    [clinicId, inv1Res.rows[0].id, adminId],
  );

  const inv2Res = await client.query(
    `INSERT INTO public.invoices (clinic_id, patient_id, appointment_id, doctor_id, subtotal_amount, total_amount, status)
     VALUES ($1, $2, $3, $4, 500, 500, 'paid') RETURNING id;`,
    [clinicId, p2.id, apptRes.rows[1].id, doctorId],
  );
  await client.query(
    `INSERT INTO public.invoice_items (clinic_id, invoice_id, procedure_code_id, description, quantity, unit_price, total_price)
     VALUES ($1, $2, $3, 'تنظيف جير وتلميع وإزالة ترسبات', 1, 500, 500);`,
    [clinicId, inv2Res.rows[0].id, scalProc?.id || null],
  );
  await client.query(
    `INSERT INTO public.payments (clinic_id, invoice_id, amount, payment_method, status, paid_at, created_by)
     VALUES ($1, $2, 500, 'card', 'paid', CURRENT_TIMESTAMP, $3);`,
    [clinicId, inv2Res.rows[0].id, adminId],
  );

  // 11. طلب معمل
  await client.query(
    `INSERT INTO public.lab_orders (clinic_id, patient_id, doctor_id, lab_name, case_number, status, expected_at, notes)
     VALUES ($1, $2, $3, 'معمل الدلتا لتركيبات الأسنان', 'CASE-9842', 'sent_to_lab', (CURRENT_TIMESTAMP + INTERVAL '2 days')::date, 'كراون زيركون A2 للضرس 36');`,
    [clinicId, p3.id, doctorId],
  );

  // 12. روشتة طبية
  await client.query(
    `INSERT INTO public.prescriptions (clinic_id, patient_id, doctor_id, prescription_date, diagnosis, medications, instructions)
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

  return { clinicId, adminId, doctorId };
};

/**
 * فحص وتنفيذ Reset تلقائي إذا كانت هناك جلسات ديمو سابقة انتهت جميعها
 * ومرت مهلة السماح (Grace Period) بدون أي جلسة نشطة حالياً.
 * يحتفظ بالـ Exclusive Advisory Lock لمنع أي تعارض مع الجلسات الجديدة أو المتزامنة.
 */
const maybeAutoResetDemoClinic = async (clinicId) => {
  if (!clinicId) return { resetPerformed: false };

  await ensureDemoSessionsTable();

  // فحص سريع خارج الـ Lock لتجنب فتح Transaction في كل طلب عادي
  const quickCheck = await pool.query(
    `SELECT
       COUNT(*)::int AS total_sessions,
       COUNT(*) FILTER (
         WHERE ended_at IS NULL
           AND last_seen_at > CURRENT_TIMESTAMP - ($2 * INTERVAL '1 second')
       )::int AS active_sessions,
       MAX(
         CASE
           WHEN ended_at IS NOT NULL THEN ended_at
           ELSE last_seen_at + ($2 * INTERVAL '1 second')
         END
       ) AS last_session_effective_end
     FROM public.demo_sessions
     WHERE clinic_id = $1;`,
    [clinicId, SESSION_TTL_SECONDS],
  );

  const stats = quickCheck.rows[0];
  if (!stats || stats.total_sessions === 0 || stats.active_sessions > 0) {
    return { resetPerformed: false };
  }

  // التحقق من مرور مهلة السماح بعد انتهاء آخر جلسة
  const graceCheck = await pool.query(
    `SELECT ($1::timestamptz <= CURRENT_TIMESTAMP - ($2 * INTERVAL '1 second')) AS grace_elapsed;`,
    [stats.last_session_effective_end, GRACE_PERIOD_SECONDS],
  );

  if (!graceCheck.rows[0]?.grace_elapsed) {
    return { resetPerformed: false };
  }

  // فتح Transaction آمنة مع Exclusive Advisory Lock لمنع تكرار التنفيذ بالتزامن
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('curosta_demo_reset_lock'));`,
    );

    // إعادة التحقق داخل الـ Exclusive Lock لضمان عدم دخول جلسة جديدة قبل الحصول على القفل
    const verifyRes = await client.query(
      `SELECT
         COUNT(*)::int AS total_sessions,
         COUNT(*) FILTER (
           WHERE ended_at IS NULL
             AND last_seen_at > CURRENT_TIMESTAMP - ($2 * INTERVAL '1 second')
         )::int AS active_sessions,
         MAX(
           CASE
             WHEN ended_at IS NOT NULL THEN ended_at
             ELSE last_seen_at + ($2 * INTERVAL '1 second')
           END
         ) AS last_session_effective_end
       FROM public.demo_sessions
       WHERE clinic_id = $1;`,
      [clinicId, SESSION_TTL_SECONDS],
    );

    const vStats = verifyRes.rows[0];
    if (!vStats || vStats.total_sessions === 0 || vStats.active_sessions > 0) {
      await client.query("ROLLBACK");
      return { resetPerformed: false };
    }

    const vGrace = await client.query(
      `SELECT ($1::timestamptz <= CURRENT_TIMESTAMP - ($2 * INTERVAL '1 second')) AS grace_elapsed;`,
      [vStats.last_session_effective_end, GRACE_PERIOD_SECONDS],
    );

    if (!vGrace.rows[0]?.grace_elapsed) {
      await client.query("ROLLBACK");
      return { resetPerformed: false };
    }

    await executeDemoResetInTransaction(client, {
      targetClinicId: clinicId,
      keepSessionId: null,
    });
    await client.query("COMMIT");

    return { resetPerformed: true };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback error
    }
    console.error("Error in maybeAutoResetDemoClinic:", err.message);
    return { resetPerformed: false, error: err.message };
  } finally {
    client.release();
  }
};

/**
 * إنشاء جلسة ديمو جديدة أو تحديث نبض الجلسة الحالية (Heartbeat)
 * متزامن مع الـ Reset عبر Transaction + Shared Advisory Lock لمنع أي Race Condition.
 */
const startOrTouchDemoSession = async ({
  clinicId,
  userId,
  sessionId = null,
}) => {
  await ensureDemoSessionsTable();

  // أولاً: فحص وتنفيذ الـ Auto-Reset إن كانت جميع الجلسات السابقة قد انتهت ومرت مهلة السماح
  const autoResetResult = await maybeAutoResetDemoClinic(clinicId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // قفل مشترك (Shared Advisory Lock) يتزامن مع الـ Exclusive Lock الخاص بالـ Reset
    await client.query(
      `SELECT pg_advisory_xact_lock_shared(hashtext('curosta_demo_reset_lock'));`,
    );

    if (sessionId) {
      const updateRes = await client.query(
        `UPDATE public.demo_sessions
         SET last_seen_at = CURRENT_TIMESTAMP,
             ended_at = NULL
         WHERE session_id = $1
           AND clinic_id = $2
           AND user_id = $3
         RETURNING session_id;`,
        [sessionId, clinicId, userId],
      );

      if (updateRes.rows.length > 0) {
        await client.query("COMMIT");
        return {
          sessionId: updateRes.rows[0].session_id,
          autoResetPerformed: Boolean(autoResetResult.resetPerformed),
        };
      }
    }

    const insertRes = await client.query(
      `INSERT INTO public.demo_sessions (clinic_id, user_id)
       VALUES ($1, $2)
       RETURNING session_id;`,
      [clinicId, userId],
    );

    await client.query("COMMIT");

    return {
      sessionId: insertRes.rows[0].session_id,
      autoResetPerformed: Boolean(autoResetResult.resetPerformed),
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback error
    }
    throw err;
  } finally {
    client.release();
  }
};

/**
 * إنهاء جلسة ديمو محددة فقط (عند Logout أو pagehide) بدون مسح بيانات المستخدمين الآخرين
 * متزامن مع الـ Reset عبر Transaction + Shared Advisory Lock.
 */
const endDemoSession = async ({ clinicId, userId, sessionId }) => {
  if (!sessionId || !clinicId || !userId) return { ended: false };
  await ensureDemoSessionsTable();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `SELECT pg_advisory_xact_lock_shared(hashtext('curosta_demo_reset_lock'));`,
    );

    const res = await client.query(
      `UPDATE public.demo_sessions
       SET ended_at = CURRENT_TIMESTAMP,
           last_seen_at = CURRENT_TIMESTAMP
       WHERE session_id = $1
         AND clinic_id = $2
         AND user_id = $3
         AND ended_at IS NULL
       RETURNING session_id;`,
      [sessionId, clinicId, userId],
    );

    await client.query("COMMIT");
    return { ended: res.rows.length > 0 };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback error
    }
    throw err;
  } finally {
    client.release();
  }
};

/**
 * تنفيذ Reset يدوي بطلب من المستخدم الحالي بشرط التحقق من ملكية الجلسة
 * وعدم وجود أي جلسة أخرى نشطة، مع استخدام Exclusive Advisory Lock.
 */
const manualResetDemoClinic = async ({ clinicId, userId, sessionId }) => {
  await ensureDemoSessionsTable();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const lockRes = await client.query(
      `SELECT pg_try_advisory_xact_lock(hashtext('curosta_demo_reset_lock')) AS acquired;`,
    );

    if (!lockRes.rows[0]?.acquired) {
      await client.query("ROLLBACK");
      return {
        success: false,
        status: 409,
        code: "DEMO_RESET_IN_PROGRESS",
        error: "جاري إعادة ضبط بيانات الديمو بالفعل، يرجى الانتظار لحظات.",
      };
    }

    // 1. التحقق الصارم من ملكية الجلسة الحالية (session_id + clinic_id + user_id) قبل استثنائها
    let verifiedOwnSessionId = null;
    if (sessionId && userId) {
      const ownSessionRes = await client.query(
        `SELECT session_id
         FROM public.demo_sessions
         WHERE session_id = $1
           AND clinic_id = $2
           AND user_id = $3
         LIMIT 1
         FOR UPDATE;`,
        [sessionId, clinicId, userId],
      );

      if (ownSessionRes.rows.length > 0) {
        verifiedOwnSessionId = ownSessionRes.rows[0].session_id;
      }
    }

    // 2. فحص الجلسات النشطة الأخرى (لا يُستثنى إلا verifiedOwnSessionId المملوك للمستخدم الحالي)
    const activeOthersRes = await client.query(
      `SELECT COUNT(*)::int AS other_active_count
       FROM public.demo_sessions
       WHERE clinic_id = $1
         AND ($2::uuid IS NULL OR session_id <> $2)
         AND ended_at IS NULL
         AND last_seen_at > CURRENT_TIMESTAMP - ($3 * INTERVAL '1 second');`,
      [clinicId, verifiedOwnSessionId, SESSION_TTL_SECONDS],
    );

    const otherActiveCount = activeOthersRes.rows[0]?.other_active_count || 0;
    if (otherActiveCount > 0) {
      await client.query("ROLLBACK");
      return {
        success: false,
        status: 409,
        code: "DEMO_OTHER_SESSION_ACTIVE",
        error:
          "لا يمكن إعادة ضبط البيانات حالياً لأن هناك مستخدماً آخر يجرب حساب الديمو في نفس الوقت.",
      };
    }

    // 3. ضمان وجود جلسة موثقة للمستخدم الحالي للإبقاء عليها بعد التنظيف
    let activeSessionId = verifiedOwnSessionId;
    if (!activeSessionId && userId) {
      const ins = await client.query(
        `INSERT INTO public.demo_sessions (clinic_id, user_id)
         VALUES ($1, $2)
         RETURNING session_id;`,
        [clinicId, userId],
      );
      activeSessionId = ins.rows[0].session_id;
    }

    await executeDemoResetInTransaction(client, {
      targetClinicId: clinicId,
      keepSessionId: activeSessionId,
    });

    await client.query("COMMIT");

    return {
      success: true,
      sessionId: activeSessionId,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback error
    }
    console.error("Error in manualResetDemoClinic:", err.message);
    return {
      success: false,
      status: 500,
      code: "SERVER_ERROR",
      error: "حدث خطأ أثناء إعادة ضبط بيانات الديمو.",
    };
  } finally {
    client.release();
  }
};

/**
 * دالة مخصصة لسكريبت الـ CLI (seedDemoClinic.js)
 */
const seedOrResetDemoClinicCli = async () => {
  await ensureDemoSessionsTable();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('curosta_demo_reset_lock'));`,
    );
    const result = await executeDemoResetInTransaction(client, {
      keepSessionId: null,
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
};

module.exports = {
  DEMO_CLINIC_SLUG,
  DEMO_EMAILS,
  SESSION_TTL_SECONDS,
  GRACE_PERIOD_SECONDS,
  isDemoUserEmail,
  ensureDemoSessionsTable,
  maybeAutoResetDemoClinic,
  startOrTouchDemoSession,
  endDemoSession,
  manualResetDemoClinic,
  seedOrResetDemoClinicCli,
};