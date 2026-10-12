const pool = require("../db");
const { logActivity } = require("../utils/auditLogger");
const { normalizeEgyptianPhone } = require("../utils/phoneNormalizer");
const { captureError } = require("../utils/errorTracker");
const { isValidUuid } = require("../middleware/validateUuid");

const normalizeAndValidatePhone = (phone_number) => {
  if (!phone_number || typeof phone_number !== "string") {
    return null;
  }

  return normalizeEgyptianPhone(phone_number.trim());
};

const getTodayCairoISODate = () => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
};

// 🌟 دالة ذكية لتحليل تواريخ الميلاد المصرية (تدعم DD/MM/YYYY و YYYY-MM-DD والشرطات)
const parseEgyptianDate = (rawDate) => {
  if (!rawDate || typeof rawDate !== "string") return null;
  const cleaned = rawDate.trim();

  // لو الخانة فاضية أو فيها شرطة تصدير
  if (
    !cleaned ||
    ["-", "--", "null", "undefined", "لا يوجد", "لا توجد"].includes(
      cleaned.toLowerCase(),
    )
  ) {
    return null;
  }

  // 1. صيغة اليوم/الشهر/السنة (المعتادة في مصر: DD/MM/YYYY أو DD-MM-YYYY)
  const dmyMatch = cleaned.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10);
    const year = parseInt(dmyMatch[3], 10);

    if (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31 &&
      year >= 1900 &&
      year <= new Date().getFullYear()
    ) {
      const dateObj = new Date(Date.UTC(year, month - 1, day));
      if (dateObj.getUTCDate() === day && dateObj.getUTCMonth() === month - 1) {
        if (dateObj.toISOString().slice(0, 10) >= getTodayCairoISODate()) {
          return "FUTURE";
        }
        return dateObj.toISOString().split("T")[0];
      }
    }
  }

  // 2. صيغة السنة/الشهر/اليوم القياسية (YYYY-MM-DD)
  const ymdMatch = cleaned.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10);
    const day = parseInt(ymdMatch[3], 10);

    if (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31 &&
      year >= 1900 &&
      year <= new Date().getFullYear()
    ) {
      const dateObj = new Date(Date.UTC(year, month - 1, day));
      if (dateObj.getUTCDate() === day && dateObj.getUTCMonth() === month - 1) {
        if (dateObj.toISOString().slice(0, 10) >= getTodayCairoISODate()) {
          return "FUTURE";
        }
        return dateObj.toISOString().split("T")[0];
      }
    }
  }

  // 3. Fallback للتواريخ القياسية والأمريكية (MM/DD/YYYY)
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return "INVALID";

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const fallbackDay = String(d.getDate()).padStart(2, "0");
  const formattedFallback = `${y}-${m}-${fallbackDay}`;

  if (formattedFallback >= getTodayCairoISODate()) return "FUTURE";

  return formattedFallback;
};

// دالة التحقق الموحدة
const validatePatientInput = ({ name, gender, date_of_birth }) => {
  // الاسم
  if (!name || typeof name !== "string" || name.trim().length < 2) {
    return "اسم المريض مطلوب ويجب أن يحتوي على حرفين على الأقل";
  }

  // النوع
  if (gender) {
    if (typeof gender !== "string") {
      return "النوع يجب أن يكون Male أو Female";
    }
    const cleanGender = gender.trim().toLowerCase();
    if (cleanGender !== "male" && cleanGender !== "female") {
      return "النوع يجب أن يكون Male أو Female";
    }
  }

  // تاريخ الميلاد
  if (
    date_of_birth !== undefined &&
    date_of_birth !== null &&
    date_of_birth !== ""
  ) {
    if (typeof date_of_birth !== "string") {
      return "تاريخ الميلاد غير صالح";
    }

    const dob = new Date(date_of_birth);

    if (isNaN(dob.getTime())) {
      return "تاريخ الميلاد غير صالح";
    }

    if (dob.toISOString().slice(0, 10) >= getTodayCairoISODate()) {
      return "تاريخ الميلاد لا يمكن أن يكون اليوم أو في المستقبل";
    }
  }

  return null;
};

// 1. إضافة مريض
const addPatient = async (req, res) => {
  try {
    const clinic_id = req.user.clinic_id;
    const { name, phone_number, gender, date_of_birth, medical_alerts } =
      req.body || {};

    const normalizedPhone = normalizeAndValidatePhone(phone_number);

    if (!normalizedPhone) {
      return res.status(400).json({
        error: "رقم الهاتف المصري غير صحيح",
      });
    }

    const validationError = validatePatientInput({
      name,
      gender,
      date_of_birth,
    });

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const cleanedDob =
      date_of_birth && String(date_of_birth).trim() !== ""
        ? date_of_birth
        : null;

    let normalizedGender = null;
    if (gender) {
      normalizedGender =
        gender.trim().toLowerCase() === "female" ? "Female" : "Male";
    }

    const query = `
    INSERT INTO patients (
      clinic_id,
      name,
      phone_number,
      gender,
      date_of_birth,
      medical_alerts,
      is_active
    )
    VALUES ($1, $2, $3, $4, $5, $6, TRUE)
    RETURNING *;
  `;
    const values = [
      clinic_id,
      name.trim(),
      normalizedPhone,
      normalizedGender,
      cleanedDob,
      medical_alerts || null,
    ];

    const result = await pool.query(query, values);

    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "CREATE_PATIENT",
        entity_type: "patient",
        entity_id: result.rows[0].id,
        description: `تمت إضافة مريض جديد (${result.rows[0].name})`,
      });
    } catch (auditErr) {
      console.error("Audit log failed for addPatient:", auditErr.message);
    }

    return res.status(201).json({
      message: "تم إضافة المريض بنجاح",
      patient: result.rows[0],
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({
        error: "رقم الهاتف موجود بالفعل لمريض آخر",
      });
    }
    captureError(err, req);
    console.error("Error adding patient:", err.message);

    return res.status(500).json({
      error: "خطأ في السيرفر",
    });
  }
};

// 2. جلب قائمة المرضى مع الـ Pagination والبحث
const getPatients = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { search, archived, page, limit } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const offset = (pageNum - 1) * limitNum;

    const isActive = archived === "true" ? false : true;

    let query = `
      SELECT 
        id, 
        clinic_id, 
        name, 
        phone_number, 
        gender, 
        date_of_birth, 
        medical_alerts, 
        is_active, 
        created_at, 
        updated_at,
        COUNT(*) OVER() AS full_count
      FROM patients
      WHERE clinic_id = $1 AND is_active = $2
    `;

    const params = [clinicId, isActive];
    let paramCounter = 3;

    if (search && search.trim() !== "") {
      query += ` AND (name ILIKE $${paramCounter} OR phone_number ILIKE $${paramCounter})`;
      params.push(`%${search.trim()}%`);
      paramCounter++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramCounter} OFFSET $${
      paramCounter + 1
    };`;
    params.push(limitNum, offset);

    const result = await pool.query(query, params);

    const total =
      result.rows.length > 0 ? Number(result.rows[0].full_count) : 0;

    const patients = result.rows.map(({ full_count, ...patient }) => patient);
    const totalPages = Math.ceil(total / limitNum) || 1;
    res.status(200).json({
      patients,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
      },
    });
  } catch (err) {
    captureError(err, req);
    console.error("Error fetching patients:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء جلب قائمة المرضى" });
  }
};

// 3. جلب بيانات مريض محدد
const getPatientById = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const patientId = req.params.id;

    if (!isValidUuid(patientId)) {
      return res.status(400).json({ error: "معرّف المريض غير صالح" });
    }

    const result = await pool.query(
      "SELECT * FROM patients WHERE id = $1 AND clinic_id = $2",
      [patientId, clinicId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "المريض غير موجود" });
    }

    res.status(200).json({ patient: result.rows[0] });
  } catch (err) {
    captureError(err, req);
    console.error("Error fetching patient by ID:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

// 4. تعديل مريض
const updatePatient = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const patientId = req.params.id;

    if (!isValidUuid(patientId)) {
      return res.status(400).json({ error: "معرّف المريض غير صالح" });
    }

    const { name, phone_number, gender, medical_alerts, date_of_birth } =
      req.body || {};

    const normalizedPhone = normalizeAndValidatePhone(phone_number);

    if (!normalizedPhone) {
      return res.status(400).json({
        error: "رقم الهاتف المصري غير صحيح",
      });
    }

    const validationError = validatePatientInput({
      name,
      gender,
      date_of_birth,
    });

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const cleanedDob =
      date_of_birth && String(date_of_birth).trim() !== ""
        ? date_of_birth
        : null;

    let normalizedGender = null;
    if (gender) {
      normalizedGender =
        gender.trim().toLowerCase() === "female" ? "Female" : "Male";
    }

    const query = `
    UPDATE patients
    SET
      name = $1,
      phone_number = $2,
      gender = $3,
      medical_alerts = $4,
      date_of_birth = $5,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $6
      AND clinic_id = $7
      AND is_active = TRUE
    RETURNING *;
  `;
    const result = await pool.query(query, [
      name.trim(),
      normalizedPhone,
      normalizedGender,
      medical_alerts || null,
      cleanedDob,
      patientId,
      clinicId,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "المريض غير موجود أو تمت أرشفته",
      });
    }

    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "UPDATE_PATIENT",
        entity_type: "patient",
        entity_id: patientId,
        description: `تم تعديل بيانات المريض (${result.rows[0].name})`,
      });
    } catch (auditErr) {
      console.error("Audit log failed for updatePatient:", auditErr.message);
    }

    return res.status(200).json({
      message: "تم تحديث بيانات المريض بنجاح",
      patient: result.rows[0],
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({
        error: "رقم الهاتف موجود بالفعل لمريض آخر في العيادة",
      });
    }
    captureError(err, req);
    console.error("Error updating patient:", err.message);

    return res.status(500).json({
      error: "خطأ في السيرفر",
    });
  }
};

// 5. أرشفة مريض (Soft Delete) مع حماية الصلاحيات
const deletePatient = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const patientId = req.params.id;
    const userRole = req.user.role;

    if (!isValidUuid(patientId)) {
      return res.status(400).json({ error: "معرّف المريض غير صالح" });
    }

    if (userRole !== "ClinicAdmin") {
      return res
        .status(403)
        .json({ error: "ليس لديك صلاحية أرشفة ملف المريض" });
    }

    const result = await pool.query(
      "UPDATE patients SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND clinic_id = $2 AND is_active = TRUE RETURNING id, name",
      [patientId, clinicId],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "المريض غير موجود أو تمت أرشفته بالفعل" });
    }
    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "ARCHIVE_PATIENT",
        entity_type: "patient",
        entity_id: patientId,
        description: `تمت أرشفة ملف المريض (${result.rows[0].name})`,
      });
    } catch (auditErr) {
      console.error("Audit log failed for deletePatient:", auditErr.message);
    }
    res
      .status(200)
      .json({ message: "تم أرشفة المريض بنجاح", patient: result.rows[0] });
  } catch (err) {
    captureError(err, req);
    console.error("Error deleting/archiving patient:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

// 6. استعادة مريض من الأرشيف
const restorePatient = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const patientId = req.params.id;

    if (!isValidUuid(patientId)) {
      return res.status(400).json({ error: "معرّف المريض غير صالح" });
    }

    const result = await pool.query(
      "UPDATE patients SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND clinic_id = $2 AND is_active = FALSE RETURNING id, name",
      [patientId, clinicId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "المريض غير موجود في الأرشيف" });
    }

    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "RESTORE_PATIENT",
        entity_type: "patient",
        entity_id: patientId,
        description: `تمت استعادة ملف المريض (${result.rows[0].name}) من الأرشيف`,
      });
    } catch (auditErr) {
      console.error("Audit log failed for restorePatient:", auditErr.message);
    }

    res.status(200).json({
      message: "تمت استعادة المريض بنجاح إلى القائمة النشطة",
      patient: result.rows[0],
    });
  } catch (err) {
    captureError(err, req);
    console.error("Error restoring patient:", err.message);
    res.status(500).json({ error: "خطأ في السيرفر أثناء استعادة المريض" });
  }
};

// ==========================================
// 7. تصدير قائمة المرضى لملف Excel / CSV
// ==========================================
const exportPatients = async (req, res) => {
  try {
    const { clinic_id, role } = req.user;

    if (role !== "ClinicAdmin") {
      return res.status(403).json({
        error: "غير مصرح لك بتصدير قاعدة بيانات المرضى",
      });
    }

    const query = `
      SELECT
        name,
        phone_number,
        gender,
        TO_CHAR(date_of_birth, 'DD/MM/YYYY') AS date_of_birth,
        medical_alerts,
        TO_CHAR(
          created_at AT TIME ZONE 'Africa/Cairo',
          'DD/MM/YYYY'
        ) AS created_at
      FROM patients
      WHERE clinic_id = $1
        AND is_active = TRUE
      ORDER BY name ASC;
    `;

    const result = await pool.query(query, [clinic_id]);

    const escapeCsvValue = (value) => {
      const stringValue = String(value ?? "");

      const safeValue = /^[=+\-@]/.test(stringValue)
        ? `'${stringValue}`
        : stringValue;

      return `"${safeValue.replace(/"/g, '""')}"`;
    };

    let csv =
      "\uFEFFاسم المريض,رقم الهاتف,النوع,تاريخ الميلاد,التنبيهات الطبية,تاريخ التسجيل\n";

    result.rows.forEach((p) => {
      const name = escapeCsvValue(p.name);
      const phone = escapeCsvValue(p.phone_number);

      const gender =
        p.gender === "Female" ? "أنثى" : p.gender === "Male" ? "ذكر" : "-";

      const dob = escapeCsvValue(p.date_of_birth || "-");
      const alerts = escapeCsvValue(p.medical_alerts || "");
      const createdAt = escapeCsvValue(p.created_at || "-");

      csv += `${name},${phone},${gender},${dob},${alerts},${createdAt}\n`;
    });

    try {
      await logActivity({
        clinic_id,
        user_id: req.user.id,
        action: "EXPORT_PATIENTS",
        entity_type: "patient",
        description: `قام ${
          req.user.name || "المدير"
        } بتصدير قاعدة بيانات المرضى بصيغة CSV`,
        metadata: {
          exported_count: result.rows.length,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=patients_${Date.now()}.csv`,
    );

    return res.status(200).send(csv);
  } catch (err) {
    captureError(err, req);
    console.error("Error exporting patients:", err.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء تصدير المرضى",
    });
  }
};

// ==========================================
// 8. محلل CSV القياسي المتوافق مع RFC 4180 (يدعم النصوص متعددة الأسطر داخل علامات التنصيص)
// ==========================================
const parseCsvBuffer = (buffer) => {
  let text = buffer.toString("utf-8");
  // إزالة UTF-8 BOM إن وُجد
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  // اكتشاف الفاصلة (فاصلة عادية , أو منقوطة ;) من أول سطر
  const firstLineEnd = text.search(/\r?\n/);
  const sampleHeader = firstLineEnd !== -1 ? text.slice(0, firstLineEnd) : text;
  const delimiter =
    sampleHeader.includes(";") && !sampleHeader.includes(",") ? ";" : ",";

  // تجزئة الـ CSV كـ State Machine لاحترام الأسطر الجديدة داخل علامات التنصيص
  const rowsRaw = [];
  let currentRow = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i++; // تجاوز علامة التنصيص المهربة ""
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      currentRow.push(currentField.trim());
      currentField = "";
    } else if ((char === "\r" || char === "\n") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        i++;
      }
      currentRow.push(currentField.trim());
      if (currentRow.some((val) => val.length > 0)) {
        rowsRaw.push(currentRow);
      }
      currentRow = [];
      currentField = "";
    } else {
      currentField += char;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((val) => val.length > 0)) {
      rowsRaw.push(currentRow);
    }
  }

  if (rowsRaw.length < 2) {
    return { error: "الملف فارغ أو لا يحتوي على صفوف بيانات" };
  }

  const rawHeaders = rowsRaw[0].map((h) => h.toLowerCase().trim());

  // توحيد مسميات الأعمدة عربي وإنجليزي
  const headerMap = {};
  rawHeaders.forEach((h, idx) => {
    if (["name", "اسم", "اسم المريض", "الاسم"].includes(h))
      headerMap.name = idx;
    else if (
      [
        "phone",
        "phone_number",
        "الهاتف",
        "رقم الهاتف",
        "الموبايل",
        "تليفون",
      ].includes(h)
    )
      headerMap.phone = idx;
    else if (["gender", "النوع", "الجنس"].includes(h)) headerMap.gender = idx;
    else if (["dob", "date_of_birth", "تاريخ الميلاد", "الميلاد"].includes(h))
      headerMap.dob = idx;
    else if (
      [
        "medical_alerts",
        "alerts",
        "التنبيهات الطبية",
        "أمراض مزمنة",
        "ملاحظات",
      ].includes(h)
    )
      headerMap.alerts = idx;
  });

  if (headerMap.name === undefined || headerMap.phone === undefined) {
    return {
      error: "ملف الـ CSV يجب أن يحتوي على عمودي: (اسم المريض) و (رقم الهاتف)",
    };
  }

  const rows = [];
  for (let i = 1; i < rowsRaw.length; i++) {
    const cols = rowsRaw[i];
    if (cols.length === 0 || cols.every((c) => !c)) continue;

    rows.push({
      rowNumber: i + 1,
      name: cols[headerMap.name] || "",
      phone: cols[headerMap.phone] || "",
      gender: headerMap.gender !== undefined ? cols[headerMap.gender] : "",
      dob: headerMap.dob !== undefined ? cols[headerMap.dob] : "",
      alerts: headerMap.alerts !== undefined ? cols[headerMap.alerts] : "",
    });
  }

  return { rows };
};

const importPatientsFromCsv = async (req, res) => {
  const clinic_id = req.user.clinic_id;

  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: "يرجى اختيار ملف CSV لرفعه" });
  }

  const parsed = parseCsvBuffer(req.file.buffer);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { rows } = parsed;
  const importedPatients = [];
  const errors = [];
  const seenPhonesInFile = new Set();

  try {
    // جلب كل أرقام الهواتف الحالية في العيادة لتفادي التكرار بسرعة
    const existingPhonesRes = await pool.query(
      "SELECT phone_number FROM patients WHERE clinic_id = $1;",
      [clinic_id],
    );
    const existingPhones = new Set(
      existingPhonesRes.rows.map((r) => r.phone_number),
    );

    for (const row of rows) {
      // 1. فحص الاسم
      const cleanName = (row.name || "").trim();
      if (cleanName.length < 2) {
        errors.push({
          row: row.rowNumber,
          name: cleanName || "غير محدد",
          phone: row.phone,
          reason: "اسم المريض يجب أن يكون حرفين على الأقل",
        });
        continue;
      }

      // 2. تطبيع وفحص رقم الهاتف
      const normalizedPhone = normalizeEgyptianPhone(row.phone);
      if (!normalizedPhone) {
        errors.push({
          row: row.rowNumber,
          name: cleanName,
          phone: row.phone,
          reason: "رقم هاتف مصري غير صحيح",
        });
        continue;
      }

      // 3. فحص التكرار داخل نفس الملف
      if (seenPhonesInFile.has(normalizedPhone)) {
        errors.push({
          row: row.rowNumber,
          name: cleanName,
          phone: row.phone,
          reason: "رقم الهاتف مكرر داخل نفس الملف المرفوع",
        });
        continue;
      }

      // 4. فحص التكرار مع قاعدة البيانات
      if (existingPhones.has(normalizedPhone)) {
        errors.push({
          row: row.rowNumber,
          name: cleanName,
          phone: row.phone,
          reason: "رقم الهاتف مسجل بالفعل في العيادة مسبقاً",
        });
        continue;
      }

      // 5. فحص وتوحيد النوع
      let normalizedGender = null;
      if (row.gender && row.gender.trim() !== "") {
        const g = row.gender.trim().toLowerCase();

        if (["-", "--", "غير محدد", "none", "null"].includes(g)) {
          normalizedGender = null;
        } else if (["أنثى", "انثى", "female", "f", "ست", "سيدة"].includes(g)) {
          normalizedGender = "Female";
        } else if (["ذكر", "male", "m", "رجل"].includes(g)) {
          normalizedGender = "Male";
        } else {
          errors.push({
            row: row.rowNumber,
            name: cleanName,
            phone: row.phone,
            reason:
              "نوع المريض غير صحيح، يجب أن يكون ذكر أو أنثى أو تركه فارغاً",
          });
          continue;
        }
      }

      // 6. فحص تاريخ الميلاد الذكي
      let validDob = null;
      if (row.dob && row.dob.trim() !== "") {
        const parsedDate = parseEgyptianDate(row.dob);

        if (parsedDate === "INVALID") {
          errors.push({
            row: row.rowNumber,
            name: cleanName,
            phone: row.phone,
            reason:
              "تاريخ الميلاد غير صحيح، الصيغة المقبولة: يوم/شهر/سنة (مثال: 15/05/1995)",
          });
          continue;
        } else if (parsedDate === "FUTURE") {
          errors.push({
            row: row.rowNumber,
            name: cleanName,
            phone: row.phone,
            reason: "تاريخ الميلاد لا يمكن أن يكون اليوم أو في المستقبل",
          });
          continue;
        }

        validDob = parsedDate;
      }

      const alerts = (row.alerts || "").trim();
      const cleanAlerts =
        !alerts || ["-", "لا يوجد", "لا توجد"].includes(alerts.toLowerCase())
          ? null
          : alerts;

      seenPhonesInFile.add(normalizedPhone);

      importedPatients.push({
        name: cleanName,
        phone_number: normalizedPhone,
        gender: normalizedGender,
        date_of_birth: validDob,
        medical_alerts: cleanAlerts,
      });
    }

    // 🚀 7. إدخال المرضى بتقنية الـ Bulk Batch Insert (حزم كل 100 مريض) لتفادي الـ Timeout
    if (importedPatients.length > 0) {
      let client;
      try {
        client = await pool.connect();
        await client.query("BEGIN");

        const BATCH_SIZE = 100;
        for (let i = 0; i < importedPatients.length; i += BATCH_SIZE) {
          const batch = importedPatients.slice(i, i + BATCH_SIZE);
          const valueClauses = [];
          const queryParams = [];

          batch.forEach((p, idx) => {
            const offset = idx * 6;
            valueClauses.push(
              `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, TRUE)`,
            );
            queryParams.push(
              clinic_id,
              p.name,
              p.phone_number,
              p.gender,
              p.date_of_birth,
              p.medical_alerts,
            );
          });

          const batchQuery = `
            INSERT INTO patients (clinic_id, name, phone_number, gender, date_of_birth, medical_alerts, is_active)
            VALUES ${valueClauses.join(", ")};
          `;

          await client.query(batchQuery, queryParams);
        }

        await client.query("COMMIT");

        // تسجيل العملية في سجل الرقابة
        try {
          await logActivity({
            clinic_id,
            user_id: req.user.id,
            action: "IMPORT_PATIENTS",
            entity_type: "patient",
            description: `قام ${req.user.name || "المدير"} باستيراد ${
              importedPatients.length
            } مريض بنجاح من ملف CSV`,
            metadata: {
              imported_count: importedPatients.length,
              skipped_count: errors.length,
              total_file_rows: rows.length,
            },
          });
        } catch (auditErr) {
          console.error("Audit log failed:", auditErr.message);
        }
      } catch (dbErr) {
        if (client) await client.query("ROLLBACK");
        captureError(dbErr, req);
        console.error("Error bulk inserting patients:", dbErr.message);
        return res
          .status(500)
          .json({ error: "فشل حفظ المرضى في قاعدة البيانات" });
      } finally {
        if (client) client.release();
      }
    }

    return res.status(200).json({
      message: `تم استيراد ${importedPatients.length} مريض بنجاح`,
      summary: {
        total_rows: rows.length,
        imported_count: importedPatients.length,
        skipped_count: errors.length,
      },
      errors,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Unexpected error in importPatientsFromCsv:", error.message);
    return res
      .status(500)
      .json({ error: "حدث خطأ غير متوقع أثناء استيراد الملف" });
  }
};

module.exports = {
  addPatient,
  getPatients,
  getPatientById,
  updatePatient,
  deletePatient,
  restorePatient,
  exportPatients,
  importPatientsFromCsv,
};
