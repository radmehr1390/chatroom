-- Migration v2 for موج
-- اجرا یک‌بار روی دیتابیس موجود

ALTER TABLE conversations
  MODIFY COLUMN type ENUM('private','group','channel','saved') NOT NULL DEFAULT 'private';

-- اگر ستون‌ها از قبل وجود دارند خطا می‌دهد؛ در آن صورت خط مربوطه را نادیده بگیرید
ALTER TABLE conversations ADD COLUMN slug VARCHAR(32) DEFAULT NULL AFTER title;
ALTER TABLE conversations ADD COLUMN avatar_path VARCHAR(255) DEFAULT NULL AFTER slug;
ALTER TABLE conversations ADD COLUMN description VARCHAR(500) DEFAULT NULL AFTER avatar_path;
ALTER TABLE conversations ADD COLUMN is_public TINYINT(1) NOT NULL DEFAULT 0 AFTER description;
ALTER TABLE conversations ADD COLUMN created_by INT DEFAULT NULL AFTER is_public;

ALTER TABLE conversation_members ADD COLUMN role ENUM('member','admin','owner') NOT NULL DEFAULT 'member' AFTER user_id;

-- ایندکس یکتا برای آیدی عمومی کانال/گروه
ALTER TABLE conversations ADD UNIQUE INDEX idx_conv_slug (slug);
