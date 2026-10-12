-- 1. إضافة عمود updated_at لجدول support_tickets
ALTER TABLE support_tickets
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 2. تأكيد وجود عمود doctor_id في invoices (لضمان تطابق الميجريشنز مع البرودكشن)
ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS doctor_id UUID REFERENCES users(id) ON DELETE SET NULL;