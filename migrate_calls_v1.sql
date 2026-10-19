-- موج: تماس صوتی زنده (خصوصی و گروهی)
-- نسخه سازگار با هاست‌های اشتراکی: بدون Foreign Key برای جلوگیری از MySQL errno 150
CREATE TABLE IF NOT EXISTS call_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  created_by INT NOT NULL,
  status ENUM('ringing','active','ended') NOT NULL DEFAULT 'ringing',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME DEFAULT NULL,
  ended_at DATETIME DEFAULT NULL,
  INDEX idx_call_conv_status(conversation_id,status),
  INDEX idx_call_created(created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS call_participants (
  call_id BIGINT NOT NULL,
  user_id INT NOT NULL,
  state ENUM('invited','joined','left') NOT NULL DEFAULT 'invited',
  joined_at DATETIME DEFAULT NULL,
  left_at DATETIME DEFAULT NULL,
  PRIMARY KEY(call_id,user_id),
  INDEX idx_call_participant_user(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS call_signals (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  call_id BIGINT NOT NULL,
  from_user_id INT NOT NULL,
  to_user_id INT NOT NULL,
  signal_type VARCHAR(20) NOT NULL,
  payload LONGTEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_signal_recipient(to_user_id,call_id,id),
  INDEX idx_signal_call(call_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
