const pool = require("../db");
const { captureError } = require("../utils/errorTracker");

// 1. إضافة كود إجراء جديد مع دعم مدة الخدمة
const createProcedureCode = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { default_price, description, code, duration_minutes } = req.body;

  try {
    if (
      default_price === undefined ||
      default_price === null ||
      !description ||
      !code
    ) {
      return res.status(400).json({ message: "يوجد حقل فارغ مطلوب!" });
    }

    const price = parseFloat(default_price);
    if (isNaN(price) || price < 0) {
      return res.status(400).json({ message: "السعر لا يمكن أن يكون سالبًا" });
    }

    // فحص مدة الخدمة بالدقائق (اختيارية، بين 5 و 480 دقيقة)
    let validatedDuration = null;
    if (
      duration_minutes !== undefined &&
      duration_minutes !== null &&
      duration_minutes !== ""
    ) {
      const parsedDuration = Number(duration_minutes);
      if (
        !Number.isInteger(parsedDuration) ||
        parsedDuration < 5 ||
        parsedDuration > 480
      ) {
        return res.status(400).json({
          message: "مدة الإجراء يجب أن تكون رقماً صحيحاً بين 5 و 480 دقيقة",
        });
      }
      validatedDuration = parsedDuration;
    }

    const cleanCode = code.trim().toUpperCase();
    const result = await pool.query(
      `INSERT INTO procedure_codes (clinic_id, code, description, default_price, duration_minutes) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *;`,
      [clinic_id, cleanCode, description.trim(), price, validatedDuration],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res
        .status(400)
        .json({ message: "كود الإجراء مسجل بالفعل في هذه العيادة" });
    }
    captureError(error, req);
    console.error("Error creating procedure code:", error.message);
    res.status(500).json({ message: "حدث خطأ أثناء إنشاء كود الإجراء" });
  }
};

// 2. جلب جميع أكواد الإجراءات النشطة للعيادة
const getProcedureCodes = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  try {
    const result = await pool.query(
      "SELECT * FROM procedure_codes WHERE clinic_id = $1 AND is_active = true ORDER BY code ASC;",
      [clinic_id],
    );
    res.status(200).json(result.rows);
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching procedure codes:", error.message);
    res.status(500).json({ message: "حدث خطأ أثناء جلب أكواد الإجراءات" });
  }
};

// 3. تعديل كود إجراء (الاسم، السعر، والمدة مع الحفاظ على البيانات غير المعدلة)
const updateProcedureCode = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { id } = req.params;
  const { default_price, description, code, duration_minutes } = req.body;

  try {
    // جلب البيانات الحالية للخدمة
    const checkRes = await pool.query(
      "SELECT id, code, description, default_price, duration_minutes FROM procedure_codes WHERE id = $1 AND clinic_id = $2 AND is_active = true;",
      [id, clinic_id],
    );

    if (checkRes.rows.length === 0) {
      return res.status(404).json({ message: "كود الإجراء غير موجود" });
    }

    const current = checkRes.rows[0];

    // 1. فحص وتحديث مدة الخدمة (لو متبعتتش نحتفظ بالمدة القديمة)
    let finalDuration = current.duration_minutes;
    if (duration_minutes !== undefined) {
      if (duration_minutes === null || duration_minutes === "") {
        finalDuration = null; // مسح المدة إذا طُلب ذلك صراحة
      } else {
        const parsedDuration = Number(duration_minutes);
        if (
          !Number.isInteger(parsedDuration) ||
          parsedDuration < 5 ||
          parsedDuration > 480
        ) {
          return res.status(400).json({
            message: "مدة الإجراء يجب أن تكون رقماً صحيحاً بين 5 و 480 دقيقة",
          });
        }
        finalDuration = parsedDuration;
      }
    }

    // 2. فحص وتحديث السعر (لو متبعتش نحتفظ بالسعر القديم)
    let finalPrice = current.default_price;
    if (default_price !== undefined && default_price !== null) {
      const p = parseFloat(default_price);
      if (isNaN(p) || p < 0) {
        return res
          .status(400)
          .json({ message: "السعر لا يمكن أن يكون سالبًا" });
      }
      finalPrice = p;
    }

    // 3. الكود والوصف
    const finalCode = code ? code.trim().toUpperCase() : current.code;
    const finalDescription =
      description != null ? description.trim() : current.description;

    const result = await pool.query(
      `UPDATE procedure_codes
       SET code = $1,
           description = $2,
           default_price = $3,
           duration_minutes = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 AND clinic_id = $6
       RETURNING *;`,
      [finalCode, finalDescription, finalPrice, finalDuration, id, clinic_id],
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res
        .status(400)
        .json({ message: "كود الإجراء مسجل بالفعل لخدمة أخرى" });
    }
    captureError(error, req);
    console.error("Error updating procedure code:", error.message);
    res.status(500).json({ message: "حدث خطأ أثناء تعديل كود الإجراء" });
  }
};

// 4. تعطيل / حذف كود إجراء (Soft Delete)
const deleteProcedureCode = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `UPDATE procedure_codes
       SET is_active = false, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND clinic_id = $2 AND is_active = true
       RETURNING id, code;`,
      [id, clinic_id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "كود الإجراء غير موجود" });
    }

    res.status(200).json({ message: "تم تعطيل كود الإجراء بنجاح" });
  } catch (error) {
    captureError(error, req);
    console.error("Error deleting procedure code:", error.message);
    res.status(500).json({ message: "حدث خطأ أثناء تعطيل كود الإجراء" });
  }
};

module.exports = {
  createProcedureCode,
  getProcedureCodes,
  updateProcedureCode,
  deleteProcedureCode,
};
