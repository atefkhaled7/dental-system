const pool = require("../db");
const jwt = require("jsonwebtoken");
const { captureError } = require("../utils/errorTracker");

const authMiddleware = async (req, res, next) => {
  let token = req.header("Authorization");

  if (!token) {
    return res.status(401).json({
      error: "Access Denied: No Token Provided!",
    });
  }

  if (token.startsWith("Bearer ")) {
    token = token.slice(7).trimStart();
  }

  // ① التحقق من التوكن نفسه
  let verified;

  try {
    verified = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });
  } catch (error) {
    return res.status(401).json({
      error: "Invalid Token",
    });
  }

  // لازم يكون فيه id للمستخدم داخل التوكن
  if (!verified.id) {
    return res.status(401).json({
      error: "Invalid Token",
    });
  }

  // ② جلب حالة المستخدم والعيادة والاشتراك الحالية من الداتابيز
  try {
    const userCheck = await pool.query(
      `
      SELECT
        u.id,
        u.clinic_id,
        u.name,
        u.email,
        u.role,
        u.is_active,
        u.token_version,
        c.is_active AS clinic_active,
        c.subscription_ends_at
      FROM users u
      LEFT JOIN clinics c ON u.clinic_id = c.id
      WHERE u.id = $1
      `,
      [verified.id],
    );
    if (userCheck.rows.length === 0) {
      return res.status(401).json({
        error: "المستخدم غير موجود",
      });
    }
    const currentUser = userCheck.rows[0];

    // ③ التحقق من صلاحية التوكن (Token Invalidation بعد تغيير الباسورد)
    if (
      verified.token_version !== undefined &&
      currentUser.token_version !== undefined &&
      verified.token_version !== currentUser.token_version
    ) {
      return res.status(401).json({
        error:
          "انتهت صلاحية الجلسة بسبب تغيير كلمة المرور. يرجى تسجيل الدخول مجدداً.",
      });
    }

    // ④ المستخدم متوقف؟
    if (!currentUser.is_active) {
      return res.status(403).json({
        error: "تم إيقاف حسابك من قبل إدارة العيادة.",
      });
    }

    // ⑤ فحص العيادة والاشتراك لغير الـ SuperAdmin
    if (currentUser.role !== "SuperAdmin") {
      // 1. العيادة متوقفة يدويًا من إدارة المنصة
      if (!currentUser.clinic_id || !currentUser.clinic_active) {
        return res.status(403).json({
          code: "CLINIC_DEACTIVATED",
          error:
            "تم إيقاف هذه العيادة من قبل إدارة المنصة. يرجى التواصل مع الدعم.",
        });
      }

      // 2. التحقق من انتهاء الاشتراك
      const isExpired = Boolean(
        currentUser.subscription_ends_at &&
        new Date(currentUser.subscription_ends_at) < new Date(),
      );

      // الاشتراك منتهي: منع عمليات الكتابة والتعديل
      const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(
        req.method,
      );

      if (isExpired && isMutation) {
        return res.status(402).json({
          code: "SUBSCRIPTION_EXPIRED",
          error:
            "انتهت الفترة التجريبية/الاشتراك. النظام في وضع القراءة فقط، يرجى التجديد لمتابعة الإضافة والتعديل.",
        });
      }

      // إتاحة القراءة مع تمرير حالة الاشتراك للـ Frontend
      req.isSubscriptionExpired = isExpired;
    }

    req.user = {
      ...verified,
      id: currentUser.id,
      clinic_id: currentUser.clinic_id,
      name: currentUser.name,
      email: currentUser.email,
      role: currentUser.role,
    };

    if (currentUser.clinic_id) {
      req.clinic = {
        id: currentUser.clinic_id,
        is_active: currentUser.clinic_active,
        subscription_ends_at: currentUser.subscription_ends_at,
      };
    }

    return next();
  } catch (dbError) {
    captureError(dbError, req);
    console.error("Error in authMiddleware:", dbError.message);

    return res.status(500).json({
      error: "خطأ في السيرفر أثناء التحقق من الحساب",
    });
  }
};

module.exports = authMiddleware;
