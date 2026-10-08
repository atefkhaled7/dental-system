-- 1. إضافة بيانات الصفحة العامة للعيادة
ALTER TABLE clinics
ADD COLUMN IF NOT EXISTS slug VARCHAR(100) UNIQUE,
ADD COLUMN IF NOT EXISTS address VARCHAR(255),
ADD COLUMN IF NOT EXISTS bio TEXT;


-- 2. إنشاء جدول طلبات الحجز العامة
CREATE TABLE IF NOT EXISTS booking_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  clinic_id UUID NOT NULL
    REFERENCES clinics(id) ON DELETE CASCADE,

  doctor_id UUID NOT NULL
    REFERENCES users(id) ON DELETE CASCADE,

  procedure_code_id UUID
    REFERENCES procedure_codes(id) ON DELETE SET NULL,

  patient_name VARCHAR(150) NOT NULL,
  patient_phone VARCHAR(30) NOT NULL,

  requested_date TIMESTAMP WITH TIME ZONE NOT NULL,

  duration_minutes INT NOT NULL DEFAULT 30,

  status VARCHAR(20) NOT NULL DEFAULT 'pending',

  notes TEXT,

  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT check_booking_status
    CHECK (
      status IN ('pending', 'approved', 'rejected', 'expired')
    ),

  CONSTRAINT check_booking_duration
    CHECK (
      duration_minutes >= 5
      AND duration_minutes <= 480
    )
);


-- 3. فهارس
CREATE INDEX IF NOT EXISTS idx_booking_requests_clinic_status
ON booking_requests (clinic_id, status);

CREATE INDEX IF NOT EXISTS idx_booking_requests_expiry
ON booking_requests (expires_at)
WHERE status = 'pending';