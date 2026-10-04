const crypto = require("crypto");
const axios = require("axios");
const BasePaymentProvider = require("./BasePaymentProvider");

class PaymobProvider extends BasePaymentProvider {
  constructor() {
    super();
    this.secretKey = process.env.PAYMOB_API_KEY;
    this.publicKey = process.env.PAYMOB_PUBLIC_KEY;
    this.hmacSecret = process.env.PAYMOB_HMAC_SECRET;
    this.mode = process.env.PAYMOB_MODE || "live";

    this.integrationIds = (process.env.PAYMOB_INTEGRATION_IDS || "")
      .split(",")
      .map((id) => Number(id.trim()))
      .filter(Number.isInteger);

    this.baseUrl = "https://accept.paymob.com/v1";
  }

  isMock() {
    return this.mode === "mock";
  }

  isConfigured() {
    return Boolean(
      this.secretKey &&
        this.publicKey &&
        this.hmacSecret &&
        this.integrationIds.length
    );
  }

  /**
   * إنشاء جلسة دفع باستخدام Intention API
   */
  async createPaymentSession({
    amount,
    currency = "EGP",
    invoiceId,
    paymentId,
    patient,
    clinicEmail,
    expiresAt,
  }) {
    // 🛠️ لو المفاتيح لسه مش حقيقية، شغل وضع المحاكاة (Mock) عشان تجرب السيستم والواتساب
    if (this.isMock()) {
      console.log(
        "⚡ [PAYMOB MOCK MODE]: توليد رابط تجريبي لاختبار الواتساب والواجهة"
      );
      return {
        paymentUrl: `https://accept.paymob.com/unifiedcheckout/?mock=true&payment_id=${paymentId}`,
        providerOrderId: `mock_order_${Date.now()}`,
        clientSecret: "mock_client_secret_test",
      };
    }

    if (!this.isConfigured()) {
      throw new Error("Paymob is not configured.");
    }

    if (!this.integrationIds.length) {
      throw new Error("No valid Paymob Integration IDs configured.");
    }

    if (!patient?.phone_number) {
      throw new Error("رقم هاتف المريض مطلوب لإنشاء رابط دفع إلكتروني.");
    }

    const amountInCents = Math.round(Number(amount) * 100);
    const nameParts = (patient.name || "Patient").trim().split(" ");
    const firstName = nameParts[0] || "Patient";
    const lastName = nameParts.slice(1).join(" ") || "Customer";
    const contactEmail = patient.email || clinicEmail || "billing@clinic.com";

    const expirationSeconds = expiresAt
      ? Math.max(
          60,
          Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
        )
      : 86400;

    const payload = {
      amount: amountInCents,
      currency: currency,
      payment_methods: this.integrationIds,
      expiration: expirationSeconds,
      items: [
        {
          name: `فاتورة علاج رقم ${invoiceId.slice(0, 8)}`,
          amount: amountInCents,
          description: "دفعة علاج بعيادة الأسنان",
          quantity: 1,
        },
      ],
      billing_data: {
        first_name: firstName,
        last_name: lastName,
        phone_number: patient.phone_number,
        email: contactEmail,
        apartment: "NA",
        floor: "NA",
        street: "NA",
        building: "NA",
        city: patient.city || "Cairo",
        country: "EG",
        state: "NA",
      },
      special_reference: paymentId,
      notification_url: `${process.env.BACKEND_URL}/api/payments/webhook/paymob`,
      redirection_url: `${process.env.FRONTEND_URL}/payment-status?invoice_id=${invoiceId}`,
    };

    const response = await axios.post(`${this.baseUrl}/intention/`, payload, {
      headers: {
        Authorization: `Token ${this.secretKey}`,
        "Content-Type": "application/json",
      },
    });

    const data = response.data;
    const clientSecret = data.client_secret;

    return {
      paymentUrl: `https://accept.paymob.com/unifiedcheckout/?publicKey=${this.publicKey}&clientSecret=${clientSecret}`,
      providerOrderId: String(
        data.intention_order_id || data.order_id || data.id || ""
      ),
      clientSecret,
    };
  }

  /**
   * التحقق من HMAC Signature
   */
  verifyWebhookSignature(req) {
    if (!this.hmacSecret) return false;
  
    const receivedHmac = req.query?.hmac || req.body?.hmac;
    const data = req.body?.obj || req.body;
  
    if (!receivedHmac || !data || typeof receivedHmac !== "string") {
      return false;
    }
  
    // Paymob HMAC-SHA512 = 128 hex characters
    if (!/^[a-f0-9]{128}$/i.test(receivedHmac)) {
      return false;
    }
  
    const concatenatedValues = [
      data.amount_cents,
      data.created_at,
      data.currency,
      data.error_occured,
      data.has_parent_transaction,
      data.id,
      data.integration_id,
      data.is_3d_secure,
      data.is_auth,
      data.is_capture,
      data.is_refunded,
      data.is_standalone_payment,
      data.is_voided,
      data.order?.id,
      data.owner,
      data.pending,
      data.source_data?.pan,
      data.source_data?.sub_type,
      data.source_data?.type,
      data.success,
    ]
      .map((val) => (val === undefined || val === null ? "" : String(val)))
      .join("");
  
    const calculatedHmac = crypto
      .createHmac("sha512", this.hmacSecret)
      .update(concatenatedValues)
      .digest("hex");
  
    const calculatedBuffer = Buffer.from(calculatedHmac, "hex");
    const receivedBuffer = Buffer.from(receivedHmac, "hex");
  
    return crypto.timingSafeEqual(calculatedBuffer, receivedBuffer);
  }

  /**
   * استخراج وتوحيد بيانات الـ Webhook
   */
  parseWebhookData(payload) {
    const obj = payload.obj || payload;
    const isSuccess = obj.success === true && obj.pending === false;
    const isPending = obj.pending === true;

    // قراءة paymentId من merchant_order_id أولاً
    const internalPaymentId =
      obj.order?.merchant_order_id || obj.special_reference || null;

    return {
      isSuccess,
      isPending,
      transactionId: String(obj.id),
      orderId: String(obj.order?.id || ""),
      paymentId: internalPaymentId,
      amountCents: obj.amount_cents,
      paymentMethod:
        obj.source_data?.sub_type || obj.source_data?.type || "online",
      rawData: obj,
    };
  }
}

module.exports = PaymobProvider;
