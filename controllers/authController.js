const pool = require("../db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { logActivity } = require("../utils/auditLogger");
const { captureError } = require("../utils/errorTracker");
const { sendResetPasswordEmail } = require("../services/emailService");

const registerUser = async (req, res) => {
  try {
    const { name, email, password, role } = req.body || {};

    if (!name || !email || !password || !role) {
      return res.status(400).json({
        error: "جميع الحقول مطلوبة",
        code: "VALIDATION_ERROR",
      });
    }

    let targetClinicId = req.user.clinic_id;

    if (req.user.role === "SuperAdmin") {
      targetClinicId = req.body?.clinic_id || null;
    } else if (req.user.role === "ClinicAdmin") {
      if (!["Doctor", "Receptionist"].includes(role)) {
        return res.status(403).json({
          error:
            "غير مصرح لك بمنح هذا الدور. الأدوار المتاحة: Doctor أو Receptionist فقط",
          code: "FORBIDDEN_ROLE",
        });
      }
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const result = await pool.query(
      `INSERT INTO users (clinic_id, name, email, password, role) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, name, email, role, clinic_id;`,
      [targetClinicId, name, email.trim().toLowerCase(), hashedPassword, role],
    );

    res.status(201).json({
      message: "تم تسجيل المستخدم بنجاح",
      user: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).json({
        error: "البريد الإلكتروني مسجل بالفعل",
        code: "EMAIL_ALREADY_EXISTS",
      });
    }
    captureError(error, req);
    console.error("Error registering user:", error.message);
    res.status(500).json({ error: "خطأ في السيرفر", code: "SERVER_ERROR" });
  }
};

const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({
        error: "يرجى إدخال البريد الإلكتروني وكلمة المرور",
        code: "VALIDATION_ERROR",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const result = await pool.query(
      `
      SELECT
        users.*,
        clinics.is_active AS clinic_is_active,
        clinics.subscription_ends_at
      FROM users
      LEFT JOIN clinics ON users.clinic_id = clinics.id
      WHERE users.email = $1
      `,
      [normalizedEmail],
    );
    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "بيانات الدخول غير صحيحة",
        code: "INVALID_CREDENTIALS",
      });
    }
    const user = result.rows[0];

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({
        error: "بيانات الدخول غير صحيحة",
        code: "INVALID_CREDENTIALS",
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        error: "تم إيقاف حسابك من قبل إدارة العيادة. يرجى مراجعة المدير.",
        code: "USER_DEACTIVATED",
      });
    }

    if (user.role !== "SuperAdmin") {
      if (!user.clinic_id || user.clinic_is_active === false) {
        return res.status(403).json({
          error: "تم تجميد حساب هذه العيادة. يرجى التواصل مع إدارة CUROSTA.",
          code: "CLINIC_DEACTIVATED",
        });
      }
    }

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role,
        clinic_id: user.clinic_id,
        token_version: user.token_version || 1,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "12h",
      },
    );

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        clinic_id: user.clinic_id,
        subscription_ends_at: user.subscription_ends_at,
      },
    });
  } catch (error) {
    captureError(error, req);
    console.error("Login error:", error.message);

    return res.status(500).json({
      error: "Server Error",
      code: "SERVER_ERROR",
    });
  }
};

const registerClinic = async (req, res) => {
  let client;

  try {
    const { clinic_name, phone_number, admin_name, email, password } =
      req.body || {};

    if (!clinic_name || !clinic_name.trim()) {
      return res.status(400).json({
        error: "اسم العيادة مطلوب",
        code: "VALIDATION_ERROR",
      });
    }

    if (!admin_name || !admin_name.trim()) {
      return res.status(400).json({
        error: "اسم مدير العيادة مطلوب",
        code: "VALIDATION_ERROR",
      });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({
        error: "البريد الإلكتروني مطلوب",
        code: "VALIDATION_ERROR",
      });
    }

    if (!password || !password.trim()) {
      return res.status(400).json({
        error: "كلمة المرور مطلوبة",
        code: "VALIDATION_ERROR",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل",
        code: "VALIDATION_ERROR",
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({
        error: "البريد الإلكتروني غير صالح",
        code: "VALIDATION_ERROR",
      });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const slugBase = clinic_name
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const clinicSlug = `${slugBase || "clinic"}-${crypto.randomBytes(4).toString("hex")}`;

    const clinicResult = await client.query(
      `
      INSERT INTO clinics (
        name,
        phone_number,
        slug,
        is_active,
        subscription_ends_at
      )
      VALUES (
        $1,
        $2,
        $3,
        TRUE,
        CURRENT_TIMESTAMP + INTERVAL '14 days'
      )
      RETURNING
        id,
        name,
        phone_number,
        slug,
        is_active,
        subscription_ends_at;
      `,
      [clinic_name.trim(), phone_number?.trim() || null, clinicSlug],
    );

    const newClinic = clinicResult.rows[0];

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const userResult = await client.query(
      `
      INSERT INTO users (
        clinic_id,
        name,
        email,
        password,
        role
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, email, role, clinic_id
      `,
      [
        newClinic.id,
        admin_name.trim(),
        email.trim().toLowerCase(),
        hashedPassword,
        "ClinicAdmin",
      ],
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Clinic and admin user registered successfully",
      clinic: newClinic,
      admin: userResult.rows[0],
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Rollback error:", rollbackError.message);
      }
    }

    if (error.code === "23505") {
      return res.status(400).json({
        error: "البريد الإلكتروني مسجل بالفعل",
        code: "EMAIL_ALREADY_EXISTS",
      });
    }

    console.error("Transaction error:", error.message);
    captureError(error, req);
    return res.status(500).json({
      error: "فشل التسجيل",
      code: "SERVER_ERROR",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
};

const getDoctors = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, name
      FROM users
      WHERE clinic_id = $1
        AND role = 'Doctor'
        AND is_active = TRUE
      ORDER BY name ASC
      `,
      [req.user.clinic_id],
    );

    return res.status(200).json({
      doctors: result.rows,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching doctors:", error.message);

    return res.status(500).json({
      error: "خطأ في السيرفر",
      code: "SERVER_ERROR",
    });
  }
};

const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name } = req.body || {};

    if (!name || name.trim().length < 2) {
      return res.status(400).json({
        error: "الاسم مطلوب ويجب أن يحتوي على حرفين على الأقل",
        code: "VALIDATION_ERROR",
      });
    }

    if (
      ["demo@curosta.com", "doctor.demo@curosta.com"].includes(
        req.user.email?.toLowerCase(),
      )
    ) {
      return res.status(403).json({
        error: "هذا الحساب تجريبي للعرض فقط، لا يمكن تعديل بياناته الشخصية.",
        code: "DEMO_ACCOUNT_RESTRICTED",
      });
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
    res.status(500).json({
      error: "خطأ في السيرفر أثناء تعديل الاسم",
      code: "SERVER_ERROR",
    });
  }
};

const changePassword = async (req, res) => {
  try {
    const userId = req.user.id;
    const { current_password, new_password } = req.body || {};

    if (!current_password || !new_password) {
      return res.status(400).json({
        error: "يرجى إدخال كلمة المرور الحالية والجديدة",
        code: "VALIDATION_ERROR",
      });
    }

    if (
      ["demo@curosta.com", "doctor.demo@curosta.com"].includes(
        req.user.email?.toLowerCase(),
      )
    ) {
      return res.status(403).json({
        error:
          "هذا الحساب تجريبي للعرض فقط، لا يمكن تغيير كلمة المرور الخاصة به.",
        code: "DEMO_ACCOUNT_RESTRICTED",
      });
    }

    if (new_password.length < 8) {
      return res.status(400).json({
        error: "كلمة المرور الجديدة يجب أن لا تقل عن 8 أحرف",
        code: "VALIDATION_ERROR",
      });
    }

    const userRes = await pool.query(
      "SELECT password FROM users WHERE id = $1",
      [userId],
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({
        error: "المستخدم غير موجود",
        code: "USER_NOT_FOUND",
      });
    }

    const isMatch = await bcrypt.compare(
      current_password,
      userRes.rows[0].password,
    );
    if (!isMatch) {
      return res.status(400).json({
        error: "كلمة المرور الحالية غير صحيحة",
        code: "INVALID_CURRENT_PASSWORD",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(new_password, salt);

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
        action: "CHANGE_PASSWORD",
        entity_type: "user",
        entity_id: userId,
        description: `قام ${
          req.user.name || "المستخدم"
        } بتغيير كلمة المرور الخاصة به وإبطال الجلسات السابقة`,
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    res.status(200).json({
      message: "تم تغيير كلمة المرور بنجاح، تم إنهاء الجلسات السابقة",
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error changing password:", error.message);
    res.status(500).json({
      error: "خطأ في السيرفر أثناء تغيير كلمة المرور",
      code: "SERVER_ERROR",
    });
  }
};

const getMe = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT users.id, users.name, users.email, users.role, users.clinic_id,
              clinics.name AS clinic_name, clinics.is_active AS clinic_is_active,
              clinics.subscription_ends_at
       FROM users
       LEFT JOIN clinics ON users.clinic_id = clinics.id
       WHERE users.id = $1`,
      [req.user.id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "المستخدم غير موجود",
        code: "USER_NOT_FOUND",
      });
    }

    res.status(200).json({ user: result.rows[0] });
  } catch (error) {
    captureError(error, req);
    console.error("Error in getMe:", error.message);
    res.status(500).json({
      error: "خطأ في السيرفر",
      code: "SERVER_ERROR",
    });
  }
};

// --- استعادة كلمة المرور (Forgot / Reset Password) ---

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email || !email.trim()) {
      return res.status(400).json({
        error: "يرجى إدخال البريد الإلكتروني",
        code: "VALIDATION_ERROR",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const userRes = await pool.query(
      `SELECT id, name, email, clinic_id, is_active FROM users WHERE email = $1`,
      [normalizedEmail],
    );

    // حماية الخصوصية ومنع User Enumeration وحماية حسابات الـ Demo
    if (
      userRes.rows.length === 0 ||
      !userRes.rows[0].is_active ||
      ["demo@curosta.com", "doctor.demo@curosta.com"].includes(normalizedEmail)
    ) {
      return res.status(200).json({
        message:
          "إذا كان هذا البريد مسجلاً لدينا، فستتلقى رابطاً لإعادة تعيين كلمة المرور خلال دقائق.",
      });
    }

    const user = userRes.rows[0];

    // توليد التوكن الخام والهاش للتخزين في الداتابيز
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    // صلاحية 30 دقيقة
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    // تنظيف أي توكنات قديمة غير مستخدمة لنفس المستخدم
    await pool.query(
      `DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    );

    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt],
    );

    const frontendBaseUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const resetUrl = `${frontendBaseUrl.replace(/\/$/, "")}/reset-password?token=${rawToken}`;

    await sendResetPasswordEmail({
      to: user.email,
      name: user.name,
      resetUrl,
    });

    if (user.clinic_id) {
      try {
        await logActivity({
          clinic_id: user.clinic_id,
          user_id: user.id,
          action: "FORGOT_PASSWORD_REQUEST",
          entity_type: "user",
          entity_id: user.id,
          description: `طلب استعادة كلمة المرور للمستخدم (${user.email})`,
        });
      } catch (auditError) {
        console.error("Audit log failed:", auditError.message);
      }
    }

    return res.status(200).json({
      message:
        "إذا كان هذا البريد مسجلاً لدينا، فستتلقى رابطاً لإعادة تعيين كلمة المرور خلال دقائق.",
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error in forgotPassword:", error.message);
    return res.status(500).json({
      error: "خطأ في السيرفر أثناء طلب استعادة كلمة المرور",
      code: "SERVER_ERROR",
    });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { token, new_password } = req.body || {};

    if (!token || !new_password) {
      return res.status(400).json({
        error: "التوكن وكلمة المرور الجديدة مطلوبان",
        code: "VALIDATION_ERROR",
      });
    }

    if (new_password.length < 8) {
      return res.status(400).json({
        error: "كلمة المرور الجديدة يجب أن لا تقل عن 8 أحرف",
        code: "VALIDATION_ERROR",
      });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const tokenRes = await pool.query(
      `
      SELECT prt.id AS token_id, prt.user_id, u.clinic_id, u.name, u.email
      FROM password_reset_tokens prt
      JOIN users u ON prt.user_id = u.id
      WHERE prt.token_hash = $1
        AND prt.used_at IS NULL
        AND prt.expires_at > CURRENT_TIMESTAMP
      LIMIT 1;
      `,
      [tokenHash],
    );

    if (tokenRes.rows.length === 0) {
      return res.status(400).json({
        error: "رابط استعادة كلمة المرور غير صالح أو انتهت صلاحيته",
        code: "INVALID_OR_EXPIRED_TOKEN",
      });
    }

    const tokenRecord = tokenRes.rows[0];

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(new_password, salt);

    // تحديث كلمة المرور، زيادة token_version لإنهاء أي جلسات مفتوحة، وتعليم التوكن كمستخدم
    await pool.query(
      `UPDATE users 
       SET password = $1, 
           token_version = COALESCE(token_version, 1) + 1, 
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [hashedPassword, tokenRecord.user_id],
    );

    await pool.query(
      `UPDATE password_reset_tokens 
       SET used_at = CURRENT_TIMESTAMP 
       WHERE id = $1`,
      [tokenRecord.token_id],
    );

    if (tokenRecord.clinic_id) {
      try {
        await logActivity({
          clinic_id: tokenRecord.clinic_id,
          user_id: tokenRecord.user_id,
          action: "RESET_PASSWORD_SUCCESS",
          entity_type: "user",
          entity_id: tokenRecord.user_id,
          description: `تمت إعادة تعيين كلمة المرور بنجاح للمستخدم (${tokenRecord.email}) عبر رابط الاستعادة`,
        });
      } catch (auditError) {
        console.error("Audit log failed:", auditError.message);
      }
    }

    return res.status(200).json({
      message:
        "تمت إعادة تعيين كلمة المرور بنجاح. يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.",
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error in resetPassword:", error.message);
    return res.status(500).json({
      error: "خطأ في السيرفر أثناء تعيين كلمة المرور",
      code: "SERVER_ERROR",
    });
  }
};

module.exports = {
  registerUser,
  loginUser,
  registerClinic,
  getDoctors,
  updateProfile,
  changePassword,
  getMe,
  forgotPassword,
  resetPassword,
};
