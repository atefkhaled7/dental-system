const pool = require("../db");
const { captureError } = require("../utils/errorTracker");
const { normalizeEgyptianPhone } = require("../utils/phoneNormalizer");
const { isValidUuid } = require("../middleware/validateUuid");

// 1. إنشاء تذكرة دعم جديدة
const createSupportTicket = async (req, res) => {
  const {
    category,
    message,
    page_url,
    browser_info,
    contact_phone,
    clinic_id: bodyClinicId,
  } = req.body || {};
  const user_id = req.user?.id;
  const userRole = req.user?.role;
  let clinic_id = req.user?.clinic_id;

  // إذا كان المستخدم SuperAdmin، يجب تمرير clinic_id صراحة لمنع مخالفة قيد NOT NULL
  if (userRole === "SuperAdmin") {
    if (bodyClinicId && isValidUuid(bodyClinicId)) {
      clinic_id = bodyClinicId;
    } else {
      return res.status(400).json({
        error:
          "حساب السوبر أدمن غير مرتبط بعيادة افتراضية، يرجى تحديد معرّف العيادة (clinic_id) لإنشاء التذكرة",
      });
    }
  }

  if (!clinic_id || !isValidUuid(clinic_id)) {
    return res.status(400).json({
      error: "تذاكر الدعم الفني مخصصة لمستخدمي العيادات المسجلين فقط",
    });
  }

  try {
    if (!message || typeof message !== "string" || message.trim().length < 5) {
      return res.status(400).json({
        error: "يرجى كتابة وصف واضح للمشكلة (5 أحرف على الأقل)",
      });
    }

    const validCategories = ["bug", "question", "feature"];
    const safeCategory = validCategories.includes(category) ? category : "bug";

    let safePhone = null;
    if (
      contact_phone !== undefined &&
      contact_phone !== null &&
      String(contact_phone).trim() !== ""
    ) {
      if (typeof contact_phone !== "string") {
        return res.status(400).json({
          error: "رقم الهاتف غير صالح",
        });
      }
      const normalized = normalizeEgyptianPhone(contact_phone.trim());
      if (typeof normalized !== "string" || normalized.length > 20) {
        return res.status(400).json({
          error: "يرجى إدخال رقم هاتف مصري صحيح",
        });
      }
      safePhone = normalized;
    }

    const result = await pool.query(
      `INSERT INTO support_tickets (
        clinic_id,
        user_id,
        category,
        message,
        page_url,
        browser_info,
        contact_phone,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
      RETURNING *;`,
      [
        clinic_id,
        user_id,
        safeCategory,
        message.trim().slice(0, 5000),
        page_url ? String(page_url).slice(0, 500) : null,
        browser_info ? String(browser_info).slice(0, 1000) : null,
        safePhone,
      ],
    );

    res.status(201).json({
      success: true,
      message: "تم إرسال بلاغك لفريق الدعم بنجاح، وسنتواصل معك قريباً.",
      ticket: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error creating support ticket:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء إرسال تذكرة الدعم" });
  }
};

// 2. جلب التذاكر (للسوبر أدمن وللعيادة)
const getSupportTickets = async (req, res) => {
  const isSuperAdmin = req.user.role === "SuperAdmin";
  const clinic_id = req.user.clinic_id;

  try {
    let query = `
      SELECT 
        st.*,
        c.name AS clinic_name,
        u.name AS user_name,
        u.role AS user_role
      FROM support_tickets st
      LEFT JOIN clinics c ON st.clinic_id = c.id
      LEFT JOIN users u ON st.user_id = u.id
    `;
    const params = [];
    if (!isSuperAdmin) {
      query += ` WHERE st.clinic_id = $1 `;
      params.push(clinic_id);
    }
    query += ` ORDER BY st.created_at DESC LIMIT 50;`;

    const result = await pool.query(query, params);
    res.status(200).json(result.rows);
  } catch (error) {
    captureError(error, req);
    console.error("Error fetching support tickets:", error.message);
    res.status(500).json({ error: "فشل جلب تذاكر الدعم" });
  }
};

// 3. تحديث حالة التذكرة وإغلاقها (SuperAdmin فقط)
const updateTicketStatus = async (req, res) => {
  const { id } = req.params;
  const { status, admin_notes } = req.body || {};

  if (req.user.role !== "SuperAdmin") {
    return res
      .status(403)
      .json({ error: "هذه الصلاحية خاصة بالسوبر أدمن فقط" });
  }

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: "معرّف التذكرة غير صالح" });
  }

  const validStatuses = ["open", "resolved", "closed"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({
      error: "حالة التذكرة غير صالحة",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE support_tickets 
       SET status = $1, 
           admin_notes = COALESCE($2, admin_notes),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *;`,
      [
        status,
        admin_notes ? String(admin_notes).trim().slice(0, 2000) : null,
        id,
      ],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "التذكرة غير موجودة" });
    }

    res.status(200).json({
      success: true,
      message: "تم تحديث حالة التذكرة بنجاح",
      ticket: result.rows[0],
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error updating ticket status:", error.message);
    res.status(500).json({ error: "فشل تحديث حالة التذكرة" });
  }
};

module.exports = {
  createSupportTicket,
  getSupportTickets,
  updateTicketStatus,
};
