<?php
require_once __DIR__ . '/db.php';

$input = json_decode(file_get_contents('php://input'), true) ?? [];
$mobile = trim($input['mobile'] ?? '');

if (!preg_match('/^09\d{9}$/', $mobile)) {
    json_out(['ok' => false, 'error' => 'invalid_mobile'], 422);
}

$pdo = get_db();

// ---- بررسی محدودیت ارسال مجدد (حداکثر ۶۰ ثانیه) ----
$stmt = $pdo->prepare('SELECT created_at FROM otp_codes WHERE phone = ? ORDER BY id DESC LIMIT 1');
$stmt->execute([$mobile]);
$last = $stmt->fetchColumn();

if ($last) {
    $timeDiff = time() - strtotime($last);
    if ($timeDiff < OTP_RESEND_COOLDOWN) {
        $wait = OTP_RESEND_COOLDOWN - $timeDiff;
        json_out([
            'ok' => false, 
            'error' => 'too_many_requests', 
            'retry_after' => $wait
        ], 429);
    }
}

// ---- حذف کدهای قدیمی برای این شماره (قبل از ایجاد کد جدید) ----
$pdo->prepare('DELETE FROM otp_codes WHERE phone = ? AND expires_at < NOW()')->execute([$mobile]);

// ---- تولید کد جدید ----
$code = (string) random_int(10 ** (OTP_LENGTH - 1), (10 ** OTP_LENGTH) - 1);
$codeHash = password_hash($code, PASSWORD_DEFAULT);
$expires = date('Y-m-d H:i:s', time() + OTP_TTL_SECONDS);

$stmt = $pdo->prepare('INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES (?, ?, ?)');
$stmt->execute([$mobile, $codeHash, $expires]);

// ---- ارسال از طریق sms.ir ----
$payload = json_encode([
    'mobile' => $mobile,
    'templateId' => (int) SMSIR_TEMPLATE_ID,
    'parameters' => [
        ['name' => 'CODE', 'value' => $code],
    ],
], JSON_UNESCAPED_UNICODE);

$ch = curl_init(SMSIR_SEND_URL);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CUSTOMREQUEST => 'POST',
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_TIMEOUT => 15,
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'Accept: text/plain',
        'x-api-key: ' . SMSIR_API_KEY,
    ],
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr = curl_error($ch);
curl_close($ch);

if ($curlErr || $httpCode >= 400) {
    error_log('sms.ir send failed: HTTP ' . $httpCode . ' — ' . $curlErr . ' — ' . $response);
    json_out(['ok' => false, 'error' => 'sms_provider_failed'], 502);
}

json_out(['ok' => true, 'expires_in' => OTP_TTL_SECONDS]);