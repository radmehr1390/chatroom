-- Migration v4: reply, delete, pin, block, push

ALTER TABLE messages ADD COLUMN reply_to_id BIGINT DEFAULT NULL AFTER sender_id;

ALTER TABLE conversation_members ADD COLUMN pinned_at DATETIME DEFAULT NULL AFTER last_read_message_id;
ALTER TABLE conversation_members ADD COLUMN is_muted TINYINT(1) NOT NULL DEFAULT 0 AFTER pinned_at;

CREATE TABLE IF NOT EXISTS blocked_users (
  blocker_id INT NOT NULL,
  blocked_id INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blocker_id, blocked_id),
  FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh VARCHAR(255) NOT NULL,
  auth VARCHAR(255) NOT NULL,
  user_agent VARCHAR(500) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_endpoint (endpoint(255)),
  INDEX idx_push_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
