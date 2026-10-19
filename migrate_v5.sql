-- Migration v5: contacts + voice + video messages
CREATE TABLE IF NOT EXISTS contacts (
  user_id INT NOT NULL,
  contact_user_id INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, contact_user_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(contact_user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_contacts_contact(contact_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE messages MODIFY COLUMN msg_type ENUM('text','image','video','video_message','voice','file','sticker') NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN duration_seconds INT DEFAULT NULL AFTER file_size;
