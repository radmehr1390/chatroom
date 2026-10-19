-- پاک‌سازی کامل داده‌های موج (ساختار جداول حفظ می‌شود)
SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE typing_status;
TRUNCATE TABLE push_subscriptions;
TRUNCATE TABLE blocked_users;
TRUNCATE TABLE messages;
TRUNCATE TABLE conversation_members;
TRUNCATE TABLE conversations;
TRUNCATE TABLE auth_sessions;
TRUNCATE TABLE verified_sessions;
TRUNCATE TABLE otp_codes;
TRUNCATE TABLE users;

SET FOREIGN_KEY_CHECKS = 1;

-- بعد از اجرا همه چیز خالی است؛ دوباره با شماره موبایل ثبت‌نام کنید.
