const pool = require("../db");
const { getPaymentProvider } = require("../services/payments/paymentFactory");
const { normalizeEgyptianPhone } = require("../utils/phoneNormalizer");

// ==========================================
// 1. تسجيل دفعة يدوية (Manual Payment)
// ==========================================
const recordPayment = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const user_id = req.user.id;
  const { invoice_id, amount, payment_method, notes } = req.body;

  const payingAmount = parseFloat(amount);
  if (isNaN(payingAmount) || payingAmount <= 0) {
    return res
      .status(400)
      .json({ error: "المبلغ المدفوع يجب أن يكون أكبر من الصفر" });
  }

  const validMethods = ["cash", "card", "bank_transfer", "other"];
  if (!validMethods.includes(payment_method)) {
    return res.status(400).json({ error: "طريقة الدفع غير صالحة" });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const invoiceResult = await client.query(
      "SELECT * FROM invoices WHERE id = $1 AND clinic_id = $2 FOR UPDATE;",
      [invoice_id, clinic_id]
    );

    if (invoiceResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الفاتورة غير موجودة" });
    }

    const invoice = invoiceResult.rows[0];

    if (invoice.status === "paid") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الفاتورة مدفوعة بالكامل بالفعل" });
    }

    if (invoice.status === "cancelled" || invoice.is_archived) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "لا يمكن الدفع لفاتورة ملغاة أو مؤرشفة" });
    }

    // حساب المدفوع مسبقاً (الدفعات الناجحة فقط)
    const paidResult = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE invoice_id = $1 AND clinic_id = $2 AND status = 'paid';",
      [invoice_id, clinic_id]
    );

    const invoiceTotalCents = Math.round(
      parseFloat(invoice.total_amount) * 100
    );
    const alreadyPaidCents = Math.round(
      parseFloat(paidResult.rows[0].total_paid) * 100
    );
    const payingAmountCents = Math.round(payingAmount * 100);
    const newTotalPaidCents = alreadyPaidCents + payingAmountCents;

    if (newTotalPaidCents > invoiceTotalCents) {
      await client.query("ROLLBACK");
      const remaining = (invoiceTotalCents - alreadyPaidCents) / 100;
      return res.status(400).json({
        error: `المبلغ المدفوع أكبر من المتبقي على الفاتورة (المتبقي: ${remaining} جنيه)`,
      });
    }

    const paymentResult = await client.query(
      `INSERT INTO payments (clinic_id, invoice_id, amount, payment_method, status, notes, created_by)
       VALUES ($1, $2, $3, $4, 'paid', $5, $6)
       RETURNING *;`,
      [
        clinic_id,
        invoice_id,
        payingAmount,
        payment_method,
        notes || null,
        user_id,
      ]
    );

    const newStatus =
      newTotalPaidCents >= invoiceTotalCents ? "paid" : "partially_paid";

    await client.query(
      "UPDATE invoices SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND clinic_id = $3;",
      [newStatus, invoice_id, clinic_id]
    );

    await client.query("COMMIT");

    const remainingFinal = (invoiceTotalCents - newTotalPaidCents) / 100;

    res.status(201).json({
      message: "تم تسجيل الدفعة وتحديث الفاتورة بنجاح",
      payment: paymentResult.rows[0],
      invoice_status: newStatus,
      remaining_amount: remainingFinal,
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    console.error("Error recording payment:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء تسجيل الدفع" });
  } finally {
    if (client) client.release();
  }
};

// ==========================================
// 2. إنشاء رابط دفع إلكتروني (Online Payment Link)
// ==========================================
const createOnlinePayment = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const user_id = req.user.id;
  const clinic_email = req.user.email; // ✅ إيميل المستخدم الحالي كـ fallback رسمي للعيادة
  const { invoice_id, amount, notes, expires_hours = 24 } = req.body;

  // ✅ Validation لـ expires_hours (من ساعة إلى 7 أيام كحد أقصى)
  const parsedHours = parseInt(expires_hours, 10);
  const validHours =
    !isNaN(parsedHours) && parsedHours >= 1 && parsedHours <= 168
      ? parsedHours
      : 24;

  let client;
  let pendingPaymentId = null;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const invoiceResult = await client.query(
      "SELECT * FROM invoices WHERE id = $1 AND clinic_id = $2 FOR UPDATE;",
      [invoice_id, clinic_id]
    );

    if (invoiceResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الفاتورة غير موجودة" });
    }

    const invoice = invoiceResult.rows[0];

    if (
      invoice.status === "paid" ||
      invoice.status === "cancelled" ||
      invoice.is_archived
    ) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "لا يمكن إنشاء رابط دفع لهذه الفاتورة" });
    }

    // حساب المتبقي على الفاتورة
    const paidResult = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE invoice_id = $1 AND clinic_id = $2 AND status = 'paid';",
      [invoice_id, clinic_id]
    );

    const invoiceTotalCents = Math.round(
      parseFloat(invoice.total_amount) * 100
    );
    const alreadyPaidCents = Math.round(
      parseFloat(paidResult.rows[0].total_paid) * 100
    );
    const remainingCents = invoiceTotalCents - alreadyPaidCents;

    let requestedAmountCents = remainingCents;
    if (amount) {
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "المبلغ المطلوب غير صالح" });
      }
      requestedAmountCents = Math.round(parsedAmount * 100);
    }

    if (requestedAmountCents > remainingCents) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `المبلغ المطلوب (${
          requestedAmountCents / 100
        }) يتجاوز المتبقي من الفاتورة (${remainingCents / 100} جنيه)`,
      });
    }

    // جلب بيانات المريض
    const patientResult = await client.query(
      "SELECT name, phone_number FROM patients WHERE id = $1 AND clinic_id = $2;",
      [invoice.patient_id, clinic_id]
    );

    if (patientResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "بيانات المريض غير موجودة" });
    }

    const patient = patientResult.rows[0];
    const normalizedPhone = normalizeEgyptianPhone(patient.phone_number);

    if (!normalizedPhone) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "رقم هاتف المريض غير مسجل بصيغة مصرية صحيحة" });
    }

    // 🚨 2) إلغاء أي روابط دفع سابقة لنفس الفاتورة ما زالت pending
    await client.query(
      `UPDATE payments 
       SET status = 'cancelled', 
           notes = COALESCE(notes, '') || ' [ملغى: تم استبداله برابط دفع جديد]'
       WHERE invoice_id = $1 AND clinic_id = $2 AND status = 'pending';`,
      [invoice_id, clinic_id]
    );

    const expiresAt = new Date(Date.now() + validHours * 60 * 60 * 1000);
    const finalAmountEGP = requestedAmountCents / 100;

    // تسجيل الدفعة الجديدة بحالة pending
    const paymentResult = await client.query(
      `INSERT INTO payments (
        clinic_id, invoice_id, amount, payment_method, 
        status, provider, expires_at, created_by, notes
      )
      VALUES ($1, $2, $3, 'online', 'pending', 'paymob', $4, $5, $6)
      RETURNING *;`,
      [clinic_id, invoice_id, finalAmountEGP, expiresAt, user_id, notes || null]
    );

    const pendingPayment = paymentResult.rows[0];
    pendingPaymentId = pendingPayment.id;
    await client.query("COMMIT");

    // طلب الجلسة من Paymob
    try {
      const provider = getPaymentProvider("paymob");
      const session = await provider.createPaymentSession({
        amount: finalAmountEGP,
        currency: "EGP",
        invoiceId: invoice.id,
        paymentId: pendingPayment.id,
        patient: { ...patient, phone_number: normalizedPhone },
        clinicEmail: clinic_email,
        expiresAt: expiresAt,
      });

      // حفظ provider_order_id
      await pool.query(
        "UPDATE payments SET provider_order_id = $1 WHERE id = $2;",
        [session.providerOrderId, pendingPayment.id]
      );

      // تجهيز رابط ورسالة الواتساب الجاهزة (wa.me)
      const messageText = `مرحباً بك في العيادة، يمكنك سداد دفعة بقيمة ${finalAmountEGP} ج.م الخاصة بالفاتورة رقم #${invoice.id.slice(
        0,
        8
      )} عبر الرابط الآمن التالي:\n${session.paymentUrl}`;
      const whatsappUrl = `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(
        messageText
      )}`;

      res.status(201).json({
        message: "تم إنشاء رابط الدفع بنجاح",
        payment_id: pendingPayment.id,
        amount: finalAmountEGP,
        payment_url: session.paymentUrl,
        whatsapp_url: whatsappUrl,
        expires_at: expiresAt,
      });
    } catch (paymobError) {
      // 🚨 4) لو Paymob فشل بعد الـ INSERT، نحدث حالة الـ pending إلى failed فوراً
      console.error("Paymob API Session Error:", paymobError.message);
      if (pendingPaymentId) {
        await pool.query(
          "UPDATE payments SET status = 'failed', notes = COALESCE(notes, '') || ' [فشل في إنشاء جلسة Paymob]' WHERE id = $1;",
          [pendingPaymentId]
        );
      }
      throw paymobError;
    }
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    console.error("Error creating online payment:", error.message);
    res
      .status(500)
      .json({ error: error.message || "حدث خطأ أثناء إنشاء رابط الدفع" });
  } finally {
    if (client) client.release();
  }
};

// ==========================================
// 3. استقبال إشعار الدفع (Paymob Webhook)
// ==========================================
const handlePaymobWebhook = async (req, res) => {
  const provider = getPaymentProvider("paymob");

  // التحقق من الـ HMAC Signature
  const isValidSignature = provider.verifyWebhookSignature(req);
  if (!isValidSignature) {
    console.warn("⚠ Paymob Webhook: Invalid HMAC Signature detected.");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const webhookData = provider.parseWebhookData(req.body);
  const {
    isSuccess,
    isPending,
    transactionId,
    orderId,
    paymentId,
    amountCents,
    paymentMethod,
  } = webhookData;

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // البحث عن الـ Payment بالـ ID
    let paymentQuery = "SELECT * FROM payments WHERE id = $1 FOR UPDATE;";
    let queryParams = [paymentId];

    if (!paymentId && orderId) {
      paymentQuery =
        "SELECT * FROM payments WHERE provider_order_id = $1 FOR UPDATE;";
      queryParams = [orderId];
    }

    const paymentResult = await client.query(paymentQuery, queryParams);

    if (paymentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      console.warn(
        `Paymob Webhook: Payment not found for reference: ${
          paymentId || orderId
        }`
      );
      return res
        .status(200)
        .json({ message: "Payment record not found, ignored." });
    }

    const payment = paymentResult.rows[0];

    if (payment.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(200).json({
        message: "Payment is no longer active, ignored.",
      });
    }
    
    // التعامل مع pending=true كحالة معلقة وليست فاشلة
    if (isPending) {
      await client.query(
        "UPDATE payments SET provider_transaction_id = $1 WHERE id = $2;",
        [transactionId, payment.id]
      );
      await client.query("COMMIT");
      return res.status(200).json({
        message: "Payment is still pending confirmation.",
      });
    }

    // لو فشلت نهائياً (success=false و pending=false)
    if (!isSuccess) {
      await client.query(
        "UPDATE payments SET status = 'failed', provider_transaction_id = $1 WHERE id = $2;",
        [transactionId, payment.id]
      );
      await client.query("COMMIT");
      return res.status(200).json({ message: "Payment marked as failed." });
    }

    // 🚨 1) التحقق الصارم من تطابق المبلغ المستلم من الـ Webhook مع المبلغ المسجل في الداتا بيز
    const expectedAmountCents = Math.round(parseFloat(payment.amount) * 100);
    if (amountCents !== expectedAmountCents) {
      await client.query("ROLLBACK");
      console.warn(
        `⚠ Paymob Webhook: Amount mismatch! Expected: ${expectedAmountCents}, Received: ${amountCents}`
      );
      return res.status(400).json({ error: "Payment amount mismatch" });
    }

    // قفل الفاتورة وتحديثها
    const invoiceResult = await client.query(
      "SELECT * FROM invoices WHERE id = $1 AND clinic_id = $2 FOR UPDATE;",
      [payment.invoice_id, payment.clinic_id]
    );

    const invoice = invoiceResult.rows[0];

    // تحديث الدفعة لـ paid وتسجيل transaction_id
    await client.query(
      `UPDATE payments 
       SET status = 'paid', 
           provider_transaction_id = $1, 
           payment_method = $2, 
           paid_at = CURRENT_TIMESTAMP 
       WHERE id = $3;`,
      [transactionId, paymentMethod, payment.id]
    );

    // إعادة حساب إجمالي المدفوعات الناجحة
    const totalPaidResult = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE invoice_id = $1 AND clinic_id = $2 AND status = 'paid';",
      [payment.invoice_id, payment.clinic_id]
    );

    const invoiceTotalCents = Math.round(
      parseFloat(invoice.total_amount) * 100
    );
    const newTotalPaidCents = Math.round(
      parseFloat(totalPaidResult.rows[0].total_paid) * 100
    );
    const newInvoiceStatus =
      newTotalPaidCents >= invoiceTotalCents ? "paid" : "partially_paid";

    await client.query(
      "UPDATE invoices SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND clinic_id = $3;",
      [newInvoiceStatus, invoice.id, invoice.clinic_id]
    );

    await client.query("COMMIT");
    console.log(
      `✅ Payment ${payment.id} verified and invoice ${invoice.id} updated to ${newInvoiceStatus}`
    );

    return res
      .status(200)
      .json({ message: "Payment successfully confirmed and recorded." });
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    console.error("Error processing Paymob webhook:", error);
    return res.status(500).json({ error: "Internal webhook processing error" });
  } finally {
    if (client) client.release();
  }
};

module.exports = {
  recordPayment,
  createOnlinePayment,
  handlePaymobWebhook,
};
