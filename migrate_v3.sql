-- Migration v3 — موج
-- این اسکریپت را یک‌بار در phpMyAdmin یا mysql اجرا کنید.
-- اگر خطای Duplicate column دیدید، آن خط را رد کنید (یعنی از قبل وجود دارد).

-- ستون‌های رسانه روی پیام‌ها
ALTER TABLE messages ADD COLUMN msg_type ENUM('text','image','video','file','sticker') NOT NULL DEFAULT 'text' AFTER body;
ALTER TABLE messages ADD COLUMN file_path VARCHAR(255) DEFAULT NULL AFTER msg_type;
ALTER TABLE messages ADD COLUMN file_mime VARCHAR(100) DEFAULT NULL AFTER file_path;
ALTER TABLE messages ADD COLUMN file_name VARCHAR(255) DEFAULT NULL AFTER file_mime;
ALTER TABLE messages ADD COLUMN file_size INT DEFAULT NULL AFTER file_name;

-- اطلاعات دستگاه روی نشست‌ها
ALTER TABLE auth_sessions ADD COLUMN user_agent VARCHAR(500) DEFAULT NULL AFTER token_hash;
ALTER TABLE auth_sessions ADD COLUMN device_label VARCHAR(120) DEFAULT NULL AFTER user_agent;
ALTER TABLE auth_sessions ADD COLUMN ip VARCHAR(45) DEFAULT NULL AFTER device_label;

-- وضعیت تایپ
CREATE TABLE IF NOT EXISTS typing_status (
  conversation_id BIGINT NOT NULL,
  user_id INT NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (conversation_id, user_id),
  INDEX idx_typing_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
