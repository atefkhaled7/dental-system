CREATE TABLE IF NOT EXISTS support_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'bug',
    message TEXT NOT NULL,
    page_url VARCHAR(500),
    browser_info TEXT,
    contact_phone VARCHAR(20),
    status VARCHAR(50) NOT NULL DEFAULT 'open',
    admin_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_clinic
    ON support_tickets(clinic_id);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status
    ON support_tickets(status);