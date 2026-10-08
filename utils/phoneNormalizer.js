function normalizeEgyptianPhone(phone) {
  if (!phone || typeof phone !== "string") return null;

  // تحويل الأرقام العربية (٠١٢...) والفارسية (۰۱۲...) لأرقام إنجليزية
  let cleaned = phone
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

  // إزالة أي مسافات أو شرط أو رموز غير الأرقام
  cleaned = cleaned.replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+")) cleaned = cleaned.substring(1);
  if (cleaned.startsWith("00")) cleaned = cleaned.substring(2);

  // غلطة شائعة: +2001012345678 (صفر زيادة بعد كود مصر)
  if (cleaned.startsWith("200") && cleaned.length === 13) {
    cleaned = "20" + cleaned.substring(3);
  }

  // لو بيبدأ بـ 01 (زي 010 أو 011 أو 012 أو 015)
  if (cleaned.startsWith("01")) {
    cleaned = "2" + cleaned;
  } else if (!cleaned.startsWith("20") && cleaned.length === 10) {
    cleaned = "20" + cleaned;
  }

  // التحقق إن الرقم مكون من كود مصر (20) ويليه 10 أرقام تبدأ بـ 1
  const isValid = /^201[0125]\d{8}$/.test(cleaned);
  return isValid ? cleaned : null;
}

module.exports = { normalizeEgyptianPhone };
