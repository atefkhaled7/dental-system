const pool = require("../db");
const { captureError } = require("../utils/errorTracker");
const { isValidUuid } = require("../middleware/validateUuid");

// الحالات الـ 9 المعتمدة للربط التلقائي مع شارت الأسنان
const VALID_RESULTING_CONDITIONS = new Set([
  "sound",
  "caries",
  "filled",
  "rct",
  "crown",
  "missing",
  "implant",
  "fracture",
  "sealant",
]);

// 1. إضافة كود إجراء جديد (مع دعم Auto-Restore إذا كان الكود محذوفاً سابقاً ودعم resulting_condition)
const createProcedureCode = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const {
    default_price,
    description,
    code,
    duration_minutes,
    resulting_condition,
  } = req.body || {};

  try {
    if (
      default_price === undefined ||
      default_price === null ||
      typeof description !== "string" ||
      !description.trim() ||
      typeof code !== "string" ||
      !code.trim()
    ) {
      return res.status(400).json({
        error: "الحقول المطلوبة غير صالحة أو فارغة",
        message: "الحقول المطلوبة غير صالحة أو فارغة",
      });
    }

    const cleanCode = code.trim().toUpperCase();
    const cleanDesc = description.trim();

    if (cleanCode.length < 1 || cleanCode.length > 50) {
      return res.status(400).json({
        error: "كود الإجراء يجب ألا يتجاوز 50 حرفاً",
        message: "كود الإجراء يجب ألا يتجاوز 50 حرفاً",
      });
    }

    if (cleanDesc.length < 2 || cleanDesc.length > 255) {
      return res.status(400).json({
        error: "وصف الإجراء يجب أن يتراوح بين حرفين و 255 حرفاً",
        message: "وصف الإجراء يجب أن يتراوح بين حرفين و 255 حرفاً",
      });
    }

    const price = parseFloat(default_price);
    if (isNaN(price) || price < 0) {
      return res.status(400).json({
        error: "السعر لا يمكن أن يكون سالبًا",
        message: "السعر لا يمكن أن يكون سالبًا",
      });
    }

    if (price > 99999999.99) {
      return res.status(400).json({
        error: "السعر يتجاوز الحد الأقصى المسموح به",
        message: "السعر يتجاوز الحد الأقصى المسموح به",
      });
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
          error: "مدة الإجراء يجب أن تكون رقماً صحيحاً بين 5 و 480 دقيقة",
          message: "مدة الإجراء يجب أن تكون رقماً صحيحاً بين 5 و 480 دقيقة",
        });
      }
      validatedDuration = parsedDuration;
    }

    // فحص الحالة الناتجة للسن (اختيارية)
    let validatedResultingCondition = null;
    if (
      resulting_condition !== undefined &&
      resulting_condition !== null &&
      resulting_condition !== ""
    ) {
      const cleanCondition = String(resulting_condition).trim().toLowerCase();
      if (!VALID_RESULTING_CONDITIONS.has(cleanCondition)) {
        return res.status(400).json({
          error: "الحالة الناتجة للسن غير صالحة",
          message: "الحالة الناتجة للسن غير صالحة",
        });
      }
      validatedResultingCondition = cleanCondition;
    }

    // 🔒 1. فحص هل الكود موجود مسبقاً في العيادة (سواء نشط أو معطل)
    const existingCheck = await pool.query(
      "SELECT id, is_active FROM procedure_codes WHERE clinic_id = $1 AND code = $2;",
      [clinic_id, cleanCode],
    );

    if (existingCheck.rows.length > 0) {
      const existing = existingCheck.rows[0];

      if (existing.is_active) {
        return res.status(400).json({
          error: "كود الإجراء مسجل بالفعل لخدمة نشطة في هذه العيادة",
          message: "كود الإجراء مسجل بالفعل لخدمة نشطة في هذه العيادة",
        });
      }

      // ✅ 2. إذا كان الكود معطلاً، نقوم بإعادة تفعيله فوراً وتحديث بياناته
      const restoreResult = await pool.query(
        `UPDATE procedure_codes
         SET is_active = true,
             description = $1,
             default_price = $2,
             duration_minutes = $3,
             resulting_condition = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 AND clinic_id = $6
         RETURNING *;`,
        [
          cleanDesc,
          price,
          validatedDuration,
          validatedResultingCondition,
          existing.id,
          clinic_id,
        ],
      );

      return res.status(200).json({
        message: "تمت إعادة تفعيل كود الإجراء وتحديث بياناته بنجاح",
        ...restoreResult.rows[0],
      });
    }

    // 3. إنشاء كود جديد إذا لم يكن موجوداً من قبل
    const result = await pool.query(
      `INSERT INTO procedure_codes (
        clinic_id,
        code,
        description,
        default_price,
        duration_minutes,
        resulting_condition,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, true)
      RETURNING *;`,
      [
        clinic_id,
        cleanCode,
        cleanDesc,
        price,
        validatedDuration,
        validatedResultingCondition,
      ],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({
        error: "كود الإجراء مسجل بالفعل في هذه العيادة",
        message: "كود الإجراء مسجل بالفعل في هذه العيادة",
      });
    }
    if (error.code === "22001") {
      return res.status(400).json({
        error: "أحد البيانات يتجاوز الحد الأقصى المسموح به للحروف",
        message: "أحد البيانات يتجاوز الحد الأقصى المسموح به للحروف",
      });
    }
    captureError(error, req);
    console.error("Error creating procedure code:", error.message);
    res.status(500).json({
      error: "حدث خطأ أثناء إنشاء كود الإجراء",
      message: "حدث خطأ أثناء إنشاء كود الإجراء",
    });
  }
};

// 2. جلب أكواد الإجراءات للعيادة
const getProcedureCodes = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { include_inactive } = req.query;

  try {
    let query = "SELECT * FROM procedure_codes WHERE clinic_id = $1";
    if (include_inactive !== "true") {
      query += " AND is_active = true";
    }
    query += " ORDER BY code ASC;";

    const result = await pool.query(query, [clinic_id]);
    res.status(200).json(result.rows);
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching procedure codes:", error.message);
    res.status(500).json({
      error: "حدث خطأ أثناء جلب أكواد الإجراءات",
      message: "حدث خطأ أثناء جلب أكواد الإجراءات",
    });
  }
};

// 3. تعديل كود إجراء (مع دعم resulting_condition)
const updateProcedureCode = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { id } = req.params;
  const {
    default_price,
    description,
    code,
    duration_minutes,
    resulting_condition,
  } = req.body || {};

  if (!isValidUuid(id)) {
    return res.status(400).json({
      error: "معرّف الإجراء غير صالح",
      message: "معرّف الإجراء غير صالح",
    });
  }

  try {
    const checkRes = await pool.query(
      `SELECT id, code, description, default_price, duration_minutes, resulting_condition
       FROM procedure_codes
       WHERE id = $1 AND clinic_id = $2 AND is_active = true;`,
      [id, clinic_id],
    );

    if (checkRes.rows.length === 0) {
      return res.status(404).json({
        error: "كود الإجراء غير موجود",
        message: "كود الإجراء غير موجود",
      });
    }

    const current = checkRes.rows[0];

    // 1. فحص وتحديث مدة الخدمة
    let finalDuration = current.duration_minutes;
    if (duration_minutes !== undefined) {
      if (duration_minutes === null || duration_minutes === "") {
        finalDuration = null;
      } else {
        const parsedDuration = Number(duration_minutes);
        if (
          !Number.isInteger(parsedDuration) ||
          parsedDuration < 5 ||
          parsedDuration > 480
        ) {
          return res.status(400).json({
            error: "مدة الإجراء يجب أن تكون رقماً صحيحاً بين 5 و 480 دقيقة",
            message: "مدة الإجراء يجب أن تكون رقماً صحيحاً بين 5 و 480 دقيقة",
          });
        }
        finalDuration = parsedDuration;
      }
    }

    // 2. فحص وتحديث السعر
    let finalPrice = current.default_price;
    if (default_price !== undefined && default_price !== null) {
      const p = parseFloat(default_price);
      if (isNaN(p) || p < 0) {
        return res.status(400).json({
          error: "السعر لا يمكن أن يكون سالبًا",
          message: "السعر لا يمكن أن يكون سالبًا",
        });
      }
      if (p > 99999999.99) {
        return res.status(400).json({
          error: "السعر يتجاوز الحد الأقصى المسموح به",
          message: "السعر يتجاوز الحد الأقصى المسموح به",
        });
      }
      finalPrice = p;
    }

    // 3. فحص وتحديث الحالة الناتجة للسن
    let finalResultingCondition = current.resulting_condition;
    if (resulting_condition !== undefined) {
      if (resulting_condition === null || resulting_condition === "") {
        finalResultingCondition = null;
      } else {
        const cleanCondition = String(resulting_condition).trim().toLowerCase();
        if (!VALID_RESULTING_CONDITIONS.has(cleanCondition)) {
          return res.status(400).json({
            error: "الحالة الناتجة للسن غير صالحة",
            message: "الحالة الناتجة للسن غير صالحة",
          });
        }
        finalResultingCondition = cleanCondition;
      }
    }

    // 4. فحص الكود وتفادي تكرار الأكواد
    let finalCode = current.code;
    if (code && typeof code === "string") {
      const candidateCode = code.trim().toUpperCase();

      if (candidateCode.length < 1 || candidateCode.length > 50) {
        return res.status(400).json({
          error: "كود الإجراء يجب ألا يتجاوز 50 حرفاً",
          message: "كود الإجراء يجب ألا يتجاوز 50 حرفاً",
        });
      }

      if (candidateCode !== current.code) {
        const conflictCheck = await pool.query(
          "SELECT id, is_active FROM procedure_codes WHERE clinic_id = $1 AND code = $2 AND id != $3;",
          [clinic_id, candidateCode, id],
        );

        if (conflictCheck.rows.length > 0) {
          const conflict = conflictCheck.rows[0];
          if (conflict.is_active) {
            return res.status(400).json({
              error: "كود الإجراء مسجل بالفعل لخدمة نشطة أخرى",
              message: "كود الإجراء مسجل بالفعل لخدمة نشطة أخرى",
            });
          } else {
            await pool.query(
              "UPDATE procedure_codes SET code = code || '_OLD_' || SUBSTRING(id::text, 1, 6) WHERE id = $1;",
              [conflict.id],
            );
          }
        }
        finalCode = candidateCode;
      }
    }

    let finalDescription = current.description;
    if (description !== undefined && description !== null) {
      const cleanDesc =
        typeof description === "string" ? description.trim() : "";
      if (cleanDesc.length < 2 || cleanDesc.length > 255) {
        return res.status(400).json({
          error: "وصف الإجراء يجب أن يتراوح بين حرفين و 255 حرفاً",
          message: "وصف الإجراء يجب أن يتراوح بين حرفين و 255 حرفاً",
        });
      }
      finalDescription = cleanDesc;
    }

    const result = await pool.query(
      `UPDATE procedure_codes
       SET code = $1,
           description = $2,
           default_price = $3,
           duration_minutes = $4,
           resulting_condition = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 AND clinic_id = $7
       RETURNING *;`,
      [
        finalCode,
        finalDescription,
        finalPrice,
        finalDuration,
        finalResultingCondition,
        id,
        clinic_id,
      ],
    );

    res.status(200).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({
        error: "كود الإجراء مسجل بالفعل لخدمة أخرى",
        message: "كود الإجراء مسجل بالفعل لخدمة أخرى",
      });
    }
    if (error.code === "22001") {
      return res.status(400).json({
        error: "أحد البيانات يتجاوز الحد الأقصى المسموح به للحروف",
        message: "أحد البيانات يتجاوز الحد الأقصى المسموح به للحروف",
      });
    }
    captureError(error, req);
    console.error("Error updating procedure code:", error.message);
    res.status(500).json({
      error: "حدث خطأ أثناء تعديل كود الإجراء",
      message: "حدث خطأ أثناء تعديل كود الإجراء",
    });
  }
};

// 4. تعطيل / حذف كود إجراء (Soft Delete)
const deleteProcedureCode = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({
      error: "معرّف الإجراء غير صالح",
      message: "معرّف الإجراء غير صالح",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE procedure_codes
       SET is_active = false, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND clinic_id = $2 AND is_active = true
       RETURNING id, code;`,
      [id, clinic_id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "كود الإجراء غير موجود أو معطل بالفعل",
        message: "كود الإجراء غير موجود أو معطل بالفعل",
      });
    }

    res.status(200).json({
      message: "تم تعطيل كود الإجراء بنجاح",
      procedure: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error deleting procedure code:", error.message);
    res.status(500).json({
      error: "حدث خطأ أثناء تعطيل كود الإجراء",
      message: "حدث خطأ أثناء تعطيل كود الإجراء",
    });
  }
};

// 5. استعادة كود إجراء معطل (Restore Procedure Code)
const restoreProcedureCode = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({
      error: "معرّف الإجراء غير صالح",
      message: "معرّف الإجراء غير صالح",
    });
  }

  try {
    const checkRes = await pool.query(
      "SELECT id, code, is_active FROM procedure_codes WHERE id = $1 AND clinic_id = $2;",
      [id, clinic_id],
    );

    if (checkRes.rows.length === 0) {
      return res.status(404).json({
        error: "كود الإجراء غير موجود",
        message: "كود الإجراء غير موجود",
      });
    }

    if (checkRes.rows[0].is_active) {
      return res.status(400).json({
        error: "كود الإجراء نشط بالفعل",
        message: "كود الإجراء نشط بالفعل",
      });
    }

    const result = await pool.query(
      `UPDATE procedure_codes
       SET is_active = true, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND clinic_id = $2
       RETURNING *;`,
      [id, clinic_id],
    );

    res.status(200).json({
      message: "تمت استعادة كود الإجراء بنجاح",
      procedure: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error restoring procedure code:", error.message);
    res.status(500).json({
      error: "حدث خطأ أثناء استعادة كود الإجراء",
      message: "حدث خطأ أثناء استعادة كود الإجراء",
    });
  }
};

module.exports = {
  createProcedureCode,
  getProcedureCodes,
  updateProcedureCode,
  deleteProcedureCode,
  restoreProcedureCode,
};
