<?php
require_once __DIR__ . '/db.php';

$input = json_decode(file_get_contents('php://input'), true) ?? [];
$mobile = trim($input['mobile'] ?? '');
$code = trim($input['code'] ?? '');

if (!preg_match('/^09\d{9}$/', $mobile) || !preg_match('/^\d{' . OTP_LENGTH . '}$/', $code)) {
    json_out(['ok' => false, 'error' => 'invalid_input'], 422);
}

$pdo = get_db();

$stmt = $pdo->prepare('SELECT id, code_hash, attempts, expires_at FROM otp_codes WHERE phone = ? ORDER BY id DESC LIMIT 1');
$stmt->execute([$mobile]);
$row = $stmt->fetch();

if (!$row) {
    json_out(['ok' => false, 'error' => 'no_otp_requested'], 404);
}

if (strtotime($row['expires_at']) < time()) {
    json_out(['ok' => false, 'error' => 'code_expired'], 410);
}

if ($row['attempts'] >= OTP_MAX_ATTEMPTS) {
    json_out(['ok' => false, 'error' => 'too_many_attempts'], 429);
}

if (!password_verify($code, $row['code_hash'])) {
    $pdo->prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?')->execute([$row['id']]);
    json_out(['ok' => false, 'error' => 'wrong_code'], 401);
}

// موفقیت: منقضی کردن کد
$pdo->prepare('UPDATE otp_codes SET expires_at = NOW() WHERE id = ?')->execute([$row['id']]);

// بررسی کاربر موجود
$stmt = $pdo->prepare('SELECT id, phone, username, first_name, last_name, avatar_path, last_seen FROM users WHERE phone = ?');
$stmt->execute([$mobile]);
$existingUser = $stmt->fetch() ?: null;

// اگر کاربر از قبل وجود دارد → مستقیم session بساز و لاگین کن
if ($existingUser) {
    $session = bin2hex(random_bytes(32));
    $hash = hash('sha256', $session);
    $exp = (new DateTimeImmutable('+' . SESSION_DAYS . ' days'))->format('Y-m-d H:i:s');

    // فقط نشست‌های منقضی را پاک کن — تعداد نشست همزمان نامحدود است
    $pdo->prepare('DELETE FROM auth_sessions WHERE expires_at < NOW()')->execute();
    $ua = substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 500);
    $ip = substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45);
    $pdo->prepare('INSERT INTO auth_sessions (user_id, token_hash, user_agent, device_label, ip, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        ->execute([$existingUser['id'], $hash, $ua ?: null, null, $ip ?: null, $exp]);
    $pdo->prepare('UPDATE users SET last_seen = NOW() WHERE id = ?')->execute([$existingUser['id']]);

    // پاک کردن verified sessionهای قدیمی این شماره
    $pdo->prepare('DELETE FROM verified_sessions WHERE phone = ?')->execute([$mobile]);

    $existingUser['avatar_path'] = absolute_url($existingUser['avatar_path'] ?? null);

    json_out([
        'ok' => true,
        'existing_user' => true,
        'session_token' => $session,
        'user' => $existingUser,
    ]);
}

// کاربر جدید → فقط verified_token بده
$token = bin2hex(random_bytes(32));
$expires = date('Y-m-d H:i:s', time() + VERIFIED_TOKEN_TTL);
$pdo->prepare('INSERT INTO verified_sessions (phone, token, expires_at) VALUES (?, ?, ?)')
    ->execute([$mobile, $token, $expires]);

json_out([
    'ok' => true,
    'existing_user' => false,
    'verified_token' => $token,
    'expires_in' => VERIFIED_TOKEN_TTL,
]);
