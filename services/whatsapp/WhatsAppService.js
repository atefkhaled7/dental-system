// services/whatsapp/WhatsAppService.js
const { normalizeEgyptianPhone } = require("../../utils/phoneNormalizer");

class WhatsAppService {
  /**
   * قوالب الرسائل المنسقة
   */
  static TEMPLATES = {
    // 1. تأكيد الحجز
    confirmation: ({ patientName, clinicName, date, time, doctorName }) =>
      `أهلاً بك يا ${patientName} في ${clinicName} 🦷\n\nتم تأكيد موعدك بنجاح:\n📅 التاريخ: ${date}\n⏰ الساعة: ${time}\n👨⚕️ الطبيب: ${doctorName}\n\nنتشرف بزيارتك، وفي حال الرغبة في التعديل يُرجى التواصل معنا.`,

    // 2. تذكير بالموعد
    reminder: ({ patientName, clinicName, date, time, doctorName }) =>
      `تذكير بموعدك في ${clinicName} 🔔\n\nأهلاً ${patientName}، نذكرك بموعدك القادم:\n📅 التاريخ: ${date}\n⏰ الساعة: ${time}\n👨⚕️ الطبيب: ${doctorName}\n\nنرجو الحضور قبل الموعد بـ 10 دقائق لتجنب الانتظار. نتمنى لك دوام الصحة والعافية!`,

    // 3. عدم الحضور (No-show)
    no_show: ({ patientName, clinicName, date, time }) =>
      `أهلاً ${patientName} من ${clinicName} 🌸\n\nلاحظنا عدم حضورك لموعد اليوم (${date} الساعة ${time}). نتمنى أن تكون بأفضل حال.\n\nإذا كنت ترغب في إعادة جدولة الموعد في وقت يناسبك، يمكنك الرد على هذه الرسالة وسنساعدك فوراً.`,

    // 4. رابط سداد الفاتورة
    payment_link: ({
      patientName,
      clinicName,
      amount,
      invoiceId,
      paymentUrl,
    }) =>
      `مرحباً ${patientName} من ${clinicName} 💳\n\nنود إعلامك بصدور فاتورة علاج رقم #${invoiceId.slice(
        0,
        8
      )} بقيمة ${amount} ج.م.\n\nيمكنك السداد إلكترونياً بأمان عبر الرابط التالي:\n🔗 ${paymentUrl}\n\nشكراً لثقتك بنا دائمًا.`,

    // 5. تقييم الزيارة ورأي المريض (للمواعيد المكتملة) 👈 جديد
    feedback: ({ patientName, clinicName, doctorName }) =>
      `أهلاً بك يا ${patientName}، نتمنى تكون بأفضل حال بعد زيارتك لـ ${clinicName} اليوم مع د. ${doctorName} ⭐\n\nرأيك يهمنا جداً لتطوير خدماتنا! كيف كانت تجربتك معنا اليوم؟ يسعدنا سماع تقييمك وملاحظاتك.`,

    // 6. اطمئنان ومتابعة بعد الكشف (للمواعيد المكتملة) 👈 جديد
    follow_up: ({ patientName, clinicName, doctorName }) =>
      `أهلاً ${patientName} من ${clinicName} 🩺\n\nنود الاطمئنان عليك بعد جلسة العلاج اليوم مع د. ${doctorName}. نتمنى لك الشفاء العاجل وراحة دائمة.\n\nإذا شعرت بأي ألم أو كان لديك أي استفسار حول تعليمات ما بعد الكشف، تفضل بمراسلتنا مباشرة هنا. ألف سلامة عليك!`,
  };

  /**
   * توليد نص الرسالة ورابط wa.me
   */
  generateWhatsAppLink({ type, phone, data }) {
    const templateFn = WhatsAppService.TEMPLATES[type];
    if (!templateFn) {
      throw new Error(`نوع قالب الواتساب غير معروف: ${type}`);
    }

    const normalizedPhone = normalizeEgyptianPhone(phone);
    if (!normalizedPhone) {
      throw new Error("رقم هاتف المريض غير صالح لإرسال رسالة واتساب.");
    }

    const messageText = templateFn(data);
    const waLink = `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(
      messageText
    )}`;

    return {
      phone: normalizedPhone,
      message: messageText,
      url: waLink,
    };
  }

  /**
   * مخصصة للمستقبل: الإرسال التلقائي عبر API (Meta Cloud API / Gateway)
   */
  async sendAutomatedMessage({ type, phone, data }) {
    const { phone: recipientPhone, message } = this.generateWhatsAppLink({
      type,
      phone,
      data,
    });

    // وضع تجريبي Log حالياً
    console.log(`📡 [WhatsApp Automated Mock] إرسال إلى ${recipientPhone}:`);
    console.log(message);

    return {
      success: true,
      mode: "mock_simulation",
      recipient: recipientPhone,
    };
  }
}

module.exports = new WhatsAppService();
