<?php
require_once __DIR__ . '/db.php';

$token = getBearerToken();
if ($token) {
    $pdo = get_db();
    $pdo->prepare('DELETE FROM sessions WHERE session_token = ?')->execute([$token]);
}

json_out(['ok' => true]);