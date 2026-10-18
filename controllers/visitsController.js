const pool = require("../db");
const { logActivity } = require("../utils/auditLogger");
const { captureError } = require("../utils/errorTracker");
const { isValidUuid } = require("../middleware/validateUuid");

// قوالب استرشادية لعيادات الأسنان
const DEFAULT_DENTAL_TEMPLATES = [
  {
    id: "default-composite",
    title: "حشو كومبوزيت ضوئي (Composite Restoration)",
    category: "restorative",
    chief_complaint: "ألم وحساسية مع المشروبات الباردة والسكريات",
    diagnosis: "تسوس عاجي موضعي (Dental Caries)",
    procedure_notes:
      "بنج موضعي، إزالة التسوس بالكامل، عزل السن، تطبيق حمض الفوسفوريك والبوند، وضع حشو الكومبوزيت على طبقات، ثم ضبط العضة والتلميع.",
    anesthesia_notes: "بنج موضعي ارتكائين 4% مع أدرينالين 1:100,000",
    post_op_instructions:
      "تجنب الأكل على الجانب المعالج حتى زوال مفعول البنج بالكامل.",
    is_default: true,
  },
  {
    id: "default-endo",
    title: "جلسة علاج جذور (Root Canal Treatment)",
    category: "endodontics",
    chief_complaint: "ألم حاد ومستمر يزداد عند النوم",
    diagnosis: "التهاب عصب السن غير رجعي (Irreversible Pulpitis)",
    procedure_notes:
      "بنج موضعي، فتح حجرة العصب (Access Cavity)، استئصال النسيج اللبي وتحديد الطول العامل، توسيع القنوات مع الغسيل بـ NaOCl، ووضع حشو مؤقت.",
    anesthesia_notes: "بنج ارتكائين موضعي مع تعزيز داخل الرباط",
    post_op_instructions:
      "تجنب المضغ على السن، وتناول المسكن عند اللزوم، ومراجعة العيادة في حالة سقوط الحشو المؤقت.",
    is_default: true,
  },
  {
    id: "default-extraction",
    title: "خلع سن / ضرس (Simple Extraction)",
    category: "surgery",
    chief_complaint: "تآكل كامل في تاج السن مع ألم متكرر وتخلخل",
    diagnosis: "بقايا جذور غير قابلة للعلاج والترميم (Retained Root)",
    procedure_notes:
      "بنج موضعي، فصل الأربطة اللثوية، خلع الجذر/السن بالكامل بدون مضاعفات، تنظيف مكان الخلع، والضغط بشاش معقم.",
    anesthesia_notes: "بنج موضعي ميبفاكائين 2% مع أدرينالين",
    post_op_instructions:
      "العض على الشاش لمدة ساعة، الامتناع عن المضمضة والبصق والتدخين والمشروبات الساخنة لمدة 24 ساعة.",
    is_default: true,
  },
];

// استنتاج ذكي لحالة السن الناتجة عن الإجراء السريري
const inferResultingCondition = (procedureName) => {
  const name = String(procedureName || "").toLowerCase();

  if (
    name.includes("خلع") ||
    name.includes("extraction") ||
    name.includes("exo")
  ) {
    return "missing";
  }

  if (
    name.includes("زراع") ||
    name.includes("غرس") ||
    name.includes("implant")
  ) {
    return "implant";
  }

  if (
    name.includes("تاج") ||
    name.includes("طربوش") ||
    name.includes("تركيب") ||
    name.includes("زيركون") ||
    name.includes("بورسلين") ||
    name.includes("إيماكس") ||
    name.includes("crown") ||
    name.includes("zircon") ||
    name.includes("veneer")
  ) {
    return "crown";
  }

  if (
    name.includes("عصب") ||
    name.includes("جذور") ||
    name.includes("rct") ||
    name.includes("endo") ||
    name.includes("pulpotomy") ||
    name.includes("pulpectomy")
  ) {
    return "rct";
  }

  if (name.includes("سيلانت") || name.includes("sealant")) {
    return "sealant";
  }

  if (name.includes("كسر") || name.includes("fracture")) {
    return "fracture";
  }

  return null;
};

// التحقق من أرقام الأسنان وفق معيار FDI العالمي (ISO 3950)
const isFdiToothNumber = (val) => {
  if (val === null || val === undefined || val === "") return true;
  const str = String(val).trim();
  if (!/^\d+$/.test(str)) return false;
  const n = parseInt(str, 10);
  return (
    (n >= 11 && n <= 18) || // دائم علوي يمين
    (n >= 21 && n <= 28) || // دائم علوي يسار
    (n >= 31 && n <= 38) || // دائم سفلي يسار
    (n >= 41 && n <= 48) || // دائم سفلي يمين
    (n >= 51 && n <= 55) || // لبني علوي يمين
    (n >= 61 && n <= 65) || // لبني علوي يسار
    (n >= 71 && n <= 75) || // لبني سفلي يسار
    (n >= 81 && n <= 85) // لبني سفلي يمين
  );
};

// تدقيق وتنظيف أسطح الأسنان تشريحياً (M, O, D, B, L, I)
const parseAndValidateSurfaces = (raw) => {
  if (!raw) return { surface: null };
  let chars = [];
  if (Array.isArray(raw)) {
    chars = raw.map((s) => String(s).trim().toUpperCase());
  } else if (typeof raw === "string") {
    chars = raw.trim().toUpperCase().split("");
  } else {
    return { error: "صيغة أسطح الأسنان غير صالحة" };
  }

  const VALID_SET = new Set(["M", "O", "D", "B", "L", "I"]);
  const cleaned = [];
  for (const ch of chars) {
    if (!ch) continue;
    if (!VALID_SET.has(ch)) {
      return {
        error: `رمز السطح (${ch}) غير صالح. الرموز المسموحة طبياً هي: M (Mesial), O (Occlusal), D (Distal), B (Buccal), L (Lingual), I (Incisal)`,
      };
    }
    if (!cleaned.includes(ch)) cleaned.push(ch);
  }

  return { surface: cleaned.length > 0 ? cleaned.join("").slice(0, 10) : null };
};

// فحص ما إذا كان صف الإجراء فارغاً بالكامل لتجاهله بأمان
const isProcedureRowEmpty = (p) => {
  if (!p || typeof p !== "object") return true;
  const hasCode = Boolean(p.procedure_code_id);
  const hasName = Boolean(p.procedure_name && String(p.procedure_name).trim());
  const hasTooth =
    p.tooth_number !== undefined &&
    p.tooth_number !== null &&
    p.tooth_number !== "";
  const hasSurfaces =
    (Array.isArray(p.surfaces) && p.surfaces.length > 0) ||
    (typeof p.surface === "string" && p.surface.trim().length > 0);
  const hasNotes = Boolean(p.notes && String(p.notes).trim());
  const hasCost =
    p.cost !== undefined &&
    p.cost !== null &&
    p.cost !== "" &&
    (!Number.isFinite(Number(p.cost)) || Number(p.cost) !== 0);
  return (
    !hasCode && !hasName && !hasTooth && !hasSurfaces && !hasNotes && !hasCost
  );
};

// دالة مساعدة موحدة لجلب تفاصيل الزيارة كاملة
const fetchFullVisitById = async (dbClient, visitId, clinicId) => {
  const visitRes = await dbClient.query(
    `
    SELECT
      v.*,
      p.name AS patient_name,
      p.phone_number AS patient_phone,
      p.gender AS patient_gender,
      p.date_of_birth AS patient_dob,
      u.name AS doctor_name,
      c.name AS clinic_name,
      c.phone_number AS clinic_phone,
      c.address AS clinic_address
    FROM visits v
    JOIN patients p ON v.patient_id = p.id AND v.clinic_id = p.clinic_id
    JOIN users u ON v.doctor_id = u.id AND v.clinic_id = u.clinic_id
    JOIN clinics c ON v.clinic_id = c.id
    WHERE v.id = $1 AND v.clinic_id = $2
    LIMIT 1;
    `,
    [visitId, clinicId],
  );

  if (visitRes.rows.length === 0) return null;

  const proceduresRes = await dbClient.query(
    `
    SELECT
      vp.id,
      vp.visit_id,
      vp.procedure_code_id,
      vp.procedure_name,
      vp.tooth_number,
      vp.surface,
      vp.notes,
      vp.cost,
      pc.code AS procedure_code,
      pc.description AS procedure_description,
      pc.default_price,
      pc.resulting_condition
    FROM visit_procedures vp
    LEFT JOIN procedure_codes pc ON vp.procedure_code_id = pc.id AND vp.clinic_id = pc.clinic_id
    WHERE vp.visit_id = $1 AND vp.clinic_id = $2
    ORDER BY vp.created_at ASC;
    `,
    [visitId, clinicId],
  );

  return {
    ...visitRes.rows[0],
    procedures: proceduresRes.rows,
  };
};

// ==========================================
// 1. فتح أو إنشاء سجل زيارة لموعد محدد (POST /appointments/:id/visit)
// ==========================================
const createOrGetAppointmentVisit = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { id: appointmentId } = req.params;

  if (!isValidUuid(appointmentId)) {
    return res.status(400).json({ error: "معرّف الموعد غير صالح" });
  }

  try {
    const apptRes = await pool.query(
      `
      SELECT a.*, u.name as doctor_name 
      FROM appointments a
      JOIN users u ON a.doctor_id = u.id AND a.clinic_id = u.clinic_id
      WHERE a.id = $1 AND a.clinic_id = $2 
      LIMIT 1;
      `,
      [appointmentId, clinicId],
    );

    if (apptRes.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "الموعد غير موجود في سجلات العيادة" });
    }

    const appt = apptRes.rows[0];

    if (req.user.role === "Doctor" && appt.doctor_id !== req.user.id) {
      return res.status(403).json({
        error: `هذا الموعد مخصص لـ (${appt.doctor_name}). لا تملك صلاحية فتح أو استعراض كشف لموعد طبيب آخر.`,
      });
    }

    const existingRes = await pool.query(
      `SELECT id FROM visits WHERE appointment_id = $1 AND clinic_id = $2 LIMIT 1`,
      [appointmentId, clinicId],
    );

    if (existingRes.rows.length > 0) {
      const fullVisit = await fetchFullVisitById(
        pool,
        existingRes.rows[0].id,
        clinicId,
      );
      return res.status(200).json({ visit: fullVisit, is_new: false });
    }

    const insertRes = await pool.query(
      `
      INSERT INTO visits (
        clinic_id,
        patient_id,
        appointment_id,
        doctor_id,
        visit_date,
        chief_complaint,
        status
      )
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5, 'draft')
      ON CONFLICT (appointment_id) DO NOTHING
      RETURNING id;
      `,
      [
        clinicId,
        appt.patient_id,
        appointmentId,
        appt.doctor_id,
        appt.notes || null,
      ],
    );

    let visitId;
    let isActuallyNew = false;

    if (insertRes.rows.length > 0) {
      visitId = insertRes.rows[0].id;
      isActuallyNew = true;
    } else {
      const raceRes = await pool.query(
        `SELECT id FROM visits WHERE appointment_id = $1 AND clinic_id = $2 LIMIT 1`,
        [appointmentId, clinicId],
      );
      visitId = raceRes.rows[0].id;
      isActuallyNew = false;
    }

    const fullVisit = await fetchFullVisitById(pool, visitId, clinicId);

    return res.status(isActuallyNew ? 201 : 200).json({
      message: isActuallyNew
        ? "تم فتح سجل الزيارة السريري"
        : "تم استرجاع سجل الزيارة الموجود",
      visit: fullVisit,
      is_new: isActuallyNew,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error in createOrGetAppointmentVisit:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء فتح سجل الزيارة" });
  }
};

// ==========================================
// 2. جلب زيارة بمعرفها (GET /visits/:id)
// ==========================================
const getVisitById = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: "معرّف الزيارة غير صالح" });
  }

  try {
    const visit = await fetchFullVisitById(pool, id, clinicId);

    if (!visit) {
      return res.status(404).json({ error: "سجل الزيارة غير موجود" });
    }

    if (req.user.role === "Doctor" && visit.doctor_id !== req.user.id) {
      return res.status(403).json({
        error: "لا تملك صلاحية عرض سجل زيارة مسجل باسم طبيب آخر",
      });
    }

    return res.status(200).json({ visit });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching visit:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء جلب سجل الزيارة" });
  }
};

// ==========================================
// 3. جلب كل زيارات مريض محدد (GET /patients/:patientId/visits)
// ==========================================
const getPatientVisits = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { patientId } = req.params;

  if (!isValidUuid(patientId)) {
    return res.status(400).json({ error: "معرّف المريض غير صالح" });
  }

  try {
    const visitsRes = await pool.query(
      `
      SELECT
        v.*,
        u.name AS doctor_name,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', vp.id,
                'procedure_code_id', vp.procedure_code_id,
                'procedure_name', vp.procedure_name,
                'tooth_number', vp.tooth_number,
                'surface', vp.surface,
                'notes', vp.notes,
                'cost', vp.cost,
                'procedure_code', pc.code,
                'procedure_description', pc.description,
                'resulting_condition', pc.resulting_condition
              )
            )
            FROM visit_procedures vp
            LEFT JOIN procedure_codes pc ON vp.procedure_code_id = pc.id AND vp.clinic_id = pc.clinic_id
            WHERE vp.visit_id = v.id AND vp.clinic_id = v.clinic_id
          ),
          '[]'::json
        ) AS procedures
      FROM visits v
      JOIN users u ON v.doctor_id = u.id AND v.clinic_id = u.clinic_id
      WHERE v.patient_id = $1 AND v.clinic_id = $2
      ORDER BY v.visit_date DESC, v.created_at DESC;
      `,
      [patientId, clinicId],
    );

    return res.status(200).json({ visits: visitsRes.rows });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching patient visits:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء جلب سجل زيارات المريض" });
  }
};

// ==========================================
// 4. تحديث بيانات الزيارة وإجراءاتها (PUT /visits/:id)
// ==========================================
const updateVisit = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { id } = req.params;
  const {
    chief_complaint,
    diagnosis,
    procedure_notes,
    anesthesia_notes,
    post_op_instructions,
    procedures,
    amendment_reason,
  } = req.body || {};

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: "معرّف الزيارة غير صالح" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const visitCheck = await client.query(
      `SELECT * FROM visits WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [id, clinicId],
    );

    if (visitCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "سجل الزيارة غير موجود" });
    }

    const currentVisit = visitCheck.rows[0];

    if (req.user.role === "Doctor" && currentVisit.doctor_id !== req.user.id) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: "لا تملك صلاحية تعديل سجل زيارة مسجل باسم طبيب آخر",
      });
    }

    if (currentVisit.status === "final") {
      if (req.user.role !== "ClinicAdmin") {
        await client.query("ROLLBACK");
        return res.status(403).json({
          error:
            "سجل هذه الزيارة معتمد ونهائي. تعديل السجلات المعتمدة مقتصر حصرياً على مدير العيادة (ClinicAdmin).",
          code: "FINALIZED_VISIT_ADMIN_ONLY",
        });
      }

      if (
        !amendment_reason ||
        typeof amendment_reason !== "string" ||
        amendment_reason.trim().length < 5
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error:
            "لتعديل سجل زيارة معتمد، يجب على مدير العيادة تقديم سبب واضح وموثق (amendment_reason لا يقل عن 5 أحرف).",
          code: "AMENDMENT_REASON_REQUIRED",
        });
      }
    }

    await client.query(
      `
      UPDATE visits
      SET
        chief_complaint = $1,
        diagnosis = $2,
        procedure_notes = $3,
        anesthesia_notes = $4,
        post_op_instructions = $5,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6 AND clinic_id = $7;
      `,
      [
        chief_complaint?.trim() || null,
        diagnosis?.trim() || null,
        procedure_notes?.trim() || null,
        anesthesia_notes?.trim() || null,
        post_op_instructions?.trim() || null,
        id,
        clinicId,
      ],
    );

    if (Array.isArray(procedures)) {
      const activeProcedures = procedures.filter(
        (p) => !isProcedureRowEmpty(p),
      );

      for (const proc of activeProcedures) {
        if (
          proc.tooth_number !== undefined &&
          proc.tooth_number !== null &&
          proc.tooth_number !== ""
        ) {
          if (!isFdiToothNumber(proc.tooth_number)) {
            await client.query("ROLLBACK");
            return res.status(400).json({
              error: `رقم السن (${proc.tooth_number}) غير صالح. يجب أن يكون رقماً صحيحاً وفق نظام FDI الدولي (الدائم 11–48 أو اللبني 51–85).`,
            });
          }
        }

        const surfaceCheck = parseAndValidateSurfaces(
          proc.surfaces || proc.surface,
        );
        if (surfaceCheck.error) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: surfaceCheck.error });
        }

        if (proc.cost !== undefined && proc.cost !== null && proc.cost !== "") {
          const rawCost = Number(proc.cost);
          if (!Number.isFinite(rawCost) || rawCost < 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({
              error: `تكلفة الإجراء (${proc.cost}) غير صالحة. يجب أن تكون رقماً موجباً أو صفراً.`,
            });
          }
        }
      }

      const rawCodeIds = activeProcedures
        .map((p) => p.procedure_code_id)
        .filter((cid) => cid !== null && cid !== undefined && cid !== "");

      for (const cid of rawCodeIds) {
        if (!isValidUuid(cid)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `معرّف كود الإجراء (${cid}) غير صالح`,
          });
        }
      }

      const catalogMap = new Map();
      if (rawCodeIds.length > 0) {
        const catalogRes = await client.query(
          `
          SELECT id, code, description, default_price, resulting_condition
          FROM procedure_codes 
          WHERE id = ANY($1::uuid[]) AND clinic_id = $2;
          `,
          [rawCodeIds, clinicId],
        );

        for (const row of catalogRes.rows) {
          catalogMap.set(row.id, row);
        }

        for (const cid of rawCodeIds) {
          if (!catalogMap.has(cid)) {
            await client.query("ROLLBACK");
            return res.status(400).json({
              error: `كود الإجراء المحدد غير موجود في كتالوج هذه العيادة`,
            });
          }
        }
      }

      await client.query(
        `DELETE FROM visit_procedures WHERE visit_id = $1 AND clinic_id = $2`,
        [id, clinicId],
      );

      for (const proc of activeProcedures) {
        const procCodeId = proc.procedure_code_id || null;
        const catalogItem = procCodeId ? catalogMap.get(procCodeId) : null;

        const procedureName =
          proc.procedure_name?.trim() ||
          catalogItem?.description ||
          catalogItem?.code;

        if (!procedureName) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error:
              "يجب تحديد اسم الإجراء أو اختياره من كتالوج الإجراءات بالعيادة",
          });
        }

        let cost = 0.0;
        if (proc.cost !== undefined && proc.cost !== null && proc.cost !== "") {
          cost = Math.round(Number(proc.cost) * 100) / 100;
        } else if (catalogItem?.default_price !== undefined) {
          cost = parseFloat(catalogItem.default_price) || 0.0;
        }

        const toothNum =
          proc.tooth_number !== undefined &&
          proc.tooth_number !== null &&
          proc.tooth_number !== ""
            ? parseInt(String(proc.tooth_number).trim(), 10)
            : null;

        const { surface: cleanSurface } = parseAndValidateSurfaces(
          proc.surfaces || proc.surface,
        );

        await client.query(
          `
          INSERT INTO visit_procedures (
            clinic_id,
            visit_id,
            procedure_code_id,
            procedure_name,
            tooth_number,
            surface,
            notes,
            cost
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
          `,
          [
            clinicId,
            id,
            procCodeId,
            procedureName.slice(0, 255),
            toothNum,
            cleanSurface,
            proc.notes?.trim() || null,
            cost,
          ],
        );
      }
    }

    await client.query("COMMIT");

    if (currentVisit.status === "final") {
      try {
        await logActivity({
          clinic_id: clinicId,
          user_id: req.user.id,
          action: "AMEND_FINALIZED_VISIT",
          entity_type: "visit",
          entity_id: id,
          description: `قام مدير العيادة (${req.user.name}) بتعديل استثنائي على زيارة معتمدة (#${id.slice(0, 8)}). سبب التعديل: ${amendment_reason.trim()}`,
        });
      } catch (auditErr) {
        console.warn("Audit log failed:", auditErr.message);
      }
    }

    const updatedVisit = await fetchFullVisitById(pool, id, clinicId);
    return res.status(200).json({
      message: "تم حفظ بيانات الزيارة بنجاح",
      visit: updatedVisit,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (e) {}
    }
    captureError(error, req);
    console.error("Error updating visit:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء حفظ سجل الزيارة" });
  } finally {
    if (client) client.release();
  }
};

// ==========================================
// 5. اعتماد وإغلاق الزيارة السريرية + التحديث التلقائي لشارت الأسنان والأسطح
// ==========================================
const finalizeVisit = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: "معرّف الزيارة غير صالح" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const visitCheck = await client.query(
      `SELECT * FROM visits WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [id, clinicId],
    );

    if (visitCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "سجل الزيارة غير موجود" });
    }

    const currentVisit = visitCheck.rows[0];

    if (req.user.role === "Doctor" && currentVisit.doctor_id !== req.user.id) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: "لا تملك صلاحية اعتماد وإغلاق سجل مسجل باسم طبيب آخر",
      });
    }

    if (currentVisit.status === "final") {
      await client.query("ROLLBACK");
      const fullVisit = await fetchFullVisitById(pool, id, clinicId);
      return res.status(200).json({
        message: "سجل الزيارة معتمد بالفعل",
        visit: fullVisit,
        already_finalized: true,
      });
    }

    // أ) تحديث حالة الزيارة إلى final
    const visitRes = await client.query(
      `
      UPDATE visits
      SET
        status = 'final',
        finalized_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND clinic_id = $2
      RETURNING *;
      `,
      [id, clinicId],
    );

    const visit = visitRes.rows[0];

    // ب) إكمال الموعد المرتبط تلقائياً
    if (visit.appointment_id) {
      await client.query(
        `
        UPDATE appointments
        SET status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND clinic_id = $2 AND status NOT IN ('cancelled', 'no_show');
        `,
        [visit.appointment_id, clinicId],
      );
    }

    // ج) 🦷 المزامنة التلقائية مع شارت الأسنان والأسطح لإجراءات الزيارة
    const proceduresToSync = await client.query(
      `
      SELECT
        vp.tooth_number,
        vp.surface,
        vp.procedure_name,
        pc.resulting_condition AS code_resulting_condition
      FROM visit_procedures vp
      LEFT JOIN procedure_codes pc
        ON vp.procedure_code_id = pc.id AND pc.clinic_id = vp.clinic_id
      WHERE vp.visit_id = $1
        AND vp.clinic_id = $2
        AND vp.tooth_number IS NOT NULL;
      `,
      [id, clinicId],
    );

    for (const proc of proceduresToSync.rows) {
      const toothNum = Number(proc.tooth_number);
      const dentition = toothNum >= 51 ? "deciduous" : "permanent";
      const targetCondition = String(
        proc.code_resulting_condition ||
          inferResultingCondition(proc.procedure_name) ||
          "",
      )
        .trim()
        .toLowerCase();

      // لا نغيّر الشارت إذا كانت الحالة الناتجة غير معروفة
      if (!targetCondition) {
        continue;
      }

      const autoNote = `إجراء سريري معتمد بالزيارة: ${proc.procedure_name}`;

      // 1. تحديث أو إدخال السن في patient_teeth
      const upsertTooth = await client.query(
        `INSERT INTO patient_teeth (
          clinic_id,
          patient_id,
          tooth_number,
          dentition,
          condition,
          notes,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        ON CONFLICT (clinic_id, patient_id, tooth_number)
        DO UPDATE SET
          dentition = EXCLUDED.dentition,
          condition = EXCLUDED.condition,
          notes = COALESCE(EXCLUDED.notes, patient_teeth.notes),
          updated_at = CURRENT_TIMESTAMP
        RETURNING id;`,
        [
          clinicId,
          visit.patient_id,
          toothNum,
          dentition,
          targetCondition,
          autoNote,
        ],
      );

      const toothRecordId = upsertTooth.rows[0].id;

      // 2. تحديث الأسطح إذا كان الإجراء يحتوي على أسطح (أو مسحها في حال الخلع أو الزراعة)
      if (["missing", "implant"].includes(targetCondition)) {
        await client.query(
          `DELETE FROM tooth_surfaces WHERE clinic_id = $1 AND tooth_record_id = $2;`,
          [clinicId, toothRecordId],
        );
      } else if (proc.surface && /^[MODBLI]+$/.test(proc.surface)) {
        const surfaceCodes = [...new Set(proc.surface.split(""))];
        for (const sCode of surfaceCodes) {
          await client.query(
            `INSERT INTO tooth_surfaces (
              clinic_id,
              tooth_record_id,
              surface,
              condition,
              notes,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            ON CONFLICT (tooth_record_id, surface)
            DO UPDATE SET
              condition = EXCLUDED.condition,
              notes = EXCLUDED.notes,
              updated_at = CURRENT_TIMESTAMP;`,
            [clinicId, toothRecordId, sCode, targetCondition, autoNote],
          );
        }
      }

      // 3. توثيق الإجراء في تاريخ السن tooth_history
      await client.query(
        `INSERT INTO tooth_history (
          clinic_id,
          patient_id,
          tooth_number,
          condition,
          procedure_name,
          surface,
          notes,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          clinicId,
          visit.patient_id,
          toothNum,
          targetCondition,
          proc.procedure_name,
          proc.surface || null,
          autoNote,
          req.user.id,
        ],
      );
    }

    await client.query("COMMIT");

    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "FINALIZE_VISIT",
        entity_type: "visit",
        entity_id: id,
        description: `قام ${req.user.name || "الطبيب"} باعتماد وإغلاق سجل الزيارة السريري (#${id.slice(0, 8)}) وتحديث مخطط الأسنان`,
      });
    } catch (auditErr) {
      console.warn("Audit log failed:", auditErr.message);
    }

    const fullVisit = await fetchFullVisitById(pool, id, clinicId);
    return res.status(200).json({
      message: "تم اعتماد سجل الزيارة وتحديث مخطط أسنان المريض رسمياً",
      visit: fullVisit,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (e) {}
    }
    captureError(error, req);
    console.error("Error finalizing visit:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء اعتماد الزيارة" });
  } finally {
    if (client) client.release();
  }
};

// ==========================================
// 6. إدارة قوالب النصوص السريعة (note_templates)
// ==========================================
const getNoteTemplates = async (req, res) => {
  const clinicId = req.user.clinic_id;
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM note_templates
      WHERE clinic_id = $1
        AND is_active = true
        AND (doctor_id IS NULL OR doctor_id = $2)
      ORDER BY created_at DESC;
      `,
      [clinicId, req.user.id],
    );

    return res.status(200).json({
      templates: [...DEFAULT_DENTAL_TEMPLATES, ...result.rows],
      custom_count: result.rows.length,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching note templates:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء جلب القوالب النصية" });
  }
};

const createNoteTemplate = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const {
    title,
    category,
    chief_complaint,
    diagnosis,
    procedure_notes,
    anesthesia_notes,
    post_op_instructions,
    is_clinic_wide,
  } = req.body || {};

  if (!title || !title.trim()) {
    return res.status(400).json({ error: "عنوان القالب مطلوب" });
  }

  const targetDoctorId =
    req.user.role === "ClinicAdmin" && is_clinic_wide ? null : req.user.id;

  try {
    const result = await pool.query(
      `
      INSERT INTO note_templates (
        clinic_id,
        doctor_id,
        title,
        category,
        chief_complaint,
        diagnosis,
        procedure_notes,
        anesthesia_notes,
        post_op_instructions
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
      `,
      [
        clinicId,
        targetDoctorId,
        title.trim().slice(0, 150),
        category?.trim() || "general",
        chief_complaint?.trim() || null,
        diagnosis?.trim() || null,
        procedure_notes?.trim() || null,
        anesthesia_notes?.trim() || null,
        post_op_instructions?.trim() || null,
      ],
    );

    return res.status(201).json({
      message: "تم حفظ القالب السريع بنجاح",
      template: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res
        .status(409)
        .json({ error: "يوجد قالب مسجل بهذا العنوان مسبقاً" });
    }
    captureError(error, req);
    console.error("Error creating note template:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء حفظ القالب" });
  }
};

const deleteNoteTemplate = async (req, res) => {
  const clinicId = req.user.clinic_id;
  const { id } = req.params;

  if (String(id).startsWith("default-")) {
    return res
      .status(400)
      .json({ error: "لا يمكن حذف القوالب الافتراضية للنظام" });
  }

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: "معرّف القالب غير صالح" });
  }

  try {
    const deleteQuery =
      req.user.role === "ClinicAdmin"
        ? `DELETE FROM note_templates WHERE id = $1 AND clinic_id = $2 RETURNING id;`
        : `DELETE FROM note_templates WHERE id = $1 AND clinic_id = $2 AND doctor_id = $3 RETURNING id;`;

    const params =
      req.user.role === "ClinicAdmin"
        ? [id, clinicId]
        : [id, clinicId, req.user.id];

    const result = await pool.query(deleteQuery, params);

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "القالب غير موجود أو لا تملك صلاحية حذفه" });
    }

    return res.status(200).json({ message: "تم حذف القالب بنجاح" });
  } catch (error) {
    captureError(error, req);
    console.error("Error deleting note template:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء حذف القالب" });
  }
};

module.exports = {
  createOrGetAppointmentVisit,
  getVisitById,
  getPatientVisits,
  updateVisit,
  finalizeVisit,
  getNoteTemplates,
  createNoteTemplate,
  deleteNoteTemplate,
};
