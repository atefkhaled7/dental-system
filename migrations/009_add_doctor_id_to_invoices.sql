ALTER TABLE invoices 
ADD COLUMN IF NOT EXISTS doctor_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_doctor_id 
ON invoices (clinic_id, doctor_id);