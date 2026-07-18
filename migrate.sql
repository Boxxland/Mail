-- Tables สำหรับ OAuth2 system
CREATE TABLE IF NOT EXISTS oauth_codes (
  discord_id TEXT PRIMARY KEY,
  web_user_id TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discord_links (
  discord_id TEXT PRIMARY KEY,
  web_user_id TEXT NOT NULL,
  linked_at TIMESTAMPTZ DEFAULT now()
);
