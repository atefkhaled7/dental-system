-- Migration 013: Clinic Working Hours, Holidays, Chairs Count & Appointment Statuses

-- 1. إضافة عدد الكراسي في جدول العيادات
ALTER TABLE public.clinics
ADD COLUMN IF NOT EXISTS total_chairs_count INT NOT NULL DEFAULT 1
CHECK (total_chairs_count >= 1 AND total_chairs_count <= 50);

-- 2. تحديث قيد حالات الموعد ليدعم أزرار الاستقبال والعيادة (وصل arrived / ابدأ الكشف in_progress)
ALTER TABLE public.appointments
DROP CONSTRAINT IF EXISTS chk_appointment_status;

ALTER TABLE public.appointments
ADD CONSTRAINT chk_appointment_status
CHECK (status IN ('scheduled', 'arrived', 'in_progress', 'completed', 'no_show', 'cancelled'));

-- إزالة القيد الفريد الصارم للسماح لـ ClinicAdmin بتجاوز التعارض (allow_override) في الطوارئ
-- بينما يظل القفل البرمجي FOR UPDATE في محرك التعارضات يحمي الحجوزات العادية
DROP INDEX IF EXISTS public.uq_scheduled_appointment;

-- 3. جدول ساعات عمل العيادة الأسبوعية
CREATE TABLE IF NOT EXISTS public.clinic_working_hours (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    weekday INT NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=الأحد ... 6=السبت
    open_time TIME NOT NULL DEFAULT '09:00:00',
    close_time TIME NOT NULL DEFAULT '22:00:00',
    breaks JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_closed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_clinic_working_weekday UNIQUE (clinic_id, weekday),
    CONSTRAINT chk_clinic_hours_order CHECK (is_closed = TRUE OR open_time < close_time)
);

CREATE INDEX IF NOT EXISTS idx_clinic_working_hours_clinic
    ON public.clinic_working_hours(clinic_id, weekday);

-- 4. جدول العطلات الرسمية للعيادة
CREATE TABLE IF NOT EXISTS public.clinic_holidays (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    reason VARCHAR(255) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_clinic_holiday_date UNIQUE (clinic_id, date)
);

CREATE INDEX IF NOT EXISTS idx_clinic_holidays_lookup
    ON public.clinic_holidays(clinic_id, date);