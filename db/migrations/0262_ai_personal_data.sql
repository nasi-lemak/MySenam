-- Whether the venue's API keys show customers' names, phone numbers and email
-- addresses to an AI assistant through the MCP server (docs/integrations/mcp.md,
-- ADR 0029). Off by default: through MCP a booking reads as its times, court,
-- status, price, payment status and code only. Only a manager turns it on, under
-- Venues & staff -> API and webhooks, after a warning that the assistant's
-- provider may process the data outside the country and that the venue answers
-- for that choice. When it was last changed, and by whom (the staff member's
-- name as it was, the way the staff activity log keeps names), is kept beside
-- it; the change is in the staff activity log too. The public API (/api/v1)
-- is not affected by it.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS ai_personal_data BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS ai_personal_data_changed_at TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS ai_personal_data_changed_by TEXT;
