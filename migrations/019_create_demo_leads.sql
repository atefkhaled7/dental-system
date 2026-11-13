-- migrations/019_create_demo_leads.sql
-- جدول حفظ بيانات زوار الديمو (Leads) مع بيانات الموافقة والحملات الإعلانية (UTMs)

CREATE TABLE IF NOT EXISTS demo_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  consent_given BOOLEAN NOT NULL DEFAULT FALSE,
  consent_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consent_purpose VARCHAR(255) NOT NULL DEFAULT 'demo_followup_and_onboarding',
  utm_source VARCHAR(100),
  utm_medium VARCHAR(100),
  utm_campaign VARCHAR(150),
  utm_content VARCHAR(150),
  fbclid VARCHAR(255),
  ip_address VARCHAR(64),
  user_agent VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_demo_leads_phone ON demo_leads(phone);
CREATE INDEX IF NOT EXISTS idx_demo_leads_created_at ON demo_leads(created_at DESC);