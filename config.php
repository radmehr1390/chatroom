<?php
declare(strict_types=1);

/**
 * موج — تنظیمات امن محیط اجرا
 * مقادیر حساس را در Environment Variables هاست تنظیم کنید؛ هرگز کلید یا رمز را در Git نگذارید.
 */
date_default_timezone_set('Asia/Tehran');

ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

// لاگ بیرون از پوشه عمومی پروژه؛ پوشه باید توسط کاربر PHP قابل نوشتن باشد.
$privateLogDir = dirname(__DIR__) . '/private-logs';
if (is_dir($privateLogDir) && is_writable($privateLogDir)) {
    ini_set('error_log', $privateLogDir . '/mouj-php-error.log');
}

define('DB_HOST', getenv('DB_HOST') ?: 'localhost');
define('DB_NAME', getenv('DB_NAME') ?: '');
define('DB_USER', getenv('DB_USER') ?: '');
define('DB_PASS', getenv('DB_PASS') ?: '');
define('APP_BASE_URL', rtrim(getenv('APP_BASE_URL') ?: 'https://chat.radmehrweb.ir', '/'));

define('SMSIR_API_KEY', getenv('SMSIR_API_KEY') ?: '');
define('SMSIR_TEMPLATE_ID', (int) (getenv('SMSIR_TEMPLATE_ID') ?: 248498));
define('SMSIR_SEND_URL', 'https://api.sms.ir/v1/send/verify');

define('OTP_LENGTH', 5);
define('OTP_TTL_SECONDS', 120);
define('OTP_RESEND_COOLDOWN', 60);
define('OTP_MAX_ATTEMPTS', 5);
define('VERIFIED_TOKEN_TTL', 600);
define('SESSION_DAYS', 30);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('X-Frame-Options: DENY');
header('Permissions-Policy: camera=(self), microphone=(self), geolocation=()');
header('Access-Control-Allow-Origin: https://chat.radmehrweb.ir');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Credentials: true');
header('Vary: Origin');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function json_out(array $data, int $code = 200): never {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function db(): PDO {
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;

    if (DB_NAME === '' || DB_USER === '' || DB_PASS === '') {
        error_log('Mouj configuration error: database environment variables are missing.');
        json_out(['ok' => false, 'error' => 'server_configuration_error'], 500);
    }

    $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4';
    try {
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => false,
            PDO::ATTR_TIMEOUT => 5,
        ]);
    } catch (Throwable $e) {
        error_log('Mouj database connection failed: ' . get_class($e));
        json_out(['ok' => false, 'error' => 'db_connection_failed'], 500);
    }
    return $pdo;
}

function input_json(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') return [];
    $data = json_decode($raw, true);
    if (!is_array($data) || json_last_error() !== JSON_ERROR_NONE) {
        json_out(['ok' => false, 'error' => 'invalid_json'], 400);
    }
    return $data;
}

function absolute_url(?string $path): ?string {
    if (!$path) return null;
    if (preg_match('#^https?://#i', $path)) return $path;
    return APP_BASE_URL . '/' . ltrim($path, '/');
}
