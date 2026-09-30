// services/payments/BasePaymentProvider.js
class BasePaymentProvider {
  /**
   * إنشاء جلسة دفع وجلب رابط الدفع (Payment URL)
   */
  async createPaymentSession({ amount, currency, invoiceId, patient, expiresAt }) {
    throw new Error("Method createPaymentSession() must be implemented.");
  }

  /**
   * التحقق من صحة التوقيع الرقمي (Signature / HMAC) للـ Webhook
   */
  verifyWebhookSignature(req) {
    throw new Error("Method verifyWebhookSignature() must be implemented.");
  }

  /**
   * استخراج بيانات العملية الموحدة من الـ Webhook Payload
   * وترجع شكل موحد: { success, transactionId, orderId, amountCents, rawData }
   */
  parseWebhookData(payload) {
    throw new Error("Method parseWebhookData() must be implemented.");
  }
}

module.exports = BasePaymentProvider;