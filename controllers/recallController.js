const pool = require("../db");
const { normalizeEgyptianPhone } = require("../utils/phoneNormalizer");
const { captureError } = require("../utils/errorTracker");
const { isValidUuid } = require("../middleware/validateUuid");
const { logActivity } = require("../utils/auditLogger");

// القوالب الافتراضية للنظام في حال لم تُنشئ العيادة قوالبها بعد
const SYSTEM_DEFAULT_TEMPLATES = {
  reminder_tomorrow: {
    name: "تذكير مواعيد الغد الافتراضي",
    type: "reminder_tomorrow",
    body:
      "تذكير بموعدك في {{clinic_name}} 🔔\n\n" +
      "أهلاً بك أ. {{patient_name}}، نذكرك بموعدك غداً:\n" +
      "📅 التاريخ: {{date}}\n" +
      "⏰ الساعة: {{time}}\n" +
      "👨‍⚕️ الطبيب: {{doctor_name}}\n\n" +
      "نرجو الحضور قبل الموعد بـ 10 دقائق لتجنب الانتظار. نتشرف بزيارتك ونتمنى لك دوام الصحة والعافية!",
  },
  recall_6_months: {
    name: "استدعاء الفحص الدوري (6 أشهر)",
    type: "recall_6_months",
    body:
      "مرحباً أ. {{patient_name}} من {{clinic_name}} 🦷✨\n\n" +
      "مرت أكثر من 6 أشهر على آخر زيارة لك في العيادة. صحة أسنانك تهمنا، وللحفاظ على ابتسامتك ننصحك بعمل جلسة فحص دوري وتنظيف جير وقائي.\n\n" +
      "يسعدنا تواصلك معنا لحجز موعدك المناسب في أي وقت يناسبك!",
  },
  recall_treatment_plan: {
    name: "استدعاء خطة علاجية متبقية",
    type: "recall_treatment_plan",
    body:
      "أهلاً بك أ. {{patient_name}} من {{clinic_name}} 🌸\n\n" +
      "نود تذكيرك بأن لديك خطة علاجية مسجلة ومتبقية لأسنانك لم تكتمل بعد ({{plan_title}}).\n" +
      "إكمال خطوات العلاج في موعدها يمنع حدوث أي مضاعفات أو ألم لاحقاً.\n\n" +
      "تفضل بالتواصل معنا وسنرتب لك الجلسة القادمة فوراً.",
  },
  recall_no_show: {
    name: "متابعة الغياب عن الموعد (No-Show)",
    type: "recall_no_show",
    body:
      "أهلاً بك أ. {{patient_name}} من {{clinic_name}} 🌸\n\n" +
      "لاحظنا عدم تمكنك من حضور موعدك الأخير، ونتمنى أن تكون بأفضل حال وألف سلامة عليك.\n\n" +
      "إذا كنت ترغب في إعادة جدولة الموعد في وقت آخر يناسبك، يسعدنا الرد على هذه الرسالة وسنساعدك فوراً.",
  },
};

// دالة مساعدة لاستبدال المتغيرات وتوليد رابط الواتساب
const buildWhatsAppMessageAndUrl = (templateBody, variables, phone) => {
  let message = templateBody;
  for (const [key, val] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, "g");
    message = message.replace(regex, val || "");
  }

  const normalizedPhone = normalizeEgyptianPhone(phone);
  const waUrl = normalizedPhone
    ? `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(message)}`
    : null;

  return { message, waUrl, phone: normalizedPhone };
};

// ==========================================
// 1. جلب تذكيرات مواعيد الغد (Tomorrow's Reminders)
// ==========================================
const getTomorrowReminders = async (req, res) => {
  const clinicId = req.user.clinic_id;

  try {
    // جلب القالب المخصص للعيادة أو استخدام الافتراضي
    const tplRes = await pool.query(
      `SELECT body FROM message_templates
       WHERE clinic_id = $1 AND type = 'reminder_tomorrow' AND is_active = true
       ORDER BY updated_at DESC LIMIT 1;`,
      [clinicId],
    );
    const templateBody =
      tplRes.rows[0]?.body || SYSTEM_DEFAULT_TEMPLATES.reminder_tomorrow.body;

    // استعلام مواعيد الغد بتوقيت مصر Africa/Cairo
    const query = `
      SELECT
        a.id AS appointment_id,
        a.appointment_date,
        a.status AS appointment_status,
        a.duration_minutes,
        p.id AS patient_id,
        p.name AS patient_name,
        p.phone_number AS patient_phone,
        p.marketing_opt_out,
        u.name AS doctor_name,
        c.name AS clinic_name,
        (
          SELECT rl.sent_at 
          FROM recall_logs rl
          WHERE rl.clinic_id = a.clinic_id
            AND rl.appointment_id = a.id
            AND rl.recall_type = 'reminder_tomorrow'
            AND rl.status = 'sent'
          ORDER BY rl.sent_at DESC
          LIMIT 1
        ) AS last_reminder_sent_at
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id AND a.clinic_id = p.clinic_id
      LEFT JOIN users u ON a.doctor_id = u.id AND a.clinic_id = u.clinic_id
      JOIN clinics c ON a.clinic_id = c.id
      WHERE a.clinic_id = $1
        AND a.status NOT IN ('cancelled', 'no_show', 'completed')
        AND p.is_active = true
        AND p.is_archived = false
        AND (a.appointment_date AT TIME ZONE 'Africa/Cairo')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo')::date + INTERVAL '1 day'
      ORDER BY a.appointment_date ASC;
    `;

    const result = await pool.query(query, [clinicId]);

    const reminders = result.rows.map((row) => {
      const dateStr = new Date(row.appointment_date).toLocaleDateString(
        "ar-EG",
        {
          timeZone: "Africa/Cairo",
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        },
      );

      const timeStr = new Date(row.appointment_date).toLocaleTimeString(
        "ar-EG",
        {
          timeZone: "Africa/Cairo",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        },
      );

      const { message, waUrl, phone } = buildWhatsAppMessageAndUrl(
        templateBody,
        {
          patient_name: row.patient_name,
          date: dateStr,
          time: timeStr,
          doctor_name: row.doctor_name || "طبيب العيادة",
          clinic_name: row.clinic_name || "العيادة",
        },
        row.patient_phone,
      );

      return {
        appointment_id: row.appointment_id,
        appointment_date: row.appointment_date,
        formatted_date: dateStr,
        formatted_time: timeStr,
        patient_id: row.patient_id,
        patient_name: row.patient_name,
        patient_phone: phone,
        doctor_name: row.doctor_name || "طبيب العيادة",
        marketing_opt_out: row.marketing_opt_out,
        last_reminder_sent_at: row.last_reminder_sent_at,
        is_already_sent: Boolean(row.last_reminder_sent_at),
        message,
        wa_url: waUrl,
      };
    });

    return res.status(200).json({
      count: reminders.length,
      template_body: templateBody,
      reminders,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching tomorrow reminders:", error.message);
    return res
      .status(500)
      .json({ error: "حدث خطأ أثناء جلب تذكيرات مواعيد الغد" });
  }
};

// ==========================================
// 2. محرك استدعاء المرضى السريري والمالي (Smart Patient Recall)
// ==========================================
const getRecallCandidates = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { type = "six_months" } = req.query; // six_months | incomplete_plan | no_show

  try {
    const validTypes = ["six_months", "incomplete_plan", "no_show"];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: "نوع قائمة الاستدعاء غير صالح" });
    }

    // جلب القالب الخاص بهذا النوع
    const tplTypeKey =
      type === "six_months"
        ? "recall_6_months"
        : type === "incomplete_plan"
          ? "recall_treatment_plan"
          : "recall_no_show";

    const tplRes = await pool.query(
      `SELECT body FROM message_templates
       WHERE clinic_id = $1 AND type = $2 AND is_active = true
       ORDER BY updated_at DESC LIMIT 1;`,
      [clinicId, tplTypeKey],
    );
    const templateBody =
      tplRes.rows[0]?.body || SYSTEM_DEFAULT_TEMPLATES[tplTypeKey].body;

    let query = "";
    let params = [clinicId];

    if (type === "six_months") {
      // 1. مرضى لم يزوروا العيادة منذ 6 أشهر (180 يوماً)، بدون مواعيد قادمة، ومع Cooldown 30 يوماً
      query = `
        SELECT
          p.id AS patient_id,
          p.name AS patient_name,
          p.phone_number AS patient_phone,
          c.name AS clinic_name,
          MAX(v.visit_date) AS last_visit_date,
          (
            SELECT rl.sent_at 
            FROM recall_logs rl 
            WHERE rl.clinic_id = p.clinic_id AND rl.patient_id = p.id AND rl.recall_type = 'recall_6_months' AND rl.status = 'sent'
            ORDER BY rl.sent_at DESC LIMIT 1
          ) AS last_contacted_at
        FROM patients p
        JOIN clinics c ON p.clinic_id = c.id
        LEFT JOIN visits v ON p.id = v.patient_id AND p.clinic_id = v.clinic_id AND v.status = 'final'
        WHERE p.clinic_id = $1
          AND p.is_active = true
          AND p.is_archived = false
          AND p.marketing_opt_out = false
          -- ليس لديه مواعيد قادمة مجدولة
          AND NOT EXISTS (
            SELECT 1 FROM appointments a
            WHERE a.clinic_id = p.clinic_id
              AND a.patient_id = p.id
              AND a.appointment_date >= CURRENT_TIMESTAMP
              AND a.status NOT IN ('cancelled', 'no_show')
          )
          -- Cooldown: لم يتم التواصل معه بخصوص الفحص الدوري خلال آخر 30 يوماً
          AND NOT EXISTS (
            SELECT 1 FROM recall_logs rl
            WHERE rl.clinic_id = p.clinic_id
              AND rl.patient_id = p.id
              AND rl.recall_type = 'recall_6_months'
              AND rl.status = 'sent'
              AND rl.sent_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
          )
        GROUP BY p.id, p.name, p.phone_number, p.clinic_id, c.name
        HAVING (
          MAX(v.visit_date) IS NOT NULL AND MAX(v.visit_date) <= CURRENT_TIMESTAMP - INTERVAL '180 days'
        ) OR (
          MAX(v.visit_date) IS NULL AND p.created_at <= CURRENT_TIMESTAMP - INTERVAL '180 days'
        )
        ORDER BY last_visit_date ASC NULLS FIRST
        LIMIT 100;
      `;
    } else if (type === "incomplete_plan") {
      // 2. مرضى لديهم خطط علاج نشطة وبنود معلقة، بدون مواعيد قادمة، ومع Cooldown 14 يوماً
      query = `
        SELECT
          p.id AS patient_id,
          p.name AS patient_name,
          p.phone_number AS patient_phone,
          c.name AS clinic_name,
          tp.id AS plan_id,
          tp.title AS plan_title,
          COUNT(tpi.id) AS pending_items_count,
          (
            SELECT rl.sent_at 
            FROM recall_logs rl 
            WHERE rl.clinic_id = p.clinic_id AND rl.patient_id = p.id AND rl.recall_type = 'recall_treatment_plan' AND rl.status = 'sent'
            ORDER BY rl.sent_at DESC LIMIT 1
          ) AS last_contacted_at
        FROM treatment_plans tp
        JOIN patients p ON tp.patient_id = p.id AND tp.clinic_id = p.clinic_id
        JOIN clinics c ON p.clinic_id = c.id
        JOIN treatment_plan_items tpi ON tp.id = tpi.plan_id AND tp.clinic_id = tpi.clinic_id
        WHERE tp.clinic_id = $1 AND tp.id = (
  SELECT tp2.id
  FROM treatment_plans tp2
  WHERE tp2.clinic_id = p.clinic_id
    AND tp2.patient_id = p.id
    AND tp2.status = 'active'
    AND EXISTS (
      SELECT 1
      FROM treatment_plan_items tpi2
      WHERE tpi2.clinic_id = tp2.clinic_id
        AND tpi2.plan_id = tp2.id
        AND tpi2.status IN ('planned', 'in_progress')
    )
  ORDER BY tp2.updated_at DESC, tp2.id
  LIMIT 1
)
          AND tp.status = 'active'
          AND tpi.status IN ('planned', 'in_progress')
          AND p.is_active = true
          AND p.is_archived = false
          AND p.marketing_opt_out = false
          -- ليس لديه مواعيد قادمة
          AND NOT EXISTS (
            SELECT 1 FROM appointments a
            WHERE a.clinic_id = p.clinic_id
              AND a.patient_id = p.id
              AND a.appointment_date >= CURRENT_TIMESTAMP
              AND a.status NOT IN ('cancelled', 'no_show')
          )
          -- Cooldown: لم يتم مراسلته لنفس السبب في آخر 14 يوماً
          AND NOT EXISTS (
            SELECT 1 FROM recall_logs rl
            WHERE rl.clinic_id = p.clinic_id
              AND rl.patient_id = p.id
              AND rl.recall_type = 'recall_treatment_plan'
              AND rl.status = 'sent'
              AND rl.sent_at >= CURRENT_TIMESTAMP - INTERVAL '14 days'
          )
        GROUP BY p.id, p.name, p.phone_number, p.clinic_id, c.name, tp.id, tp.title
        ORDER BY tp.updated_at DESC
        LIMIT 100;
      `;
    } else if (type === "no_show") {
      // 3. مرضى غابوا عن آخر موعد (No-Show) في آخر 60 يوماً، بدون مواعيد لاحقة، ومع Cooldown 14 يوماً
      query = `
        SELECT
          p.id AS patient_id,
          p.name AS patient_name,
          p.phone_number AS patient_phone,
          c.name AS clinic_name,
          a.id AS appointment_id,
          a.appointment_date AS missed_appointment_date,
          (
            SELECT rl.sent_at 
            FROM recall_logs rl 
            WHERE rl.clinic_id = p.clinic_id AND rl.patient_id = p.id AND rl.recall_type = 'recall_no_show'  AND rl.status = 'sent'
            ORDER BY rl.sent_at DESC LIMIT 1
          ) AS last_contacted_at
        FROM appointments a
        JOIN patients p ON a.patient_id = p.id AND a.clinic_id = p.clinic_id
        JOIN clinics c ON a.clinic_id = c.id
        WHERE a.clinic_id = $1
          AND a.status = 'no_show'
          AND a.appointment_date >= CURRENT_TIMESTAMP - INTERVAL '60 days'
          AND p.is_active = true
          AND p.is_archived = false
          AND p.marketing_opt_out = false
          -- ليس لديه مواعيد قادمة مجدولة بعد ذلك
          AND NOT EXISTS (
            SELECT 1 FROM appointments fa
            WHERE fa.clinic_id = p.clinic_id
              AND fa.patient_id = p.id
              AND fa.appointment_date > a.appointment_date
              AND fa.status NOT IN ('cancelled', 'no_show')
          )
          -- Cooldown: لم يتم مراسلته لتعويض الغياب في آخر 14 يوماً
          AND NOT EXISTS (
            SELECT 1 FROM recall_logs rl
            WHERE rl.clinic_id = p.clinic_id
              AND rl.patient_id = p.id
              AND rl.recall_type = 'recall_no_show' AND rl.status = 'sent'
              AND rl.sent_at >= CURRENT_TIMESTAMP - INTERVAL '14 days'
          ) AND NOT EXISTS (
  SELECT 1
  FROM appointments newer
  WHERE newer.clinic_id = a.clinic_id
    AND newer.patient_id = a.patient_id
    AND newer.status = 'no_show'
    AND newer.appointment_date > a.appointment_date
)
        ORDER BY a.appointment_date DESC
        LIMIT 100;
      `;
    }

    const result = await pool.query(query, params);

    const candidates = result.rows.map((row) => {
      const formattedDate = row.last_visit_date
        ? new Date(row.last_visit_date).toLocaleDateString("ar-EG")
        : row.missed_appointment_date
          ? new Date(row.missed_appointment_date).toLocaleDateString("ar-EG")
          : "";

      const vars = {
        patient_name: row.patient_name,
        clinic_name: row.clinic_name || "العيادة",
        plan_title: row.plan_title || "الخطة العلاجية",
        date: formattedDate,
        last_visit_date: formattedDate,
        missed_date: formattedDate,
      };

      const { message, waUrl, phone } = buildWhatsAppMessageAndUrl(
        templateBody,
        vars,
        row.patient_phone,
      );

      return {
        patient_id: row.patient_id,
        patient_name: row.patient_name,
        patient_phone: phone,
        appointment_id: row.appointment_id || null,
        plan_id: row.plan_id || null,
        plan_title: row.plan_title || null,
        pending_items_count: row.pending_items_count || null,
        last_visit_date: row.last_visit_date || null,
        missed_appointment_date: row.missed_appointment_date || null,
        last_contacted_at: row.last_contacted_at || null,
        message,
        wa_url: waUrl,
      };
    });

    return res.status(200).json({
      type,
      count: candidates.length,
      template_body: templateBody,
      candidates,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching recall candidates:", error.message);
    return res
      .status(500)
      .json({ error: "حدث خطأ أثناء جلب قائمة استدعاء المرضى" });
  }
};

// ==========================================
// 3. توثيق إرسال رسالة تذكير أو استدعاء (Log Recall Action)
// ==========================================
const logRecallAction = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const userId = req.user.id;
  const { patient_id, appointment_id, recall_type, notes } = req.body || {};

  if (!isValidUuid(patient_id)) {
    return res.status(400).json({ error: "معرّف المريض غير صالح" });
  }

  const validTypes = [
    "reminder_tomorrow",
    "recall_6_months",
    "recall_treatment_plan",
    "recall_no_show",
    "custom",
  ];
  if (!validTypes.includes(recall_type)) {
    return res.status(400).json({ error: "نوع الاستدعاء غير صالح" });
  }

  let effectiveAppointmentId = null;
  if (
    appointment_id !== undefined &&
    appointment_id !== null &&
    appointment_id !== ""
  ) {
    if (!isValidUuid(appointment_id)) {
      return res.status(400).json({ error: "معرّف الموعد غير صالح" });
    }
    effectiveAppointmentId = appointment_id;
  }

  try {
    if (effectiveAppointmentId) {
      const appointmentRes = await pool.query(
        `SELECT 1
     FROM appointments
     WHERE clinic_id = $1
       AND id = $2
       AND patient_id = $3
     LIMIT 1`,
        [clinicId, effectiveAppointmentId, patient_id],
      );

      if (appointmentRes.rowCount === 0) {
        return res.status(400).json({
          error: "الموعد لا يتبع هذا المريض",
        });
      }
    }
    const insertQuery = `
      INSERT INTO recall_logs (
        clinic_id,
        patient_id,
        appointment_id,
        recall_type,
        channel,
        sent_by,
        status,
        notes
      )
      VALUES ($1, $2, $3, $4, 'whatsapp', $5, 'sent', $6)
      RETURNING *;
    `;

    const result = await pool.query(insertQuery, [
      clinicId,
      patient_id,
      effectiveAppointmentId,
      recall_type,
      userId,
      notes && typeof notes === "string" ? notes.trim() : null,
    ]);

    return res.status(201).json({
      message: "تم تسجيل إرسال رسالة الاستدعاء بنجاح",
      log: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error logging recall action:", error.message);
    return res
      .status(500)
      .json({ error: "حدث خطأ أثناء تسجيل حركة الاستدعاء" });
  }
};

// ==========================================
// 4. جلب قوالب رسائل العيادة (Message Templates)
// ==========================================
const getMessageTemplates = async (req, res) => {
  const clinicId = req.user.clinic_id;

  try {
    const query = `
      SELECT * FROM message_templates
      WHERE clinic_id = $1
      ORDER BY created_at ASC;
    `;
    const result = await pool.query(query, [clinicId]);

    // إذا لم تكن هناك قوالب في العيادة، نرجع القوالب الافتراضية
    let templates = result.rows;
    if (templates.length === 0) {
      templates = Object.values(SYSTEM_DEFAULT_TEMPLATES);
    }

    return res.status(200).json({ templates });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching message templates:", error.message);
    return res.status(500).json({ error: "حدث خطأ أثناء جلب قوالب الرسائل" });
  }
};

// ==========================================
// 5. تعديل أو حفظ قالب رسالة (Update / Upsert Template)
// ==========================================
const updateMessageTemplate = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { type, body, name } = req.body || {};

  const validTypes = [
    "reminder_tomorrow",
    "recall_6_months",
    "recall_treatment_plan",
    "recall_no_show",
    "custom",
  ];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: "نوع القالب غير صالح" });
  }

  if (!body || typeof body !== "string" || !body.trim()) {
    return res.status(400).json({ error: "نص القالب مطلوب" });
  }

  const effectiveName =
    name && typeof name === "string" && name.trim()
      ? name.trim()
      : SYSTEM_DEFAULT_TEMPLATES[type]?.name || "قالب مخصص";

  try {
    const upsertQuery = `
      INSERT INTO message_templates (clinic_id, name, type, body, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (clinic_id, name)
DO UPDATE SET
  type = EXCLUDED.type,
  body = EXCLUDED.body,
  updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;

    const result = await pool.query(upsertQuery, [
      clinicId,
      effectiveName,
      type,
      body.trim(),
    ]);

    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "UPDATE_MESSAGE_TEMPLATE",
        entity_type: "message_template",
        entity_id: result.rows[0].id,
        description: `قام ${req.user.name || "الموظف"} بتحديث قالب رسالة (${effectiveName})`,
      });
    } catch (auditErr) {
      console.warn("Audit log failed:", auditErr.message);
    }

    return res.status(200).json({
      message: "تم حفظ وتحديث قالب الرسالة بنجاح",
      template: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error updating message template:", error.message);
    return res
      .status(500)
      .json({ error: "حدث خطأ أثناء حفظ وتحديث قالب الرسالة" });
  }
};

module.exports = {
  getTomorrowReminders,
  getRecallCandidates,
  logRecallAction,
  getMessageTemplates,
  updateMessageTemplate,
};
