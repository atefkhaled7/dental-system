const pool = require("../db");
const { getPaymentProvider } = require("../services/payments/paymentFactory");
const { normalizeEgyptianPhone } = require("../utils/phoneNormalizer");
const whatsAppService = require("../services/whatsapp/WhatsAppService");
const { logActivity } = require("../utils/auditLogger");
const { isValidUuid } = require("../middleware/validateUuid");
const { captureError } = require("../utils/errorTracker");

const VALID_MANUAL_METHODS = [
  "cash",
  "card",
  "bank_transfer",
  "vodafone_cash",
  "instapay",
  "cheque",
  "other",
];

const normalizePaymentMethod = (raw) => {
  let m = String(raw || "")
    .toLowerCase()
    .trim();
  if (m === "transfer") m = "bank_transfer";
  if (m === "vodafonecash") m = "vodafone_cash";
  if (m === "insta_pay" || m === "insta-pay") m = "instapay";
  if (m === "check") m = "cheque";
  return m;
};





/**
 * إلغاء ربط القسط بالدفعة الملغاة وإعادته إلى «مستحق» فقط دون لمس أي قسط آخر
 * @param {object} client - pg client داخل المعاملة
 * @param {object} params
 * @returns {Promise<object|null>} القسط الذي أُعيد إلى مستحق أو null
 */
const revertVoidedPaymentFromInstallment = async (
  client,
  { clinic_id, payment_id },
) => {
  const updateRes = await client.query(
    `UPDATE installments
     SET paid_amount = 0.00,
         status = 'pending',
         payment_id = NULL,
         paid_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE payment_id = $1
  AND clinic_id = $2
  AND status = 'paid'
     RETURNING id, installment_number, title, amount;`,
    [payment_id, clinic_id],
  );

  return updateRes.rows[0] || null;
};

// ==========================================
// 1. تسجيل دفعة يدوية (Manual Payment + Installment Settlement)
// ==========================================
const recordPayment = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const user_id = req.user.id;
  const {
    invoice_id,
    installment_id,
    amount,
    payment_method,
    reference_number,
    notes,
  } = req.body;

  if (!invoice_id || !isValidUuid(invoice_id)) {
    return res.status(400).json({ error: "معرّف الفاتورة غير صالح" });
  }

  if (installment_id && !isValidUuid(installment_id)) {
    return res.status(400).json({ error: "معرّف القسط غير صالح" });
  }

  const payingAmount = Number(amount);

  if (
    amount === "" ||
    amount === null ||
    amount === undefined ||
    !Number.isFinite(payingAmount) ||
    payingAmount < 0.01
  ) {
    return res.status(400).json({
      error:
        "المبلغ المدفوع يجب أن يكون رقماً صالحاً ولا يقل عن 0.01 ج.م (قرش واحد)",
    });
  }

  if (notes !== undefined && notes !== null && typeof notes !== "string") {
    return res.status(400).json({
      error: "الملاحظات يجب أن تكون نصًا صالحًا",
    });
  }

  if (typeof notes === "string" && notes.trim().length > 1000) {
    return res.status(400).json({
      error: "الملاحظات يجب ألا تتجاوز 1000 حرف",
    });
  }

  if (
    reference_number !== undefined &&
    reference_number !== null &&
    typeof reference_number === "string" &&
    reference_number.trim().length > 100
  ) {
    return res.status(400).json({
      error: "رقم المرجع يجب ألا يتجاوز 100 حرف",
    });
  }

  const normalizedMethod = normalizePaymentMethod(payment_method);

  if (!VALID_MANUAL_METHODS.includes(normalizedMethod)) {
    return res.status(400).json({ error: "طريقة الدفع غير صالحة" });
  }

  const payingAmountCents = Math.round(payingAmount * 100);
  const cleanPayingAmount = payingAmountCents / 100;

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const invoiceResult = await client.query(
      "SELECT * FROM invoices WHERE id = $1 AND clinic_id = $2 FOR UPDATE;",
      [invoice_id, clinic_id],
    );

    if (invoiceResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "الفاتورة غير موجودة في هذه العيادة" });
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

    // 3. فحص الأقساط بدقة (1:1 Payment to Installment)
    let targetInstallment = null;

    const existingInstRes = await client.query(
      `SELECT id, installment_number, title, amount, paid_amount, status, due_date
       FROM installments
       WHERE clinic_id = $1 AND invoice_id = $2 AND status <> 'cancelled'
       ORDER BY due_date ASC, installment_number ASC
       FOR UPDATE;`,
      [clinic_id, invoice_id],
    );

    if (existingInstRes.rows.length > 0) {
      if (installment_id) {
        targetInstallment = existingInstRes.rows.find(
          (i) => i.id === installment_id,
        );
        if (!targetInstallment) {
          await client.query("ROLLBACK");
          return res.status(404).json({
            error: "القسط المحدد غير موجود أو لا يخص هذه الفاتورة",
          });
        }
      } else {
        const nextPending = existingInstRes.rows.find(
          (i) => i.status === "pending",
        );
        if (!nextPending) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "جميع أقساط هذه الفاتورة مسددة بالكامل بالفعل",
          });
        }
        targetInstallment = nextPending;
      }

      if (targetInstallment.status === "cancelled") {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "لا يمكن تسجيل دفعة على قسط ملغي" });
      }

      if (targetInstallment.status === "paid") {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `القسط #${targetInstallment.installment_number} مسدد بالكامل بالفعل`,
        });
      }

      const instAmountCents = Math.round(
        Number(targetInstallment.amount) * 100,
      );

      // تطبيق القواعد الصارمة: مفيش سداد جزئي ولا توزيع على عدة أقساط
      if (payingAmountCents !== instAmountCents) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `قيمة الدفعة (${cleanPayingAmount} ج.م) يجب أن تطابق تماماً قيمة القسط #${targetInstallment.installment_number} (${Number(targetInstallment.amount)} ج.م). النظام لا يدعم السداد الجزئي أو الموزع للأقساط.`,
        });
      }
    } else if (installment_id) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "القسط المحدد غير موجود أو لا يخص هذه الفاتورة",
      });
    }

    // حساب المدفوع مسبقاً بدقة القروش
    const paidResult = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE invoice_id = $1 AND clinic_id = $2 AND status = 'paid';",
      [invoice_id, clinic_id],
    );

    const invoiceTotalCents = Math.round(Number(invoice.total_amount) * 100);
    const alreadyPaidCents = Math.round(
      Number(paidResult.rows[0].total_paid) * 100,
    );
    const newTotalPaidCents = alreadyPaidCents + payingAmountCents;

    if (newTotalPaidCents > invoiceTotalCents) {
      await client.query("ROLLBACK");
      const remaining = (invoiceTotalCents - alreadyPaidCents) / 100;
      return res.status(400).json({
        error: `المبلغ المدفوع أكبر من المتبقي على الفاتورة (المتبقي: ${remaining} جنيه)`,
      });
    }

    const cleanReferenceNumber =
      typeof reference_number === "string" && reference_number.trim() !== ""
        ? reference_number.trim()
        : null;

    // 1. تسجيل الدفعة
    const paymentResult = await client.query(
      `INSERT INTO payments (
         clinic_id, invoice_id, amount, payment_method,
         reference_number, status, notes, created_by, paid_at
       )
       VALUES ($1, $2, $3, $4, $5, 'paid', $6, $7, CURRENT_TIMESTAMP)
       RETURNING *;`,
      [
        clinic_id,
        invoice_id,
        cleanPayingAmount,
        normalizedMethod,
        cleanReferenceNumber,
        notes?.trim() || null,
        req.user.clinic_id ? user_id : null,
      ],
    );

    const newPayment = paymentResult.rows[0];

    // 2. تحديث حالة الفاتورة
    const newStatus =
      newTotalPaidCents >= invoiceTotalCents ? "paid" : "partially_paid";

    await client.query(
      "UPDATE invoices SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND clinic_id = $3;",
      [newStatus, invoice_id, clinic_id],
    );

    // 3. تسوية القسط المرتبط بالكامل دون المساس بأي قسط آخر (1:1)
    let settledInstallment = null;
    if (targetInstallment) {
      const instUpd = await client.query(
        `UPDATE installments
         SET paid_amount = amount,
             status = 'paid',
             payment_id = $1,
             paid_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND clinic_id = $3
         RETURNING *;`,
        [newPayment.id, targetInstallment.id, clinic_id],
      );
      settledInstallment = instUpd.rows[0];
    }

    await client.query("COMMIT");

    const remainingFinal = Math.max(
      0,
      (invoiceTotalCents - newTotalPaidCents) / 100,
    );

    try {
      await logActivity({
        clinic_id,
        user_id,
        action: "RECORD_PAYMENT",
        entity_type: "invoice",
        entity_id: invoice_id,
        description: `قام ${
          req.user.name || "الموظف"
        } بتحصيل دفعة بقيمة ${cleanPayingAmount} ج.م للفاتورة #${invoice_id.slice(
          0,
          8,
        )}${
          settledInstallment
            ? ` (سداد كامل للقسط #${settledInstallment.installment_number})`
            : ""
        }`,
        metadata: {
          amount: cleanPayingAmount,
          payment_method: normalizedMethod,
          reference_number: cleanReferenceNumber,
          remaining_amount: remainingFinal,
          settled_installment_id: settledInstallment?.id || null,
          settled_installment_number:
            settledInstallment?.installment_number || null,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed for manual payment:", auditError.message);
    }

    res.status(201).json({
      message: settledInstallment
        ? `تم تسجيل الدفعة وسداد القسط #${settledInstallment.installment_number} بالكامل بنجاح`
        : "تم تسجيل الدفعة وتحديث الفاتورة بنجاح",
      payment: newPayment,
      invoice_status: newStatus,
      remaining_amount: remainingFinal,
      settled_installment: settledInstallment,
      settled_installments: settledInstallment ? [settledInstallment] : [],
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("Rollback error:", rollbackErr.message);
      }
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    captureError(error, req);
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
  const clinic_email = req.user.email;
  const {
    invoice_id,
    installment_id,
    amount,
    notes,
    expires_hours = 24,
  } = req.body;

  if (!invoice_id || !isValidUuid(invoice_id)) {
    return res.status(400).json({ error: "معرّف الفاتورة غير صالح" });
  }

  if (installment_id && !isValidUuid(installment_id)) {
    return res.status(400).json({ error: "معرّف القسط غير صالح" });
  }

  const parsedHours = parseInt(expires_hours, 10);
  const validHours =
    !isNaN(parsedHours) && parsedHours >= 1 && parsedHours <= 168
      ? parsedHours
      : 24;

  const provider = getPaymentProvider("paymob");

  if (!provider.isMock() && !provider.isConfigured()) {
    captureError(
      new Error(
        "خدمة الدفع الإلكتروني غير مُهيأة (Paymob credentials missing)",
      ),
      req,
    );
    return res.status(503).json({
      error: "خدمة الدفع الإلكتروني غير مُهيأة حاليًا.",
    });
  }

  if (notes !== undefined && notes !== null && typeof notes !== "string") {
    return res.status(400).json({
      error: "الملاحظات يجب أن تكون نصًا صالحًا",
    });
  }

  if (typeof notes === "string" && notes.trim().length > 1000) {
    return res.status(400).json({
      error: "الملاحظات يجب ألا تتجاوز 1000 حرف",
    });
  }

  let client;
  let pendingPaymentId = null;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const invoiceResult = await client.query(
      "SELECT * FROM invoices WHERE id = $1 AND clinic_id = $2 FOR UPDATE;",
      [invoice_id, clinic_id],
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

    const paidResult = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE invoice_id = $1 AND clinic_id = $2 AND status = 'paid';",
      [invoice_id, clinic_id],
    );

    const invoiceTotalCents = Math.round(Number(invoice.total_amount) * 100);
    const alreadyPaidCents = Math.round(
      Number(paidResult.rows[0].total_paid) * 100,
    );
    const remainingCents = invoiceTotalCents - alreadyPaidCents;

    if (remainingCents <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "الفاتورة مسددة بالكامل ولا يوجد متبقي لإنشاء رابط دفع",
      });
    }

    const installmentsRes = await client.query(
      `SELECT id, installment_number, amount, status
   FROM installments
   WHERE clinic_id = $1
     AND invoice_id = $2
     AND status <> 'cancelled'
   ORDER BY due_date ASC, installment_number ASC
   FOR UPDATE`,
      [clinic_id, invoice_id],
    );

    let targetOnlineInstallment = null;
    let requestedAmountCents = remainingCents;

    if (installmentsRes.rows.length > 0) {
      targetOnlineInstallment = installment_id
        ? installmentsRes.rows.find((i) => i.id === installment_id)
        : installmentsRes.rows.find((i) => i.status === "pending");

      if (!targetOnlineInstallment) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: installment_id
            ? "القسط المحدد غير موجود أو لا يخص هذه الفاتورة"
            : "لا يوجد قسط مستحق للدفع",
        });
      }

      if (targetOnlineInstallment.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "لا يمكن إنشاء رابط دفع إلا لقسط مستحق بالكامل",
        });
      }

      // الرابط يسدد القسط المختار بالكامل فقط
      requestedAmountCents = Math.round(
        Number(targetOnlineInstallment.amount) * 100,
      );
    } else {
      if (installment_id) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "القسط المحدد غير موجود أو لا يخص هذه الفاتورة",
        });
      }

      if (amount !== undefined && amount !== null && amount !== "") {
        const parsedAmount = Number(amount);

        if (!Number.isFinite(parsedAmount) || parsedAmount < 0.01) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "المبلغ المطلوب يجب ألا يقل عن 0.01 ج.م",
          });
        }

        requestedAmountCents = Math.round(parsedAmount * 100);
      }
    }

    if (requestedAmountCents > remainingCents) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `المبلغ المطلوب (${requestedAmountCents / 100}) يتجاوز المتبقي من الفاتورة (${remainingCents / 100} جنيه)`,
      });
    }

    const patientResult = await client.query(
      "SELECT name, phone_number FROM patients WHERE id = $1 AND clinic_id = $2;",
      [invoice.patient_id, clinic_id],
    );

    if (patientResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "بيانات المريض غير موجودة" });
    }

    const patient = patientResult.rows[0];
    const clinicResult = await client.query(
      "SELECT name FROM clinics WHERE id = $1;",
      [clinic_id],
    );

    const clinicName = clinicResult.rows[0]?.name || "العيادة";
    const normalizedPhone = normalizeEgyptianPhone(patient.phone_number);

    if (!normalizedPhone) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "رقم هاتف المريض غير مسجل بصيغة مصرية صحيحة" });
    }

    // نلغي فقط الروابط المعلقة لنفس القسط (أو كل الروابط لو الفاتورة بدون أقساط)
    const installmentMarker = targetOnlineInstallment
      ? `%[installment_id:${targetOnlineInstallment.id}]%`
      : null;

    await client.query(
      `UPDATE payments 
       SET status = 'cancelled', 
           notes = COALESCE(notes, '') || ' [ملغى: تم استبداله برابط دفع جديد]'
       WHERE invoice_id = $1 AND clinic_id = $2 AND status = 'pending'
         AND ($3::text IS NULL OR notes LIKE $3);`,
      [invoice_id, clinic_id, installmentMarker],
    );

    const expiresAt = new Date(Date.now() + validHours * 60 * 60 * 1000);
    const finalAmountEGP = requestedAmountCents / 100;

    const paymentResult = await client.query(
      `INSERT INTO payments (
        clinic_id, invoice_id, amount, payment_method, 
        status, provider, expires_at, created_by, notes
      )
      VALUES ($1, $2, $3, 'online', 'pending', 'paymob', $4, $5, $6)
      RETURNING *;`,
      [
        clinic_id,
        invoice_id,
        finalAmountEGP,
        expiresAt,
        req.user.clinic_id ? user_id : null,
        [
          notes?.trim() || null,
          targetOnlineInstallment
            ? `[installment_id:${targetOnlineInstallment.id}]`
            : null,
        ]
          .filter(Boolean)
          .join(" ") || null,
      ],
    );

    const pendingPayment = paymentResult.rows[0];
    pendingPaymentId = pendingPayment.id;
    await client.query("COMMIT");

    try {
      const session = await provider.createPaymentSession({
        amount: finalAmountEGP,
        currency: "EGP",
        invoiceId: invoice.id,
        paymentId: pendingPayment.id,
        patient: { ...patient, phone_number: normalizedPhone },
        clinicEmail: clinic_email,
        expiresAt: expiresAt,
      });

      await pool.query(
        "UPDATE payments SET provider_order_id = $1 WHERE id = $2;",
        [session.providerOrderId, pendingPayment.id],
      );

      const whatsappLinkData = whatsAppService.generateWhatsAppLink({
        type: "payment_link",
        phone: normalizedPhone,
        data: {
          patientName: patient.name,
          clinicName,
          amount: finalAmountEGP,
          invoiceId: invoice.id,
          paymentUrl: session.paymentUrl,
        },
      });

      res.status(201).json({
        message: "تم إنشاء رابط الدفع بنجاح",
        payment_id: pendingPayment.id,
        amount: finalAmountEGP,
        payment_url: session.paymentUrl,
        whatsapp_url: whatsappLinkData.url,
        expires_at: expiresAt,
        is_mock: provider.isMock(),
      });
    } catch (paymobError) {
      console.error("Paymob API Session Error:", paymobError.message);
      if (pendingPaymentId) {
        await pool.query(
          "UPDATE payments SET status = 'failed', notes = COALESCE(notes, '') || ' [فشل في إنشاء جلسة Paymob]' WHERE id = $1;",
          [pendingPaymentId],
        );
      }
      throw paymobError;
    }
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("Rollback error:", rollbackErr.message);
      }
    }
    captureError(error, req);
    console.error("Error creating online payment:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء إنشاء رابط الدفع" });
  } finally {
    if (client) client.release();
  }
};

// ==========================================
// 3. استقبال إشعار الدفع (Paymob Webhook)
// ==========================================
const handlePaymobWebhook = async (req, res) => {
  const provider = getPaymentProvider("paymob");

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
  } = webhookData;

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    let paymentLookupQuery =
      "SELECT * FROM payments WHERE id = $1 AND provider = 'paymob' AND payment_method = 'online';";

    let paymentLookupParams = [paymentId];

    if (!paymentId && orderId) {
      paymentLookupQuery =
        "SELECT * FROM payments WHERE provider_order_id = $1 AND provider = 'paymob' AND payment_method = 'online';";

      paymentLookupParams = [orderId];
    }

    const paymentLookupResult = await client.query(
      paymentLookupQuery,
      paymentLookupParams,
    );

    if (paymentLookupResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(200).json({
        message: "Payment record not found, ignored.",
      });
    }

    const paymentRef = paymentLookupResult.rows[0];

    const invoiceResult = await client.query(
      "SELECT * FROM invoices WHERE id = $1 AND clinic_id = $2 FOR UPDATE;",
      [paymentRef.invoice_id, paymentRef.clinic_id],
    );

    if (invoiceResult.rows.length === 0) {
      await client.query("ROLLBACK");
      const errMessage = `Paymob Webhook: Invoice ${paymentRef.invoice_id} not found for payment ${paymentRef.id}`;
      console.error(errMessage);
      captureError(new Error(errMessage), req);
      return res.status(500).json({
        error: "Invoice associated with payment was not found",
      });
    }

    const invoice = invoiceResult.rows[0];

    const paymentResult = await client.query(
      "SELECT * FROM payments WHERE id = $1 FOR UPDATE;",
      [paymentRef.id],
    );

    if (paymentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(500).json({
        error: "Payment record disappeared during webhook processing",
      });
    }

    const payment = paymentResult.rows[0];

    if (payment.status === "paid") {
      await client.query("ROLLBACK");
      return res.status(200).json({
        message: "Payment already confirmed and processed.",
      });
    }

    if (payment.status === "needs_review") {
      await client.query("ROLLBACK");
      return res.status(200).json({
        message: "Payment is already under manual review.",
      });
    }

    if (payment.status === "cancelled" && isSuccess) {
      await client.query(
        `UPDATE payments
         SET status = 'needs_review',
             provider_transaction_id = COALESCE($1, provider_transaction_id),
             notes = COALESCE(notes, '') ||
               ' [مراجعة مطلوبة: تم تأكيد الدفع بواسطة Paymob لرابط ملغى من العيادة] '
         WHERE id = $2;`,
        [transactionId, payment.id],
      );

      await client.query("COMMIT");
      return res.status(200).json({
        message: "Payment received on cancelled record, marked for review.",
      });
    }

    if (payment.status === "cancelled" && !isSuccess) {
      await client.query("ROLLBACK");
      return res.status(200).json({
        message: "Payment was cancelled by the clinic, event ignored.",
      });
    }

    if (isPending) {
      await client.query(
        `UPDATE payments
         SET provider_transaction_id = COALESCE($1, provider_transaction_id)
         WHERE id = $2;`,
        [transactionId, payment.id],
      );

      await client.query("COMMIT");
      return res.status(200).json({
        message: "Payment is still pending confirmation.",
      });
    }

    if (!isSuccess) {
      await client.query(
        `UPDATE payments
         SET status = 'failed',
             provider_transaction_id = COALESCE($1, provider_transaction_id),
             notes = COALESCE(notes, '') || ' [محاولة دفع فاشلة عبر Paymob]'
         WHERE id = $2;`,
        [transactionId, payment.id],
      );

      await client.query("COMMIT");
      return res.status(200).json({
        message: "Payment marked as failed.",
      });
    }

    const expectedAmountCents = Math.round(Number(payment.amount) * 100);

    if (Number(amountCents) !== expectedAmountCents) {
      await client.query(
        `UPDATE payments
         SET status = 'needs_review',
             provider_transaction_id = COALESCE($1, provider_transaction_id),
             notes = COALESCE(notes, '') ||
               ' [مراجعة مطلوبة: اختلاف مبلغ Paymob عن المبلغ المسجل] '
         WHERE id = $2;`,
        [transactionId, payment.id],
      );

      await client.query("COMMIT");
      return res.status(200).json({
        message: "Payment received but marked for manual review.",
      });
    }

    if (invoice.status === "cancelled" || invoice.is_archived) {
      await client.query(
        `UPDATE payments
         SET status = 'needs_review',
             provider_transaction_id = COALESCE($1, provider_transaction_id),
             notes = COALESCE(notes, '') ||
               ' [مراجعة مطلوبة: تم تأكيد الدفع على فاتورة ملغاة أو مؤرشفة] '
         WHERE id = $2;`,
        [transactionId, payment.id],
      );

      await client.query("COMMIT");
      return res.status(200).json({
        message: "Payment received and marked for manual review.",
      });
    }

    const totalPaidResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_paid
       FROM payments
       WHERE invoice_id = $1
         AND clinic_id = $2
         AND status = 'paid';`,
      [payment.invoice_id, payment.clinic_id],
    );

    const invoiceTotalCents = Math.round(Number(invoice.total_amount) * 100);
    const alreadyPaidCents = Math.round(
      Number(totalPaidResult.rows[0].total_paid) * 100,
    );
    const newTotalPaidCents = alreadyPaidCents + expectedAmountCents;

    if (newTotalPaidCents > invoiceTotalCents) {
      await client.query(
        `UPDATE payments
         SET status = 'needs_review',
             provider_transaction_id = COALESCE($1, provider_transaction_id),
             notes = COALESCE(notes, '') ||
               ' [مراجعة مطلوبة: الدفع الإلكتروني تجاوز المتبقي على الفاتورة] '
         WHERE id = $2;`,
        [transactionId, payment.id],
      );

      await client.query("COMMIT");
      return res.status(200).json({
        message: "Payment received but marked for manual review.",
      });
    }

    let installmentToSettle = null;

    const activeInstallmentsResult = await client.query(
      `SELECT id, installment_number, amount, status
   FROM installments
   WHERE clinic_id = $1
     AND invoice_id = $2
     AND status <> 'cancelled'
   ORDER BY due_date ASC, installment_number ASC
   FOR UPDATE`,
      [payment.clinic_id, invoice.id],
    );

    if (activeInstallmentsResult.rows.length > 0) {
      const markerMatches = [
        ...String(payment.notes || "").matchAll(
          /\[installment_id:([0-9a-f-]{36})\]/gi,
        ),
      ];

      // نستخدم آخر معرّف، لأن الملاحظات قد تحتوي على نصوص أو علامات أقدم
      const marker = markerMatches.at(-1);

      installmentToSettle = marker
        ? activeInstallmentsResult.rows.find(
            (inst) => inst.id.toLowerCase() === marker[1].toLowerCase(),
          )
        : null;

      if (
        !installmentToSettle ||
        installmentToSettle.status !== "pending" ||
        Math.round(Number(installmentToSettle.amount) * 100) !==
          expectedAmountCents
      ) {
        await client.query(
          `UPDATE payments
       SET status = 'needs_review',
           provider_transaction_id =
             COALESCE($1, provider_transaction_id),
           notes = COALESCE(notes, '') ||
             ' [مراجعة مطلوبة: تعذر مطابقة الدفعة مع القسط المحدد]'
       WHERE id = $2`,
          [transactionId, payment.id],
        );

        await client.query("COMMIT");

        return res.status(200).json({
          message: "Payment requires manual review.",
        });
      }
    }

    const retryNote =
      payment.status === "failed"
        ? " [تم تأكيد الدفع بنجاح بعد محاولة فاشلة سابقة]"
        : "";

    await client.query(
      `UPDATE payments
       SET status = 'paid',
           provider_transaction_id = $1,
           paid_at = CURRENT_TIMESTAMP,
           notes = COALESCE(notes, '') || $2
       WHERE id = $3;`,
      [transactionId, retryNote, payment.id],
    );

    const newInvoiceStatus =
      newTotalPaidCents >= invoiceTotalCents ? "paid" : "partially_paid";

    await client.query(
      `UPDATE invoices
       SET status = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
         AND clinic_id = $3;`,
      [newInvoiceStatus, invoice.id, invoice.clinic_id],
    );

    if (installmentToSettle) {
      await client.query(
        `UPDATE installments
     SET paid_amount = amount,
         status = 'paid',
         payment_id = $1,
         paid_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
       AND clinic_id = $3
       AND status = 'pending'`,
        [payment.id, installmentToSettle.id, payment.clinic_id],
      );
    }

    await client.query("COMMIT");

    try {
      await logActivity({
        clinic_id: payment.clinic_id,
        user_id: payment.created_by || null,
        action: "ONLINE_PAYMENT_CONFIRMED",
        entity_type: "invoice",
        entity_id: invoice.id,
        description: `تم تأكيد دفع إلكتروني (Paymob) بقيمة ${
          payment.amount
        } ج.م للفاتورة #${invoice.id.slice(0, 8)}`,
        metadata: {
          payment_id: payment.id,
          transaction_id: transactionId,
          amount: payment.amount,
          provider: "paymob",
          invoice_status: newInvoiceStatus,
        },
      });
    } catch (auditError) {
      console.error("Audit log failed:", auditError);
    }

    return res.status(200).json({
      message: "Payment successfully confirmed and recorded.",
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("Rollback error:", rollbackErr.message);
      }
    }
    captureError(error, req);
    console.error("Error processing Paymob webhook:", error);

    return res.status(500).json({
      error: "Internal webhook processing error",
    });
  } finally {
    if (client) {
      client.release();
    }
  }
};

// ==========================================
// 4. إلغاء / تصحيح دفعة مالية (Void Payment + Installment Rollback)
// ==========================================
const voidPayment = async (req, res) => {
  const clinic_id = req.user.clinic_id;
  const user_id = req.user.id;
  const user_role = req.user.role;
  const payment_id = req.params.id || req.params.paymentId;
  const { reason } = req.body;

  if (!["ClinicAdmin", "SuperAdmin"].includes(user_role)) {
    return res.status(403).json({
      error:
        "غير مصرح لك بإلغاء الدفعات المالية. هذه الصلاحية لمدير العيادة فقط.",
    });
  }

  if (!payment_id || !isValidUuid(payment_id)) {
    return res.status(400).json({ error: "معرّف الدفعة غير صالح" });
  }

  if (typeof reason !== "string" || reason.trim().length < 3) {
    return res.status(400).json({
      error: "يرجى ذكر سبب إلغاء الدفعة بوضوح (3 أحرف على الأقل)",
    });
  }

  let client;
  try {
    client = await pool.connect();

    const lookupResult = await client.query(
      "SELECT invoice_id FROM payments WHERE id = $1 AND clinic_id = $2;",
      [payment_id, clinic_id],
    );

    if (lookupResult.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "الدفعة غير موجودة في هذه العيادة" });
    }
    const targetInvoiceId = lookupResult.rows[0].invoice_id;

    await client.query("BEGIN");

    const invoiceResult = await client.query(
      "SELECT * FROM invoices WHERE id = $1 AND clinic_id = $2 FOR UPDATE;",
      [targetInvoiceId, clinic_id],
    );

    if (invoiceResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "الفاتورة المرتبطة بهذه الدفعة غير موجودة" });
    }
    const invoice = invoiceResult.rows[0];

    const paymentResult = await client.query(
      "SELECT * FROM payments WHERE id = $1 AND clinic_id = $2 FOR UPDATE;",
      [payment_id, clinic_id],
    );

    if (paymentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الدفعة غير موجودة" });
    }
    const payment = paymentResult.rows[0];

    if (payment.status !== "paid") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `لا يمكن إلغاء هذه الدفعة لأن حالتها الحالية هي (${payment.status})`,
      });
    }

    if (
      String(payment.provider || "").toLowerCase() === "paymob" ||
      String(payment.payment_method || "").toLowerCase() === "online"
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error:
          "لا يمكن إلغاء دفعة إلكترونية بهذه الطريقة. يجب تنفيذ الاسترداد المالي أولًا.",
      });
    }

    const voidNote = ` [ملغاة بواسطة ${req.user.name || "المدير"}: ${reason.trim()}]`;
    const updatedPaymentResult = await client.query(
      `UPDATE payments 
       SET status = 'cancelled', 
           notes = COALESCE(notes, '') || $1
       WHERE id = $2 AND clinic_id = $3
       RETURNING *;`,
      [voidNote, payment_id, clinic_id],
    );

    // إلغاء تسوية القسط المرتبط بهذه الدفعة مباشرة (إن وجد) وإعادته إلى «مستحق» فقط
    const revertedInstallment = await revertVoidedPaymentFromInstallment(
      client,
      {
        clinic_id,
        payment_id: payment.id,
      },
    );

    const totalPaidResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_paid 
       FROM payments 
       WHERE invoice_id = $1 AND clinic_id = $2 AND status = 'paid';`,
      [invoice.id, clinic_id],
    );

    const invoiceTotalCents = Math.round(Number(invoice.total_amount) * 100);
    const newPaidCents = Math.round(
      Number(totalPaidResult.rows[0].total_paid) * 100,
    );

    let newInvoiceStatus =
      invoice.status === "cancelled" ? "cancelled" : "unpaid";
    if (invoice.status === "cancelled") {
      // لا نغيّر حالة فاتورة ملغاة
    } else if (newPaidCents >= invoiceTotalCents) {
      newInvoiceStatus = "paid";
    } else if (newPaidCents > 0) {
      newInvoiceStatus = "partially_paid";
    }

    let newIsArchived = invoice.is_archived;
    if (newInvoiceStatus !== "paid" && newInvoiceStatus !== "cancelled") {
      newIsArchived = false;
    }

    await client.query(
      "UPDATE invoices SET status = $1, is_archived = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND clinic_id = $4;",
      [newInvoiceStatus, newIsArchived, invoice.id, clinic_id],
    );

    await client.query("COMMIT");

    const remainingAmount = Math.max(
      0,
      (invoiceTotalCents - newPaidCents) / 100,
    );

    try {
      await logActivity({
        clinic_id,
        user_id,
        action: "VOID_PAYMENT",
        entity_type: "invoice",
        entity_id: invoice.id,
        description: `قام ${req.user.name || "مدير العيادة"} بإلغاء دفعة بقيمة ${payment.amount} ج.م للفاتورة #${String(invoice.id).slice(0, 8)}${
          revertedInstallment
            ? ` (إعادة القسط #${revertedInstallment.installment_number} إلى مستحق)`
            : ""
        } - السبب: ${reason.trim()}`,
        metadata: {
          payment_id: payment.id,
          invoice_id: invoice.id,
          voided_amount: payment.amount,
          new_paid_total: newPaidCents / 100,
          new_invoice_status: newInvoiceStatus,
          reverted_installment_id: revertedInstallment?.id || null,
          reverted_installment_number:
            revertedInstallment?.installment_number || null,
          reason: reason.trim(),
        },
      });
    } catch (auditErr) {
      console.error("Audit log failed for voidPayment:", auditErr.message);
    }

    res.status(200).json({
      message: revertedInstallment
        ? `تم إلغاء الدفعة وإعادة القسط #${revertedInstallment.installment_number} إلى مستحق بنجاح`
        : "تم إلغاء الدفعة وإعادة تسوية الفاتورة بنجاح",
      payment: updatedPaymentResult.rows[0],
      invoice_status: newInvoiceStatus,
      remaining_amount: remainingAmount,
      reverted_installment: revertedInstallment,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("Rollback error:", rollbackErr.message);
      }
    }
    captureError(error, req);
    console.error("Error voiding payment:", error.message);
    res.status(500).json({ error: "حدث خطأ أثناء إلغاء الدفعة المالية" });
  } finally {
    if (client) client.release();
  }
};

module.exports = {
  recordPayment,
  createOnlinePayment,
  handlePaymobWebhook,
  voidPayment,
};
