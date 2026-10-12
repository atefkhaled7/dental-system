const pool = require("../db");
const bcrypt = require("bcrypt");
const { logActivity } = require("../utils/auditLogger");
const { captureError } = require("../utils/errorTracker");
const { isValidUuid } = require("../middleware/validateUuid");

// 1. جلب طاقم العيادة الحالية
const getClinicStaff = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const result = await pool.query(
      `
      SELECT id, name, email, role, is_active, created_at
      FROM users
      WHERE clinic_id = $1
      ORDER BY created_at ASC
      `,
      [clinicId],
    );
    return res.status(200).json({
      staff: result.rows,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching staff:", error.message);
    return res.status(500).json({
      error: "خطأ في السيرفر أثناء جلب الطاقم",
    });
  }
};

// 2. إضافة موظف جديد بالعيادة
const addStaffMember = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({
        error: "جميع الحقول مطلوبة",
      });
    }

    if (!["Doctor", "Receptionist"].includes(role)) {
      return res.status(400).json({
        error: "الدور يجب أن يكون Doctor أو Receptionist",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "كلمة المرور يجب أن لا تقل عن 8 أحرف",
      });
    }

    if (password.length > 72) {
      return res.status(400).json({
        error: "كلمة المرور يجب أن لا تتجاوز 72 حرفاً",
      });
    }

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (!cleanName || !cleanEmail) {
      return res.status(400).json({
        error: "الاسم والبريد الإلكتروني مطلوبان",
      });
    }

    if (cleanName.length > 100) {
      return res.status(400).json({
        error: "اسم الموظف يجب ألا يتجاوز 100 حرف",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail) || cleanEmail.length > 255) {
      return res.status(400).json({
        error: "صيغة البريد الإلكتروني غير صالحة",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const query = `
      INSERT INTO users (
        clinic_id,
        name,
        email,
        password,
        role,
        is_active,
        token_version
      )
      VALUES ($1, $2, $3, $4, $5, TRUE, 1)
      RETURNING id, name, email, role, is_active, created_at;
    `;

    const result = await pool.query(query, [
      clinicId,
      cleanName,
      cleanEmail,
      hashedPassword,
      role,
    ]);

    const createdMember = result.rows[0];

    // 🔒 تسجيل العملية في الرقابة
    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "CREATE_STAFF",
        entity_type: "user",
        entity_id: createdMember.id,
        description: `قام ${req.user.name || "المدير"} بإضافة موظف جديد (${createdMember.name}) بدور: ${createdMember.role}`,
      });
    } catch (auditErr) {
      captureError(auditErr, req);
    }

    return res.status(201).json({
      message: "تمت إضافة الموظف بنجاح",
      member: createdMember,
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({
        error: "البريد الإلكتروني مسجل بالفعل لمستخدم آخر",
      });
    }
    if (error.code === "22001") {
      return res.status(400).json({
        error: "أحد البيانات المدخلة يتجاوز الحد الأقصى المسموح به",
      });
    }
    captureError(error, req);
    console.error("Error adding staff member:", error.message);
    return res.status(500).json({
      error: "خطأ في السيرفر أثناء إضافة الموظف",
    });
  }
};

// 3. تعطيل أو تفعيل حساب موظف (مع دعم Idempotent Boolean وإبطال الجلسات عند التعطيل)
const toggleStaffStatus = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const targetUserId = req.params.id;

    if (!isValidUuid(targetUserId)) {
      return res.status(400).json({
        error: "معرّف الموظف غير صالح",
      });
    }

    // منع الأدمن من تعطيل نفسه
    if (targetUserId === req.user.id) {
      return res.status(400).json({
        error: "لا يمكنك تعطيل حسابك الشخصي",
      });
    }

    const { is_active } = req.body || {};
    let query;
    let queryParams;

    // لو الـ frontend بعت قيمة boolean صريحة نجعل العملية Idempotent
    if (typeof is_active === "boolean") {
      query = `
        UPDATE users
        SET is_active = $1,
            token_version = CASE WHEN $1 = FALSE THEN COALESCE(token_version, 1) + 1 ELSE token_version END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
          AND clinic_id = $3
          AND role IN ('Doctor', 'Receptionist')
        RETURNING id, name, role, is_active;
      `;
      queryParams = [is_active, targetUserId, clinicId];
    } else {
      // التوافق القديم في حال تم استدعاء الـ endpoint بدون body
      query = `
        UPDATE users
        SET is_active = NOT is_active,
            token_version = COALESCE(token_version, 1) + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND clinic_id = $2
          AND role IN ('Doctor', 'Receptionist')
        RETURNING id, name, role, is_active;
      `;
      queryParams = [targetUserId, clinicId];
    }

    const result = await pool.query(query, queryParams);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "الموظف غير موجود في هذه العيادة",
      });
    }

    const updated = result.rows[0];

    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: updated.is_active ? "ENABLE_STAFF" : "DISABLE_STAFF",
        entity_type: "user",
        entity_id: targetUserId,
        description: `قام ${req.user.name || "المدير"} بـ ${
          updated.is_active ? "تفعيل" : "إيقاف"
        } حساب الموظف (${updated.name}) دور: ${updated.role}`,
      });
    } catch (auditErr) {
      console.error(
        "Audit log failed for toggleStaffStatus:",
        auditErr.message,
      );
    }

    return res.status(200).json({
      message: updated.is_active
        ? "تم تفعيل الحساب بنجاح"
        : "تم إيقاف الحساب وطرد الجلسات النشطة بنجاح",
      member: updated,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error toggling staff status:", error.message);
    return res.status(500).json({
      error: "خطأ في السيرفر أثناء تعديل حالة الحساب",
    });
  }
};

// 4. إعادة تعيين باسورد موظف بواسطة الأدمن
const resetStaffPassword = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const targetUserId = req.params.id;
    const { new_password } = req.body;

    if (!isValidUuid(targetUserId)) {
      return res.status(400).json({
        error: "معرّف الموظف غير صالح",
      });
    }

    if (!new_password || new_password.length < 8) {
      return res.status(400).json({
        error: "كلمة المرور الجديدة يجب أن لا تقل عن 8 أحرف",
      });
    }

    if (new_password.length > 72) {
      return res.status(400).json({
        error: "كلمة المرور الجديدة يجب أن لا تتجاوز 72 حرفاً",
      });
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);

    const query = `
      UPDATE users 
      SET password = $1, 
          token_version = COALESCE(token_version, 1) + 1, 
          updated_at = CURRENT_TIMESTAMP 
      WHERE id = $2 AND clinic_id = $3
        AND role IN ('Doctor', 'Receptionist')
      RETURNING id, name;
    `;

    const result = await pool.query(query, [
      hashedPassword,
      targetUserId,
      clinicId,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "الموظف غير موجود في هذه العيادة",
      });
    }

    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "RESET_STAFF_PASSWORD",
        entity_type: "user",
        entity_id: targetUserId,
        description: `قام ${
          req.user.name || "المدير"
        } بإعادة تعيين كلمة مرور الموظف (${result.rows[0].name})`,
      });
    } catch (auditErr) {
      console.error(
        "Audit log failed for resetStaffPassword:",
        auditErr.message,
      );
    }

    return res.status(200).json({
      message: "تمت إعادة تعيين كلمة المرور وطرد الجلسات القديمة بنجاح",
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error resetting staff password:", error.message);
    return res.status(500).json({
      error: "خطأ في السيرفر أثناء تعيين كلمة المرور",
    });
  }
};

// 5. تعديل اسم موظف بواسطة الأدمن
const updateStaffName = async (req, res) => {
  try {
    const clinicId = req.user.clinic_id;
    const targetUserId = req.params.id;
    const { name } = req.body;

    if (!isValidUuid(targetUserId)) {
      return res.status(400).json({
        error: "معرّف الموظف غير صالح",
      });
    }

    if (!name || name.trim().length < 2) {
      return res
        .status(400)
        .json({ error: "الاسم مطلوب ويجب أن لا يقل عن حرفين" });
    }

    if (name.trim().length > 100) {
      return res.status(400).json({ error: "الاسم يجب ألا يتجاوز 100 حرف" });
    }

    const result = await pool.query(
      `UPDATE users 
       SET name = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 AND clinic_id = $3 AND role IN ('Doctor', 'Receptionist')
       RETURNING id, name, role;`,
      [name.trim(), targetUserId, clinicId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الموظف غير موجود" });
    }

    try {
      await logActivity({
        clinic_id: clinicId,
        user_id: req.user.id,
        action: "UPDATE_STAFF",
        entity_type: "user",
        entity_id: targetUserId,
        description: `قام ${req.user.name || "المدير"} بتعديل اسم الموظف (${result.rows[0].name})`,
      });
    } catch (auditErr) {
      captureError(auditErr, req);
    }

    res.status(200).json({
      message: "تم تعديل اسم الموظف بنجاح",
      member: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error updating staff name:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

// 6. تعديل الاسم الشخصي للمستخدم الحالي
const updateMyProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name } = req.body;

    if (!name || name.trim().length < 2) {
      return res
        .status(400)
        .json({ error: "الاسم مطلوب ويجب أن لا يقل عن حرفين" });
    }

    if (name.trim().length > 100) {
      return res.status(400).json({ error: "الاسم يجب ألا يتجاوز 100 حرف" });
    }

    const result = await pool.query(
      `UPDATE users SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, name, email, role;`,
      [name.trim(), userId],
    );

    res.status(200).json({
      message: "تم تحديث اسمك بنجاح",
      user: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error updating profile:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

// 7. تغيير كلمة المرور الشخصية للمستخدم الحالي (مع إبطال التوكنز القديمة فوراً)
const changeMyPassword = async (req, res) => {
  try {
    const userId = req.user.id;
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res
        .status(400)
        .json({ error: "يرجى إدخال كلمة المرور الحالية والجديدة" });
    }

    if (new_password.length < 8) {
      return res
        .status(400)
        .json({ error: "كلمة المرور الجديدة يجب أن لا تقل عن 8 أحرف" });
    }

    if (new_password.length > 72) {
      return res
        .status(400)
        .json({ error: "كلمة المرور الجديدة يجب أن لا تتجاوز 72 حرفاً" });
    }

    if (current_password === new_password) {
      return res
        .status(400)
        .json({
          error:
            "كلمة المرور الجديدة يجب أن تكون مختلفة عن كلمة المرور الحالية",
        });
    }

    const userRes = await pool.query(
      `SELECT password FROM users WHERE id = $1`,
      [userId],
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    const isMatch = await bcrypt.compare(
      current_password,
      userRes.rows[0].password,
    );

    if (!isMatch) {
      return res.status(400).json({ error: "كلمة المرور الحالية غير صحيحة" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(new_password, salt);

    // 🔒 تحديث الباسورد وإبطال كل الجلسات السابقة بزيادة token_version
    await pool.query(
      `UPDATE users 
       SET password = $1, 
           token_version = COALESCE(token_version, 1) + 1, 
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [hashedPassword, userId],
    );

    try {
      await logActivity({
        clinic_id: req.user.clinic_id,
        user_id: userId,
        action: "CHANGE_MY_PASSWORD",
        entity_type: "user",
        entity_id: userId,
        description: `قام المستخدم (${req.user.name || "عضو الطاقم"}) بتغيير كلمة المرور الخاصة به`,
      });
    } catch (auditErr) {
      captureError(auditErr, req);
    }

    res.status(200).json({
      message:
        "تم تغيير كلمة المرور بنجاح وإلغاء تسجيل الدخول من الأجهزة الأخرى",
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error changing password:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر" });
  }
};

module.exports = {
  getClinicStaff,
  addStaffMember,
  toggleStaffStatus,
  resetStaffPassword,
  updateStaffName,
  updateMyProfile,
  changeMyPassword,
};
