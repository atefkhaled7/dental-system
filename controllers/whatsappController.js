const pool = require("../db");
const whatsAppService = require("../services/whatsapp/WhatsAppService");
const { normalizeEgyptianPhone } = require("../utils/phoneNormalizer");
const { isValidUuid } = require("../middleware/validateUuid");
const { captureError } = require("../utils/errorTracker");

// ==========================================
// 1. توليد رابط واتساب للموعد
// ==========================================
const getAppointmentWhatsAppLink = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { appointment_id, type } = req.query; // type: confirmation | reminder | no_show

  if (!appointment_id || !type) {
    return res.status(400).json({ error: "معرف الموعد ونوع الرسالة مطلوبان" });
  }

  if (!isValidUuid(appointment_id)) {
    return res.status(400).json({ error: "معرّف الموعد غير صالح" });
  }

  const allowedTypes = [
    "confirmation",
    "reminder",
    "no_show",
    "feedback",
    "follow_up",
  ];
  if (!allowedTypes.includes(type)) {
    return res.status(400).json({ error: "نوع رسالة الواتساب غير صالح" });
  }

  try {
    // جلب بيانات الموعد مع المريض والدكتور والعيادة
    const query = `
      SELECT 
        a.id AS appointment_id,
        a.appointment_date,
        p.name AS patient_name,
        p.phone_number AS patient_phone,
        u.name AS doctor_name,
        c.name AS clinic_name
      FROM appointments a
      JOIN patients p ON a.patient_id = p.id AND p.clinic_id = $1
      LEFT JOIN users u ON a.doctor_id = u.id
      JOIN clinics c ON a.clinic_id = c.id
      WHERE a.id = $2 AND a.clinic_id = $1;
    `;
    const result = await pool.query(query, [clinic_id, appointment_id]);
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "الموعد غير موجود أو لا ينتمي لعيادتك" });
    }

    const appt = result.rows[0];

    // تنسيق التاريخ والوقت بتوقيت مصر
    const formattedDate = new Date(appt.appointment_date).toLocaleDateString(
      "ar-EG",
      {
        timeZone: "Africa/Cairo",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      },
    );
    const formattedTime = new Date(appt.appointment_date).toLocaleTimeString(
      "ar-EG",
      {
        timeZone: "Africa/Cairo",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      },
    );

    const linkData = whatsAppService.generateWhatsAppLink({
      type: type,
      phone: appt.patient_phone,
      data: {
        patientName: appt.patient_name,
        clinicName: appt.clinic_name || "العيادة",
        doctorName: appt.doctor_name || "طبيب العيادة",
        date: formattedDate,
        time: formattedTime,
      },
    });

    res.json(linkData);
  } catch (error) {
    captureError(error, req);
    console.error("Error generating WhatsApp link:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء إنشاء رابط الواتساب للموعد" });
  }
};

// ==========================================
// 2. توليد رابط واتساب للفاتورة
// ==========================================
const getInvoiceWhatsAppLink = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { invoice_id } = req.query;

  if (!invoice_id) {
    return res.status(400).json({ error: "معرف الفاتورة مطلوب" });
  }

  if (!isValidUuid(invoice_id)) {
    return res.status(400).json({ error: "معرّف الفاتورة غير صالح" });
  }

  try {
    const query = `
      SELECT 
        inv.id AS invoice_id,
        inv.total_amount,
        p.name AS patient_name,
        p.phone_number AS patient_phone,
        c.name AS clinic_name,
        COALESCE(SUM(CASE WHEN pay.status = 'paid' THEN pay.amount ELSE 0 END), 0) AS paid_amount
      FROM invoices inv
      JOIN patients p ON inv.patient_id = p.id AND p.clinic_id = $1
      JOIN clinics c ON inv.clinic_id = c.id
      LEFT JOIN payments pay ON inv.id = pay.invoice_id AND pay.clinic_id = $1
      WHERE inv.id = $2 AND inv.clinic_id = $1 AND inv.status <> 'cancelled'
        AND inv.is_archived = FALSE
      GROUP BY inv.id, p.name, p.phone_number, c.name;
    `;
    const result = await pool.query(query, [clinic_id, invoice_id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "الفاتورة غير موجودة أو ملغاة" });
    }

    const inv = result.rows[0];
    const remaining = Number(inv.total_amount) - Number(inv.paid_amount);

    const messageText = `مرحباً أ. ${inv.patient_name} من ${
      inv.clinic_name || "العيادة"
    } 💳\n\nنود إعلامك بتفاصيل الفاتورة رقم #${inv.invoice_id.slice(
      0,
      8,
    )}:\n• إجمالي العلاج: ${Number(inv.total_amount).toLocaleString(
      "ar-EG",
    )} ج.م\n• المسدد: ${Number(inv.paid_amount).toLocaleString(
      "ar-EG",
    )} ج.م\n• المتبقي: ${remaining.toLocaleString(
      "ar-EG",
    )} ج.م\n\nنتمنى لك دوام الصحة والعافية!`;

    if (!inv.patient_phone) {
      return res.status(400).json({
        error: "رقم هاتف المريض غير مسجل",
      });
    }

    const normalizedPhone = normalizeEgyptianPhone(inv.patient_phone);
    if (!normalizedPhone) {
      return res.status(400).json({
        error: "رقم هاتف المريض غير صالح",
      });
    }

    const waLink = `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(
      messageText,
    )}`;

    res.json({
      phone: normalizedPhone,
      message: messageText,
      url: waLink,
    });
  } catch (error) {
    captureError(error, req);
    console.error("Error generating invoice WhatsApp link:", error.message);
    res
      .status(500)
      .json({ error: "حدث خطأ أثناء إنشاء رابط الواتساب للفاتورة" });
  }
};

module.exports = { getAppointmentWhatsAppLink, getInvoiceWhatsAppLink };
