-- 1. جدول الشفتات وساعات العمل الأسبوعية للأطباء
CREATE TABLE IF NOT EXISTS doctor_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  doctor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=الأحد، 1=الاثنين ... 5=الجمعة، 6=السبت
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT check_shift_time CHECK (start_time < end_time)
);

-- فهارس لتسريع البحث عن شفتات الطبيب
CREATE INDEX IF NOT EXISTS idx_doctor_availability_lookup 
ON doctor_availability (clinic_id, doctor_id, day_of_week) 
WHERE is_active = TRUE;

-- 2. جدول إجازات واستثناءات الأطباء
CREATE TABLE IF NOT EXISTS doctor_leaves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  doctor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_date DATE NOT NULL,
  notes VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_doctor_leave_date UNIQUE (clinic_id, doctor_id, leave_date)
);

CREATE INDEX IF NOT EXISTS idx_doctor_leaves_lookup 
ON doctor_leaves (clinic_id, doctor_id, leave_date);