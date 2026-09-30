// utils/phoneNormalizer.js

/**
 * تحويل أي صيغة رقم مصري للصيغة الدولية القياسية: 2010xxxxxxxx
 */
function normalizeEgyptianPhone(phone) {
  if (!phone) return null;

  // إزالة أي مسافات أو شرط أو رموز غير الأرقام
  let cleaned = phone.replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+")) cleaned = cleaned.substring(1);
  if (cleaned.startsWith("00")) cleaned = cleaned.substring(2);

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
