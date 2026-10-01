// controllers/whatsappController.js
const pool = require("../db");
const whatsAppService = require("../services/whatsapp/WhatsAppService");

const getAppointmentWhatsAppLink = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const { appointment_id, type } = req.query; // type: confirmation | reminder | no_show

  if (!appointment_id || !type) {
    return res.status(400).json({ error: "معرف الموعد ونوع الرسالة مطلوبان" });
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
      return res.status(404).json({ error: "الموعد غير موجود" });
    }

    const appt = result.rows[0];

    // تنسيق التاريخ والوقت
    const formattedDate = new Date(appt.appointment_date).toLocaleDateString(
      "ar-EG",
      {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }
    );

    const formattedTime = new Date(appt.appointment_date).toLocaleTimeString(
      "ar-EG",
      {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }
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
    console.error("Error generating WhatsApp link:", error.message);
    res
      .status(500)
      .json({ error: error.message || "حدث خطأ أثناء إنشاء رابط الواتساب" });
  }
};

module.exports = { getAppointmentWhatsAppLink };
