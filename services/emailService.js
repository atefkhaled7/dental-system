const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const sendResetPasswordEmail = async ({ to, name, resetUrl }) => {
  if (!resend) {
    console.warn(
      "⚠️ RESEND_API_KEY غير مضبوط. رابط الاستعادة للتجربة المحلية:",
    );
    console.warn(`➡️ ${resetUrl}`);
    return { success: true, simulated: true };
  }

  const fromEmail =
    process.env.RESEND_FROM_EMAIL || "CUROSTA <onboarding@resend.dev>";

  const { data, error } = await resend.emails.send({
    from: fromEmail,
    to,
    subject: "إعادة تعيين كلمة المرور - CUROSTA",
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1e293b; line-height: 1.6;">
        <h2 style="color: #0284c7; text-align: center;">نظام CUROSTA لإدارة عيادات الأسنان</h2>
        <p>مرحباً ${name || ""}،</p>
        <p>تلقينا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك على المنصة.</p>
        <p>اضغط على الزر أدناه لتعيين كلمة مرور جديدة (الرابط صالح لمدة 30 دقيقة فقط):</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" style="background-color: #0284c7; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
            إعادة تعيين كلمة المرور
          </a>
        </div>
        <p style="font-size: 13px; color: #64748b;">إذا لم تطلب هذا الإجراء، يمكنك تجاهل هذا البريد بأمان وستظل كلمة مرورك كما هي.</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <p style="font-size: 12px; color: #94a3b8; text-align: center;">CUROSTA Dental SaaS System</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(error.message || "فشل إرسال البريد الإلكتروني عبر Resend");
  }

  return { success: true, data };
};

module.exports = {
  sendResetPasswordEmail,
};
