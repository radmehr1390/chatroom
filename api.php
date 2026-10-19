<?php
declare(strict_types=1);
require_once __DIR__.'/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST' && $_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_out(['ok' => false, 'error' => 'method_not_allowed'], 405);
}

$in = array_merge($_GET, $_POST, input_json());
$action = (string)($in['action'] ?? '');

function auth_user(): array {
    $t = trim((string)($_SERVER['HTTP_AUTHORIZATION'] ?? ''));
    if (stripos($t, 'Bearer ') === 0) $t = trim(substr($t, 7));
    if (!$t) $t = trim((string)($_COOKIE['mouj_session'] ?? ''));
    if (!$t) json_out(['ok' => false, 'error' => 'unauthorized'], 401);
    $h = hash('sha256', $t);
    $q = db()->prepare('SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > NOW() LIMIT 1');
    $q->execute([$h]);
    $u = $q->fetch();
    if (!$u) json_out(['ok' => false, 'error' => 'unauthorized'], 401);
    if (!empty($u['deleted_at'])) {
        db()->prepare('DELETE FROM auth_sessions WHERE token_hash = ?')->execute([$h]);
        json_out(['ok' => false, 'error' => 'account_deleted'], 401);
    }
    db()->prepare('UPDATE auth_sessions SET last_seen = NOW() WHERE token_hash = ?')->execute([$h]);
    db()->prepare('UPDATE users SET last_seen = NOW() WHERE id = ?')->execute([$u['id']]);
    return $u;
}

function user_json(array $u, bool $hidePhone = false): array {
    $out = [
        'id' => (int)$u['id'],
        'username' => $u['username'] ?? null,
        'first_name' => $u['first_name'] ?? null,
        'last_name' => $u['last_name'] ?? null,
        'avatar_path' => absolute_url($u['avatar_path'] ?? null),
        'last_seen' => $u['last_seen'] ?? null,
        'online' => empty($u['deleted_at']) && !empty($u['last_seen']) && (time() - strtotime($u['last_seen']) <= 45),
        'deleted' => !empty($u['deleted_at']),
    ];
    if (!empty($u['deleted_at'])) {
        $out['first_name'] = 'این اکانت حذف شده';
        $out['last_name'] = null;
        $out['username'] = null;
        $out['avatar_path'] = null;
    }
    if (!$hidePhone && !empty($u['phone'])) {
        $out['phone'] = $u['phone'];
    }
    return $out;
}


function parse_device_label(?string $ua): string {
    $ua = (string)$ua;
    if ($ua === '') return 'دستگاه ناشناس';
    $os = 'نامشخص';
    if (preg_match('/iPhone|iPad/i', $ua)) $os = 'iOS';
    elseif (preg_match('/Android/i', $ua)) $os = 'Android';
    elseif (preg_match('/Windows/i', $ua)) $os = 'Windows';
    elseif (preg_match('/Mac OS|Macintosh/i', $ua)) $os = 'macOS';
    elseif (preg_match('/Linux/i', $ua)) $os = 'Linux';
    $browser = 'مرورگر';
    if (preg_match('/Edg\//i', $ua)) $browser = 'Edge';
    elseif (preg_match('/Chrome\//i', $ua) && !preg_match('/Edg\//i', $ua)) $browser = 'Chrome';
    elseif (preg_match('/Safari\//i', $ua) && !preg_match('/Chrome\//i', $ua)) $browser = 'Safari';
    elseif (preg_match('/Firefox\//i', $ua)) $browser = 'Firefox';
    return $browser . ' · ' . $os;
}

function norm_phone(string $p): string {
    $d = preg_replace('/\D/', '', $p);
    if (strlen($d) === 10 && $d[0] === '9') $d = '0' . $d;
    if (strlen($d) === 12 && str_starts_with($d, '98')) $d = '0' . substr($d, 2);
    return $d;
}

// Message encryption at rest: the database stores authenticated ciphertext, not plaintext.
// This is intentionally server-side at-rest encryption (not E2EE); without E2EE key distribution,
// a one-way hash would make it impossible to display the original message again.
function message_crypto_key(): string {
    static $key = null;
    if ($key !== null) return $key;
    $configured = trim((string)(getenv('MOUJ_ENCRYPTION_KEY') ?: ''));
    $seed = $configured !== '' ? $configured : (DB_PASS . '|' . APP_BASE_URL . '|mouj-message-v1');
    $key = hash('sha256', $seed, true);
    return $key;
}
function encrypt_message_body(string $plain): string {
    if ($plain === '' || str_starts_with($plain, 'MOUJ1:')) return $plain;
    try {
        $iv = random_bytes(12);
        $tag = '';
        $ct = openssl_encrypt($plain, 'aes-256-gcm', message_crypto_key(), OPENSSL_RAW_DATA, $iv, $tag, '', 16);
        if ($ct === false) return $plain;
        return 'MOUJ1:' . base64_encode($iv . $tag . $ct);
    } catch (Throwable $e) {
        error_log('message encryption failed: '.$e->getMessage());
        return $plain;
    }
}
function decrypt_message_body(string $stored): string {
    if (!str_starts_with($stored, 'MOUJ1:')) return $stored;
    try {
        $raw = base64_decode(substr($stored, 6), true);
        if ($raw === false || strlen($raw) < 29) return '🔒 پیام رمزنگاری‌شده';
        $iv = substr($raw, 0, 12); $tag = substr($raw, 12, 16); $ct = substr($raw, 28);
        $plain = openssl_decrypt($ct, 'aes-256-gcm', message_crypto_key(), OPENSSL_RAW_DATA, $iv, $tag, '');
        return $plain === false ? '🔒 پیام رمزنگاری‌شده' : $plain;
    } catch (Throwable $e) { return '🔒 پیام رمزنگاری‌شده'; }
}

// Call actions are handled before the normal action router below, so authenticate here first.
// Without this, $uid was undefined when call_create/call_list/etc. ran.
$u = null;
$uid = 0;
if (strpos($action, 'call_') === 0) {
    $u = auth_user();
    $uid = (int)$u['id'];
}

// --- WebRTC voice calls: private + group ---
function call_member(int $cid, int $userId): bool {
    $q = db()->prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1');
    $q->execute([$cid, $userId]);
    return (bool)$q->fetchColumn();
}
function call_user_ids(int $callId, bool $activeOnly = true): array {
    $sql = 'SELECT user_id FROM call_participants WHERE call_id = ?' . ($activeOnly ? " AND state = 'joined'" : '') . ' ORDER BY user_id';
    $q = db()->prepare($sql); $q->execute([$callId]);
    return array_map('intval', $q->fetchAll(PDO::FETCH_COLUMN));
}

if ($action === 'call_create') {
    ensure_call_tables();
    $cid = (int)($in['conversation_id'] ?? 0);
    if ($cid < 1 || !call_member($cid, $uid)) json_out(['ok'=>false,'error'=>'forbidden'],403);
    $q = db()->prepare("SELECT c.type,c.title FROM conversations c WHERE c.id=? LIMIT 1"); $q->execute([$cid]); $conv=$q->fetch();
    if (!$conv || !in_array($conv['type'], ['private','group'], true)) json_out(['ok'=>false,'error'=>'invalid_conversation'],422);
    $q = db()->prepare("SELECT id FROM call_sessions WHERE conversation_id=? AND status IN ('ringing','active') ORDER BY id DESC LIMIT 1"); $q->execute([$cid]);
    if ($old=$q->fetch()) {
        $oldId=(int)$old['id'];
        $q2=db()->prepare("SELECT u.id,u.last_seen FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=? AND cm.user_id<>? LIMIT 1"); $q2->execute([$cid,$uid]); $peer=$q2->fetch();
        $online=$peer && !empty($peer['last_seen']) && (time()-strtotime($peer['last_seen'])<=45);
        json_out(['ok'=>true,'call_id'=>$oldId,'existing'=>true,'peer_online'=>$online]);
    }
    db()->beginTransaction();
    try {
        db()->prepare("INSERT INTO call_sessions(conversation_id,created_by,status) VALUES(?,?, 'ringing')")->execute([$cid,$uid]);
        $callId=(int)db()->lastInsertId();
        $mq=db()->prepare("SELECT user_id FROM conversation_members WHERE conversation_id=?"); $mq->execute([$cid]);
        foreach($mq->fetchAll(PDO::FETCH_COLUMN) as $memberId){
            $memberId=(int)$memberId;
            db()->prepare("INSERT INTO call_participants(call_id,user_id,state,joined_at,left_at) VALUES(?,?,?,CASE WHEN ?=? THEN NOW() ELSE NULL END,NULL)")->execute([$callId,$memberId,$memberId===$uid?'joined':'invited',$memberId,$uid]);
        }
        db()->commit();
        $online=false;
        if($conv['type']==='private'){
            $q2=db()->prepare("SELECT u.last_seen FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=? AND cm.user_id<>? LIMIT 1"); $q2->execute([$cid,$uid]); $peer=$q2->fetch();
            $online=$peer && !empty($peer['last_seen']) && (time()-strtotime($peer['last_seen'])<=45);
        }
        json_out(['ok'=>true,'call_id'=>$callId,'existing'=>false,'peer_online'=>$online]);
    } catch(Throwable $e) { if(db()->inTransaction()) db()->rollBack(); error_log('call_create: '.$e->getMessage()); json_out(['ok'=>false,'error'=>'call_create_failed','detail'=>$e->getMessage()],500); }
}

if ($action === 'call_list') {
    ensure_call_tables();
    $sql="SELECT cs.id,cs.conversation_id,cs.created_by,cs.status,cs.created_at,cs.started_at,cs.ended_at,
                  c.type,c.title,
                  u.first_name AS creator_first,u.last_name AS creator_last
           FROM call_sessions cs
           JOIN conversations c ON c.id=cs.conversation_id
           JOIN users u ON u.id=cs.created_by
           JOIN conversation_members cm ON cm.conversation_id=cs.conversation_id AND cm.user_id=?
           WHERE (
             (cs.status IN ('ringing','active') AND NOT EXISTS(SELECT 1 FROM call_participants x WHERE x.call_id=cs.id AND x.user_id=? AND x.state='left'))
             OR EXISTS(SELECT 1 FROM call_participants cp2 WHERE cp2.call_id=cs.id AND cp2.user_id=? AND cp2.state='joined')
           )
           ORDER BY cs.id DESC LIMIT 50";
    $q=db()->prepare($sql); $q->execute([$uid,$uid,$uid]); $rows=$q->fetchAll(); $out=[];
    foreach($rows as $r){
        $parts=call_user_ids((int)$r['id'], $r['status'] !== 'ended');
        $out[]=['id'=>(int)$r['id'],'conversation_id'=>(int)$r['conversation_id'],'created_by'=>(int)$r['created_by'],'status'=>$r['status'],'created_at'=>$r['created_at'],'started_at'=>$r['started_at'],'ended_at'=>$r['ended_at'],'type'=>$r['type'],'title'=>$r['title'],'creator_name'=>trim($r['creator_first'].' '.$r['creator_last']),'participants'=>$parts,'mine'=>in_array($uid,$parts,true)];
    }
    json_out(['ok'=>true,'calls'=>$out]);
}

if ($action === 'call_info') {
    ensure_call_tables();
    $callId=(int)($in['call_id']??0);
    $q=db()->prepare("SELECT cs.*,c.conversation_id,c.type,c.title FROM call_sessions cs JOIN conversations c ON c.id=cs.conversation_id WHERE cs.id=? LIMIT 1");
    $q->execute([$callId]); $call=$q->fetch();
    if(!$call) json_out(['ok'=>false,'error'=>'call_not_found'],404);
    if(!call_member((int)$call['conversation_id'],$uid)) json_out(['ok'=>false,'error'=>'forbidden'],403);
    $users=[]; $q=db()->prepare("SELECT cp.user_id,cp.state,u.first_name,u.last_name,u.avatar_path FROM call_participants cp JOIN users u ON u.id=cp.user_id WHERE cp.call_id=? AND cp.state='joined' ORDER BY cp.user_id"); $q->execute([$callId]);
    foreach($q as $r) $users[]=['id'=>(int)$r['user_id'],'first_name'=>$r['first_name'],'last_name'=>$r['last_name'],'avatar_path'=>absolute_url($r['avatar_path']??null)];
    json_out(['ok'=>true,'call'=>['id'=>(int)$call['id'],'conversation_id'=>(int)$call['conversation_id'],'type'=>$call['type'],'title'=>$call['title'],'created_by'=>(int)$call['created_by'],'status'=>$call['status'],'created_at'=>$call['created_at'],'started_at'=>$call['started_at'],'ended_at'=>$call['ended_at'],'participants'=>$users]]);
}

if ($action === 'call_join') {
    ensure_call_tables();
    $callId=(int)($in['call_id']??0);
    $q=db()->prepare('SELECT cs.*,c.conversation_id,c.type FROM call_sessions cs JOIN conversations c ON c.id=cs.conversation_id WHERE cs.id=? LIMIT 1'); $q->execute([$callId]); $call=$q->fetch();
    if(!$call) json_out(['ok'=>false,'error'=>'call_not_found'],404);
    if(!call_member((int)$call['conversation_id'],$uid)) json_out(['ok'=>false,'error'=>'forbidden'],403);
    if($call['status']==='ended') json_out(['ok'=>false,'error'=>'call_ended'],409);
    db()->prepare("INSERT INTO call_participants(call_id,user_id,state,joined_at,left_at) VALUES(?,?, 'joined', NOW(), NULL) ON DUPLICATE KEY UPDATE state='joined', joined_at=NOW(), left_at=NULL")->execute([$callId,$uid]);
    db()->prepare("UPDATE call_sessions SET status='active', started_at=COALESCE(started_at,NOW()) WHERE id=?")->execute([$callId]);
    json_out(['ok'=>true]);
}

if ($action === 'call_signal') {
    ensure_call_tables();
    $callId=(int)($in['call_id']??0); $to=(int)($in['to_user_id']??0); $type=trim((string)($in['signal_type']??'')); $payload=$in['payload']??null;
    if($callId<1||$to<1||!in_array($type,['offer','answer','candidate'],true)||$payload===null) json_out(['ok'=>false,'error'=>'invalid_input'],422);
    $q=db()->prepare("SELECT cs.conversation_id FROM call_sessions cs JOIN call_participants cp ON cp.call_id=cs.id AND cp.user_id=? AND cp.state='joined' WHERE cs.id=? AND cs.status IN ('ringing','active') LIMIT 1"); $q->execute([$uid,$callId]); $call=$q->fetch();
    if(!$call || !call_member((int)$call['conversation_id'],$to)) json_out(['ok'=>false,'error'=>'forbidden'],403);
    $q=db()->prepare("SELECT 1 FROM call_participants WHERE call_id=? AND user_id=? AND state='joined'"); $q->execute([$callId,$to]); if(!$q->fetch()) json_out(['ok'=>false,'error'=>'recipient_not_joined'],409);
    $raw=is_string($payload)?$payload:json_encode($payload,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
    if(strlen($raw)>200000) json_out(['ok'=>false,'error'=>'payload_too_large'],413);
    db()->prepare('INSERT INTO call_signals(call_id,from_user_id,to_user_id,signal_type,payload) VALUES(?,?,?,?,?)')->execute([$callId,$uid,$to,$type,$raw]);
    json_out(['ok'=>true,'id'=>(int)db()->lastInsertId()]);
}

if ($action === 'call_signals') {
    ensure_call_tables();
    $callId=(int)($in['call_id']??0); $after=(int)($in['after_id']??0);
    $q=db()->prepare("SELECT cs.conversation_id FROM call_sessions cs JOIN call_participants cp ON cp.call_id=cs.id AND cp.user_id=? AND cp.state='joined' WHERE cs.id=? LIMIT 1"); $q->execute([$uid,$callId]); $call=$q->fetch();
    if(!$call) json_out(['ok'=>false,'error'=>'forbidden'],403);
    $q=db()->prepare('SELECT id,from_user_id,signal_type,payload,created_at FROM call_signals WHERE call_id=? AND to_user_id=? AND id>? ORDER BY id ASC LIMIT 100'); $q->execute([$callId,$uid,$after]); $out=[];
    foreach($q as $r){ $pl=json_decode($r['payload'],true); $out[]=['id'=>(int)$r['id'],'from_user_id'=>(int)$r['from_user_id'],'signal_type'=>$r['signal_type'],'payload'=>$pl??$r['payload'],'created_at'=>$r['created_at']]; }
    json_out(['ok'=>true,'signals'=>$out]);
}

if ($action === 'call_decline') {
    ensure_call_tables();
    $callId=(int)($in['call_id']??0);
    $q=db()->prepare("SELECT cs.conversation_id,cs.status FROM call_sessions cs WHERE cs.id=? LIMIT 1"); $q->execute([$callId]); $call=$q->fetch();
    if(!$call) json_out(['ok'=>false,'error'=>'call_not_found'],404);
    if(!call_member((int)$call['conversation_id'],$uid)) json_out(['ok'=>false,'error'=>'forbidden'],403);
    db()->prepare("INSERT INTO call_participants(call_id,user_id,state,joined_at,left_at) VALUES(?,?, 'left',NULL,NOW()) ON DUPLICATE KEY UPDATE state='left',left_at=NOW()")->execute([$callId,$uid]);
    json_out(['ok'=>true]);
}

if ($action === 'call_leave') {
    ensure_call_tables();
    $callId=(int)($in['call_id']??0);
    $q=db()->prepare("SELECT cs.conversation_id FROM call_sessions cs JOIN call_participants cp ON cp.call_id=cs.id AND cp.user_id=? WHERE cs.id=? LIMIT 1"); $q->execute([$uid,$callId]); if(!$q->fetch()) json_out(['ok'=>false,'error'=>'forbidden'],403);
    db()->prepare("UPDATE call_participants SET state='left',left_at=NOW() WHERE call_id=? AND user_id=?")->execute([$callId,$uid]);
    $q=db()->prepare("SELECT COUNT(*) FROM call_participants WHERE call_id=? AND state='joined'"); $q->execute([$callId]); if((int)$q->fetchColumn()===0) db()->prepare("UPDATE call_sessions SET status='ended',ended_at=NOW() WHERE id=?")->execute([$callId]);
    json_out(['ok'=>true]);
}

if ($action === 'call_end') {
    ensure_call_tables();
    $callId=(int)($in['call_id']??0);
    $q=db()->prepare("SELECT cs.conversation_id FROM call_sessions cs JOIN call_participants cp ON cp.call_id=cs.id AND cp.user_id=? WHERE cs.id=? LIMIT 1"); $q->execute([$uid,$callId]); if(!$q->fetch()) json_out(['ok'=>false,'error'=>'forbidden'],403);
    db()->prepare("UPDATE call_sessions SET status='ended',ended_at=NOW() WHERE id=?")->execute([$callId]);
    db()->prepare("UPDATE call_participants SET state='left',left_at=COALESCE(left_at,NOW()) WHERE call_id=? AND state='joined'")->execute([$callId]);
    json_out(['ok'=>true]);
}

if ($action === 'me') {
    $u = auth_user();
    json_out(['ok' => true, 'user' => user_json($u)]);
}

if ($action === 'logout') {
    $t = trim((string)($_SERVER['HTTP_AUTHORIZATION'] ?? ''));
    $t = preg_replace('/^Bearer\s+/i', '', $t);
    if ($t) db()->prepare('DELETE FROM auth_sessions WHERE token_hash = ?')->execute([hash('sha256', $t)]);
    json_out(['ok' => true]);
}

// --- Public group/channel preview (works before membership/auth) ---
if ($action === 'public_conversation') {
    $slug = strtolower(trim((string)($in['slug'] ?? '')));
    if (!preg_match('/^[a-z0-9_]{3,32}$/', $slug)) json_out(['ok'=>false,'error'=>'invalid_slug'],422);
    $st = db()->prepare("SELECT c.id,c.type,c.title,c.slug,c.description,c.avatar_path,c.is_public,c.created_by FROM conversations c WHERE c.slug=? AND c.type IN ('group','channel') LIMIT 1");
    $st->execute([$slug]); $c=$st->fetch();
    if (!$c || !(int)$c['is_public']) json_out(['ok'=>false,'error'=>'not_found'],404);
    $mc=db()->prepare('SELECT COUNT(*) FROM conversation_members WHERE conversation_id=?'); $mc->execute([(int)$c['id']]);
    $mm=db()->prepare("SELECT m.id,m.body,m.msg_type,m.file_path,m.file_mime,m.file_name,m.file_size,m.created_at,m.sender_id,u.first_name,u.last_name,u.deleted_at FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? AND m.deleted_at IS NULL ORDER BY m.id ASC LIMIT 200"); $mm->execute([(int)$c['id']]);
    $msgs=[]; foreach($mm as $m){ $msgs[]=['id'=>(int)$m['id'],'body'=>decrypt_message_body((string)$m['body']),'msg_type'=>$m['msg_type']??'text','file_path'=>absolute_url($m['file_path']??null),'file_mime'=>$m['file_mime']??null,'file_name'=>$m['file_name']??null,'file_size'=>$m['file_size']!==null?(int)$m['file_size']:null,'created_at'=>$m['created_at'],'sender_id'=>(int)$m['sender_id'],'first_name'=>!empty($m['deleted_at'])?'این اکانت حذف شده':$m['first_name'],'last_name'=>!empty($m['deleted_at'])?'':$m['last_name'],'deleted_account'=>!empty($m['deleted_at'])]; }
    json_out(['ok'=>true,'conversation'=>['conversation_id'=>(int)$c['id'],'type'=>$c['type'],'title'=>$c['title'],'slug'=>$c['slug'],'description'=>$c['description'],'is_public'=>true,'avatar_path'=>absolute_url($c['avatar_path']??null),'member_count'=>(int)$mc->fetchColumn(),'link'=>rtrim(APP_BASE_URL,'/').'/mouj-messenger.html#c/'.$c['slug']], 'messages'=>$msgs]);
}

$u = auth_user();
$uid = (int)$u['id'];

// Create call tables automatically on first use (migration file is also provided).
function ensure_call_tables(): void {
    static $done = false; if ($done) return;
    $pdo = db();
    $pdo->exec("CREATE TABLE IF NOT EXISTS call_sessions (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, conversation_id BIGINT NOT NULL, created_by INT NOT NULL,
      status ENUM('ringing','active','ended') NOT NULL DEFAULT 'ringing', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME DEFAULT NULL, ended_at DATETIME DEFAULT NULL,
      INDEX idx_call_conv_status(conversation_id,status), INDEX idx_call_created(created_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS call_participants (
      call_id BIGINT NOT NULL, user_id INT NOT NULL, state ENUM('invited','joined','left') NOT NULL DEFAULT 'invited',
      joined_at DATETIME DEFAULT NULL, left_at DATETIME DEFAULT NULL, PRIMARY KEY(call_id,user_id), INDEX idx_call_participant_user(user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS call_signals (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, call_id BIGINT NOT NULL, from_user_id INT NOT NULL, to_user_id INT NOT NULL,
      signal_type VARCHAR(20) NOT NULL, payload LONGTEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_signal_recipient(to_user_id,call_id,id), INDEX idx_signal_call(call_id,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    // Repair tables that may have been partially created by an older migration.
    $cols = function(string $table) use ($pdo): array {
        $q = $pdo->query("SHOW COLUMNS FROM `$table`");
        return array_fill_keys($q->fetchAll(PDO::FETCH_COLUMN), true);
    };
    // Normalize legacy status columns from older call migrations.
    try { $pdo->exec("ALTER TABLE call_sessions MODIFY status VARCHAR(16) NOT NULL DEFAULT 'ringing'"); } catch (Throwable $e) {}
    $c = $cols('call_sessions');
    if (!isset($c['conversation_id'])) $pdo->exec("ALTER TABLE call_sessions ADD conversation_id BIGINT NOT NULL");
    if (!isset($c['created_by'])) $pdo->exec("ALTER TABLE call_sessions ADD created_by INT NOT NULL");
    if (!isset($c['status'])) $pdo->exec("ALTER TABLE call_sessions ADD status VARCHAR(16) NOT NULL DEFAULT 'ringing'");
    if (!isset($c['created_at'])) $pdo->exec("ALTER TABLE call_sessions ADD created_at DATETIME DEFAULT CURRENT_TIMESTAMP");
    if (!isset($c['started_at'])) $pdo->exec("ALTER TABLE call_sessions ADD started_at DATETIME DEFAULT NULL");
    if (!isset($c['ended_at'])) $pdo->exec("ALTER TABLE call_sessions ADD ended_at DATETIME DEFAULT NULL");
    $c = $cols('call_participants');
    if (!isset($c['state'])) $pdo->exec("ALTER TABLE call_participants ADD state VARCHAR(16) NOT NULL DEFAULT 'invited'");
    if (!isset($c['joined_at'])) $pdo->exec("ALTER TABLE call_participants ADD joined_at DATETIME DEFAULT NULL");
    if (!isset($c['left_at'])) $pdo->exec("ALTER TABLE call_participants ADD left_at DATETIME DEFAULT NULL");
    $c = $cols('call_signals');
    if (!isset($c['signal_type'])) $pdo->exec("ALTER TABLE call_signals ADD signal_type VARCHAR(20) NOT NULL");
    if (!isset($c['payload'])) $pdo->exec("ALTER TABLE call_signals ADD payload LONGTEXT NOT NULL");
    if (!isset($c['created_at'])) $pdo->exec("ALTER TABLE call_signals ADD created_at DATETIME DEFAULT CURRENT_TIMESTAMP");
    $done = true;
}
if (strpos($action, 'call_') === 0) {
    try { ensure_call_tables(); } catch (Throwable $e) { json_out(['ok'=>false,'error'=>'call_database_setup_failed'],500); }
}

// --- match phone book contacts against registered users ---
if ($action === 'match_contacts') {
    $phones = $in['phones'] ?? [];
    if (!is_array($phones)) $phones = [];
    $normed = [];
    foreach ($phones as $p) {
        $n = norm_phone((string)$p);
        if (preg_match('/^09\d{9}$/', $n)) $normed[$n] = true;
    }
    $normed = array_keys($normed);
    if (!$normed) json_out(['ok' => true, 'matched' => [], 'unmatched' => []]);

    $placeholders = implode(',', array_fill(0, count($normed), '?'));
    $st = db()->prepare("SELECT id, phone, username, first_name, last_name, avatar_path, last_seen FROM users WHERE phone IN ($placeholders) AND id <> ?");
    $st->execute([...$normed, $uid]);
    $matched = [];
    $foundPhones = [];
    foreach ($st->fetchAll() as $row) {
        $matched[] = user_json($row);
        $foundPhones[$row['phone']] = true;
    }
    $unmatched = array_values(array_filter($normed, fn($p) => empty($foundPhones[$p])));
    json_out(['ok' => true, 'matched' => $matched, 'unmatched' => $unmatched]);
}

// --- search users (by username / name) — phone hidden for privacy ---

if ($action === 'user_by_username') {
    $username = strtolower(trim((string)($in['username'] ?? '')));
    $username = ltrim($username, '@');
    if (!preg_match('/^[a-z0-9_]{3,32}$/', $username)) json_out(['ok' => false, 'error' => 'invalid_username'], 422);
    $st = db()->prepare('SELECT id, phone, username, first_name, last_name, avatar_path, last_seen, created_at FROM users WHERE username = ? LIMIT 1');
    $st->execute([$username]);
    $row = $st->fetch();
    if (!$row) json_out(['ok' => false, 'error' => 'user_not_found'], 404);
    json_out(['ok' => true, 'user' => user_json($row, true)]);
}

if ($action === 'search_users') {
    $q = trim((string)($in['q'] ?? ''));
    if (mb_strlen($q) < 2) json_out(['ok' => true, 'users' => []]);
    $like = '%' . $q . '%';
    // اگر با 09 شروع شد → جستجوی شماره (فقط برای صاحب شماره یا مخاطب)
    if (preg_match('/^09\d{0,9}$/', preg_replace('/\D/', '', $q)) || preg_match('/^\+?98/', $q)) {
        $phone = norm_phone($q);
        $st = db()->prepare('SELECT id, phone, username, first_name, last_name, avatar_path, last_seen FROM users WHERE phone = ? AND id <> ? LIMIT 5');
        $st->execute([$phone, $uid]);
        $rows = array_map(fn($r) => user_json($r, false), $st->fetchAll());
        json_out(['ok' => true, 'users' => $rows]);
    }
    // جستجو با نام یا یوزرنیم — شماره مخفی
    $st = db()->prepare("SELECT id, username, first_name, last_name, avatar_path, last_seen FROM users WHERE id <> ? AND (username LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR CONCAT(first_name,' ',IFNULL(last_name,'')) LIKE ?) ORDER BY username LIMIT 30");
    $st->execute([$uid, $like, $like, $like, $like]);
    $rows = array_map(fn($r) => user_json($r, true), $st->fetchAll());
    json_out(['ok' => true, 'users' => $rows]);
}

if ($action === 'contacts') {
    $q = trim((string)($in['q'] ?? ''));
    $like = '%' . $q . '%';
    $st = db()->prepare("SELECT u.id,u.phone,u.username,u.first_name,u.last_name,u.avatar_path,u.deleted_at,u.last_seen FROM contacts ct JOIN users u ON u.id=ct.contact_user_id WHERE ct.user_id=? AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.username LIKE ? OR u.phone LIKE ?) ORDER BY u.first_name,u.last_name LIMIT 100");
    $st->execute([$uid,$like,$like,$like,$like]);
    $rows = array_map(fn($r) => user_json($r), $st->fetchAll());
    json_out(['ok'=>true,'contacts'=>$rows]);
}

if ($action === 'add_contact') {
    $phone = norm_phone((string)($in['phone'] ?? ''));
    if (!preg_match('/^09\d{9}$/',$phone)) json_out(['ok'=>false,'error'=>'invalid_phone'],422);
    $st=db()->prepare('SELECT id,phone,username,first_name,last_name,avatar_path,last_seen FROM users WHERE phone=? AND id<>? LIMIT 1');
    $st->execute([$phone,$uid]); $target=$st->fetch();
    if (!$target) json_out(['ok'=>false,'error'=>'user_not_found'],404);
    db()->prepare('INSERT IGNORE INTO contacts(user_id,contact_user_id) VALUES(?,?)')->execute([$uid,(int)$target['id']]);
    json_out(['ok'=>true,'contact'=>user_json($target)]);
}

if ($action === 'user_profile') {
    $id = (int)($in['user_id'] ?? 0);
    if ($id < 1) json_out(['ok' => false, 'error' => 'invalid_user'], 422);
    $st = db()->prepare('SELECT id, phone, username, first_name, last_name, avatar_path, last_seen, created_at FROM users WHERE id = ?');
    $st->execute([$id]);
    $row = $st->fetch();
    if (!$row) json_out(['ok' => false, 'error' => 'user_not_found'], 404);
    // شماره فقط اگر خود کاربر باشه یا در مخاطبین باشه نمایش داده می‌شه — فعلاً ساده: همیشه برای پروفایل کامل
    json_out(['ok' => true, 'user' => user_json($row, false)]);
}



if ($action === 'peek_user') {
    $other = (int)($in['user_id'] ?? 0);
    if ($other < 1 || $other === $uid) json_out(['ok'=>false,'error'=>'invalid_user'],422);
    $uq = db()->prepare('SELECT id, phone, username, first_name, last_name, avatar_path, last_seen, deleted_at FROM users WHERE id=? LIMIT 1');
    $uq->execute([$other]);
    $ou = $uq->fetch();
    if (!$ou) json_out(['ok'=>false,'error'=>'user_not_found'],404);

    // Find the private conversation without changing read state.
    $cq = db()->prepare("SELECT c.id FROM conversations c
        JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=?
        JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=?
        WHERE c.type='private' LIMIT 1");
    $cq->execute([$uid,$other]);
    $conv = $cq->fetch();
    $messages = [];
    if ($conv) {
        $mq = db()->prepare("SELECT m.id,m.body,m.msg_type,m.file_path,m.file_mime,m.file_name,m.file_size,m.created_at,m.sender_id
            FROM messages m WHERE m.conversation_id=? AND m.deleted_at IS NULL
            ORDER BY m.id DESC LIMIT 20");
        $mq->execute([(int)$conv['id']]);
        $tmp = $mq->fetchAll();
        $tmp = array_reverse($tmp);
        foreach ($tmp as $m) {
            $messages[] = [
                'id'=>(int)$m['id'],
                'body'=>decrypt_message_body((string)($m['body']??'')),
                'msg_type'=>$m['msg_type']??'text',
                'file_path'=>absolute_url($m['file_path']??null),
                'file_mime'=>$m['file_mime']??null,
                'file_name'=>$m['file_name']??null,
                'file_size'=>$m['file_size']!==null?(int)$m['file_size']:null,
                'created_at'=>$m['created_at'],
                'sender_id'=>(int)$m['sender_id']
            ];
        }
    }
    json_out(['ok'=>true,'user'=>user_json($ou,false),'conversation_id'=>$conv?(int)$conv['id']:null,'messages'=>$messages]);
}

if ($action === 'chats') {
    $q = trim((string)($in['q'] ?? ''));
    $st = db()->prepare("
        SELECT c.id, c.updated_at, c.type, c.title, c.slug, c.avatar_path, c.description, c.is_public,
               cm.role, cm.pinned_at,
               (SELECT COUNT(*) FROM conversation_members zcm WHERE zcm.conversation_id = c.id) AS member_count,
               (SELECT COUNT(*) FROM messages um
                WHERE um.conversation_id = c.id AND um.id > COALESCE(cm.last_read_message_id, 0)
                  AND um.sender_id <> ? AND um.deleted_at IS NULL) AS unread_count,
               m.id message_id, m.body, m.created_at, m.sender_id,
               x.id other_id, x.phone other_phone, x.username other_username,
               x.first_name other_first, x.last_name other_last,
               x.avatar_path other_avatar, x.last_seen other_last_seen
        FROM conversations c
        JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
        LEFT JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id <> ? AND c.type = 'private'
        LEFT JOIN users x ON x.id = cm2.user_id
        LEFT JOIN messages m ON m.id = (
            SELECT MAX(m2.id) FROM messages m2
            WHERE m2.conversation_id = c.id AND m2.deleted_at IS NULL
        )
        ORDER BY CASE WHEN c.type = 'saved' THEN 0 ELSE 1 END, (cm.pinned_at IS NULL) ASC, cm.pinned_at DESC, c.updated_at DESC
    ");
    $st->execute([$uid, $uid, $uid]);
    $rows = [];
    foreach ($st as $r) {
        $item = [
            'conversation_id' => (int)$r['id'],
            'type' => $r['type'],
            'title' => $r['title'],
            'slug' => $r['slug'],
            'description' => $r['description'],
            'is_public' => (bool)$r['is_public'],
            'avatar_path' => absolute_url($r['avatar_path'] ?? null),
            'member_count' => isset($r['member_count']) ? (int)$r['member_count'] : null,
            'unread_count' => isset($r['unread_count']) ? (int)$r['unread_count'] : 0,
            'role' => $r['role'],
            'pinned' => !empty($r['pinned_at']),
            'last_message' => $r['message_id'] ? [
                'id' => (int)$r['message_id'],
                'body' => decrypt_message_body((string)$r['body']),
                'created_at' => $r['created_at'],
                'sender_id' => (int)$r['sender_id'],
            ] : null,
        ];
        if ($r['type'] === 'private' && $r['other_id']) {
            $item['user'] = user_json([
                'id' => $r['other_id'],
                'phone' => $r['other_phone'],
                'username' => $r['other_username'],
                'first_name' => $r['other_first'],
                'last_name' => $r['other_last'],
                'avatar_path' => $r['other_avatar'],
                'last_seen' => $r['other_last_seen'],
            ]);
        }
        if ($q !== '') {
            $hay = mb_strtolower(
                ($item['user']['first_name'] ?? '') . ' ' .
                ($item['user']['last_name'] ?? '') . ' ' .
                ($item['user']['username'] ?? '') . ' ' .
                ($item['title'] ?? '') . ' ' .
                ($item['slug'] ?? '')
            );
            if (mb_strpos($hay, mb_strtolower($q)) === false) continue;
        }
        $rows[] = $item;
    }
    json_out(['ok' => true, 'chats' => $rows]);
}

if ($action === 'open_chat') {
    $other = (int)($in['user_id'] ?? 0);
    if ($other < 1 || $other === $uid) json_out(['ok' => false, 'error' => 'invalid_user'], 422);
    $q = db()->prepare('SELECT id, phone, username, first_name, last_name, avatar_path, last_seen FROM users WHERE id = ?');
    $q->execute([$other]);
    $ou = $q->fetch();
    if (!$ou) json_out(['ok' => false, 'error' => 'user_not_found'], 404);

    $pdo = db();
    $pdo->beginTransaction();
    $q = $pdo->prepare("
        SELECT c.id FROM conversations c
        JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
        JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
        WHERE c.type = 'private' LIMIT 1
    ");
    $q->execute([$uid, $other]);
    $c = $q->fetch();
    if (!$c) {
        $pdo->prepare("INSERT INTO conversations(type, updated_at) VALUES('private', NOW())")->execute();
        $cid = (int)$pdo->lastInsertId();
        $pdo->prepare('INSERT INTO conversation_members(conversation_id, user_id) VALUES(?, ?), (?, ?)')
            ->execute([$cid, $uid, $cid, $other]);
    } else {
        $cid = (int)$c['id'];
    }
    $pdo->commit();
    json_out(['ok' => true, 'conversation_id' => $cid, 'user' => user_json($ou)]);
}


if ($action === 'create_group' || $action === 'create_channel') {
    $title = trim((string)($in['title'] ?? ''));
    $slug = strtolower(trim((string)($in['slug'] ?? '')));
    $description = trim((string)($in['description'] ?? ''));
    $isPublic = !empty($in['is_public']) ? 1 : 0;
    $memberIds = $in['member_ids'] ?? [];
    if ($title === '' || mb_strlen($title) > 120) json_out(['ok' => false, 'error' => 'invalid_title'], 422);
    if ($slug === '' || !preg_match('/^[a-z0-9_]{3,32}$/', $slug)) json_out(['ok' => false, 'error' => 'invalid_slug'], 422);
    if (mb_strlen($description) > 500) json_out(['ok' => false, 'error' => 'invalid_description'], 422);
    if (!is_array($memberIds)) $memberIds = [];
    $memberIds = array_unique(array_filter(array_map('intval', $memberIds), fn($id) => $id > 0 && $id !== $uid));

    $type = $action === 'create_channel' ? 'channel' : 'group';

    // slug unique
    $q = db()->prepare('SELECT id FROM conversations WHERE slug = ? LIMIT 1');
    $q->execute([$slug]);
    if ($q->fetch()) json_out(['ok' => false, 'error' => 'slug_taken'], 422);

    $avatar = null;
    if (isset($_FILES['avatar']) && $_FILES['avatar']['error'] === UPLOAD_ERR_OK) {
        if ($_FILES['avatar']['size'] > 3 * 1024 * 1024) json_out(['ok' => false, 'error' => 'avatar_too_large'], 422);
        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($_FILES['avatar']['tmp_name']);
        $allowed = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
        if (!isset($allowed[$mime])) json_out(['ok' => false, 'error' => 'invalid_avatar'], 422);
        if (!is_dir(__DIR__ . '/uploads')) mkdir(__DIR__ . '/uploads', 0755, true);
        $name = bin2hex(random_bytes(12)) . '.' . $allowed[$mime];
        if (!move_uploaded_file($_FILES['avatar']['tmp_name'], __DIR__ . '/uploads/' . $name)) {
            json_out(['ok' => false, 'error' => 'avatar_upload_failed'], 500);
        }
        $avatar = 'uploads/' . $name;
    }

    $pdo = db();
    $pdo->beginTransaction();
    $pdo->prepare("INSERT INTO conversations(type, title, slug, avatar_path, description, is_public, created_by, updated_at) VALUES(?,?,?,?,?,?,?,NOW())")
        ->execute([$type, $title, $slug, $avatar, $description ?: null, $isPublic, $uid]);
    $cid = (int)$pdo->lastInsertId();
    // creator = owner
    $pdo->prepare("INSERT INTO conversation_members(conversation_id, user_id, role) VALUES(?, ?, 'owner')")->execute([$cid, $uid]);
    $ins = $pdo->prepare("INSERT INTO conversation_members(conversation_id, user_id, role) VALUES(?, ?, 'member')");
    foreach ($memberIds as $mid) {
        $ins->execute([$cid, $mid]);
    }
    $pdo->commit();
    json_out([
        'ok' => true,
        'conversation_id' => $cid,
        'title' => $title,
        'slug' => $slug,
        'type' => $type,
        'is_public' => (bool)$isPublic,
        'avatar_path' => absolute_url($avatar),
        'link' => rtrim(APP_BASE_URL, '/') . '/mouj-messenger.html#c/' . $slug,
    ]);
}

if ($action === 'edit_conversation') {
    $cid = (int)($in['conversation_id'] ?? 0);
    $title = trim((string)($in['title'] ?? ''));
    $description = trim((string)($in['description'] ?? ''));
    $isPublic = array_key_exists('is_public', $in) ? (!empty($in['is_public']) ? 1 : 0) : null;

    $q = db()->prepare('SELECT c.*, cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? WHERE c.id = ?');
    $q->execute([$uid, $cid]);
    $conv = $q->fetch();
    if (!$conv) json_out(['ok' => false, 'error' => 'not_found'], 404);
    $role = $conv['role'] ?: 'member';
    if ($role === 'member' && !empty($conv['created_by']) && (int)$conv['created_by'] === $uid) {
        $role = 'owner';
        try { db()->prepare("UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?")->execute([$cid, $uid]); } catch (Throwable $e) {}
    }
    if (!in_array($role, ['owner', 'admin'], true)) json_out(['ok' => false, 'error' => 'forbidden'], 403);
    if (!in_array($conv['type'], ['group', 'channel'], true)) json_out(['ok' => false, 'error' => 'invalid_type'], 422);

    if ($title === '' || mb_strlen($title) > 120) json_out(['ok' => false, 'error' => 'invalid_title'], 422);
    if (mb_strlen($description) > 500) json_out(['ok' => false, 'error' => 'invalid_description'], 422);

    $avatar = null;
    if (isset($_FILES['avatar']) && $_FILES['avatar']['error'] === UPLOAD_ERR_OK) {
        if ($_FILES['avatar']['size'] > 3 * 1024 * 1024) json_out(['ok' => false, 'error' => 'avatar_too_large'], 422);
        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($_FILES['avatar']['tmp_name']);
        $allowed = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
        if (!isset($allowed[$mime])) json_out(['ok' => false, 'error' => 'invalid_avatar'], 422);
        if (!is_dir(__DIR__ . '/uploads')) mkdir(__DIR__ . '/uploads', 0755, true);
        $name = bin2hex(random_bytes(12)) . '.' . $allowed[$mime];
        if (!move_uploaded_file($_FILES['avatar']['tmp_name'], __DIR__ . '/uploads/' . $name)) {
            json_out(['ok' => false, 'error' => 'avatar_upload_failed'], 500);
        }
        $avatar = 'uploads/' . $name;
    }

    $sets = ['title = ?', 'description = ?', 'updated_at = NOW()'];
    $args = [$title, $description ?: null];
    if ($isPublic !== null) {
        $sets[] = 'is_public = ?';
        $args[] = $isPublic;
    }
    if ($avatar) {
        $sets[] = 'avatar_path = ?';
        $args[] = $avatar;
    }
    $args[] = $cid;
    db()->prepare('UPDATE conversations SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);

    $q = db()->prepare('SELECT * FROM conversations WHERE id = ?');
    $q->execute([$cid]);
    $c = $q->fetch();
    json_out([
        'ok' => true,
        'conversation' => [
            'conversation_id' => (int)$c['id'],
            'type' => $c['type'],
            'title' => $c['title'],
            'slug' => $c['slug'],
            'description' => $c['description'],
            'is_public' => (bool)$c['is_public'],
            'avatar_path' => absolute_url($c['avatar_path'] ?? null),
            'link' => $c['slug'] ? (rtrim(APP_BASE_URL, '/') . '/mouj-messenger.html#c/' . $c['slug']) : null,
        ],
    ]);
}

if ($action === 'delete_conversation') {
    $cid = (int)($in['conversation_id'] ?? 0);
    if ($cid < 1) json_out(['ok' => false, 'error' => 'invalid_conversation'], 422);
    $q = db()->prepare('SELECT c.*, cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? WHERE c.id = ? LIMIT 1');
    $q->execute([$uid, $cid]);
    $conv = $q->fetch();
    if (!$conv) json_out(['ok' => false, 'error' => 'not_found'], 404);
    if (!in_array($conv['type'], ['group','channel'], true)) json_out(['ok' => false, 'error' => 'invalid_type'], 422);
    $role = $conv['role'] ?: 'member';
    if ($role === 'member' && !empty($conv['created_by']) && (int)$conv['created_by'] === $uid) $role = 'owner';
    if ($role !== 'owner' || (int)$conv['created_by'] !== $uid) json_out(['ok' => false, 'error' => 'only_creator_can_delete'], 403);
    $pdo = db();
    try {
        $pdo->beginTransaction();
        $pdo->prepare('DELETE FROM conversations WHERE id = ?')->execute([$cid]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        json_out(['ok' => false, 'error' => 'delete_failed'], 500);
    }
    json_out(['ok' => true, 'conversation_id' => $cid]);
}

if ($action === 'delete_account') {
    $pdo = db();
    try {
        $pdo->beginTransaction();
        // Soft delete: پیام‌ها و عضویت‌های قبلی حفظ می‌شوند تا «این اکانت حذف شده» برای دیگران نمایش داده شود.
        $pdo->prepare("UPDATE users SET deleted_at = NOW(), first_name = 'این اکانت حذف شده', last_name = NULL, username = CONCAT('deleted_', id) WHERE id = ?")->execute([$uid]);
        $pdo->prepare('DELETE FROM auth_sessions WHERE user_id = ?')->execute([$uid]);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        json_out(['ok' => false, 'error' => 'delete_account_failed'], 500);
    }
    json_out(['ok' => true]);
}

if ($action === 'add_members') {
    $cid = (int)($in['conversation_id'] ?? 0);
    $memberIds = $in['member_ids'] ?? [];
    if (!is_array($memberIds)) $memberIds = [$memberIds];
    $memberIds = array_values(array_unique(array_filter(array_map('intval', $memberIds), fn($id) => $id > 0 && $id !== $uid)));

    $q = db()->prepare('SELECT c.*, cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? WHERE c.id = ?');
    $q->execute([$uid, $cid]);
    $conv = $q->fetch();
    if (!$conv) json_out(['ok' => false, 'error' => 'not_found'], 404);
    if (!in_array($conv['type'], ['group', 'channel'], true)) json_out(['ok' => false, 'error' => 'invalid_type'], 422);

    $role = $conv['role'] ?: 'member';
    if ($role === 'member' && !empty($conv['created_by']) && (int)$conv['created_by'] === $uid) {
        $role = 'owner';
        try { db()->prepare("UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?")->execute([$cid, $uid]); } catch (Throwable $e) {}
    }
    if (!in_array($role, ['owner', 'admin'], true)) json_out(['ok' => false, 'error' => 'forbidden'], 403);
    if (!$memberIds) json_out(['ok' => false, 'error' => 'no_members'], 422);

    // فقط کاربرهای معتبر
    $in_ph = implode(',', array_fill(0, count($memberIds), '?'));
    $vq = db()->prepare("SELECT id FROM users WHERE id IN ($in_ph)");
    $vq->execute($memberIds);
    $validIds = array_map('intval', $vq->fetchAll(PDO::FETCH_COLUMN));

    $existQ = db()->prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?');
    $existQ->execute([$cid]);
    $existing = array_map('intval', $existQ->fetchAll(PDO::FETCH_COLUMN));
    $toAdd = array_diff($validIds, $existing);

    $ins = db()->prepare("INSERT INTO conversation_members(conversation_id, user_id, role) VALUES(?, ?, 'member')");
    $added = 0;
    foreach ($toAdd as $mid) {
        try { $ins->execute([$cid, $mid]); $added++; } catch (Throwable $e) {}
    }
    if ($added > 0) {
        db()->prepare('UPDATE conversations SET updated_at = NOW() WHERE id = ?')->execute([$cid]);
    }
    json_out(['ok' => true, 'added' => $added]);
}

if ($action === 'join_by_slug') {
    $slug = strtolower(trim((string)($in['slug'] ?? '')));
    if ($slug === '' || !preg_match('/^[a-z0-9_]{3,32}$/', $slug)) json_out(['ok' => false, 'error' => 'invalid_slug'], 422);

    $q = db()->prepare("SELECT * FROM conversations WHERE slug = ? AND type IN ('group','channel') LIMIT 1");
    $q->execute([$slug]);
    $c = $q->fetch();
    if (!$c) json_out(['ok' => false, 'error' => 'not_found'], 404);

    // private: only if already member or public
    $q = db()->prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?');
    $q->execute([$c['id'], $uid]);
    $mem = $q->fetch();
    if (!$mem) {
        if (!(int)$c['is_public']) json_out(['ok' => false, 'error' => 'private_channel'], 403);
        db()->prepare("INSERT INTO conversation_members(conversation_id, user_id, role) VALUES(?, ?, 'member')")->execute([(int)$c['id'], $uid]);
        $role = 'member';
    } else {
        $role = $mem['role'];
    }

    json_out([
        'ok' => true,
        'conversation_id' => (int)$c['id'],
        'type' => $c['type'],
        'title' => $c['title'],
        'slug' => $c['slug'],
        'description' => $c['description'],
        'is_public' => (bool)$c['is_public'],
        'avatar_path' => absolute_url($c['avatar_path'] ?? null),
        'role' => $role,
        'link' => rtrim(APP_BASE_URL, '/') . '/mouj-messenger.html#c/' . $c['slug'],
    ]);
}

if ($action === 'search_public') {
    $qstr = trim((string)($in['q'] ?? ''));
    if (mb_strlen($qstr) < 2) json_out(['ok' => true, 'results' => []]);
    $like = '%' . $qstr . '%';
    $st = db()->prepare("
        SELECT c.id, c.type, c.title, c.slug, c.description, c.avatar_path, c.is_public
        FROM conversations c
        WHERE c.type IN ('group','channel') AND c.is_public = 1
          AND (c.slug LIKE ? OR c.title LIKE ?)
        ORDER BY c.title ASC
        LIMIT 30
    ");
    $st->execute([$like, $like]);
    $out = [];
    foreach ($st as $r) {
        $out[] = [
            'conversation_id' => (int)$r['id'],
            'type' => $r['type'],
            'title' => $r['title'],
            'slug' => $r['slug'],
            'description' => $r['description'],
            'avatar_path' => absolute_url($r['avatar_path'] ?? null),
            'member_count' => null,
            'is_public' => true,
        ];
    }
    json_out(['ok' => true, 'results' => $out]);
}

if ($action === 'saved_messages') {
    // get or create personal saved messages
    $q = db()->prepare("SELECT c.id FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? WHERE c.type = 'saved' LIMIT 1");
    $q->execute([$uid]);
    $row = $q->fetch();
    if ($row) {
        $cid = (int)$row['id'];
    } else {
        $pdo = db();
        $pdo->beginTransaction();
        $pdo->prepare("INSERT INTO conversations(type, title, created_by, updated_at) VALUES('saved', 'پیام‌های ذخیره‌شده', ?, NOW())")->execute([$uid]);
        $cid = (int)$pdo->lastInsertId();
        $pdo->prepare("INSERT INTO conversation_members(conversation_id, user_id, role) VALUES(?, ?, 'owner')")->execute([$cid, $uid]);
        $pdo->commit();
    }
    json_out(['ok' => true, 'conversation_id' => $cid, 'title' => 'پیام‌های ذخیره‌شده', 'type' => 'saved']);
}

if ($action === 'conversation_info') {
    $cid = (int)($in['conversation_id'] ?? 0);
    $q = db()->prepare('SELECT c.*, cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? WHERE c.id = ?');
    $q->execute([$uid, $cid]);
    $c = $q->fetch();
    if (!$c) json_out(['ok' => false, 'error' => 'not_found'], 404);

    $role = $c['role'] ?: 'member';
    // اگر سازنده گروه/کانال است ولی role هنوز member است، ارتقا به owner
    if ($role === 'member' && !empty($c['created_by']) && (int)$c['created_by'] === $uid && in_array($c['type'], ['group', 'channel'], true)) {
        try {
            db()->prepare("UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?")->execute([$cid, $uid]);
            $role = 'owner';
        } catch (Throwable $e) {}
    }
    $isStaff = in_array($role, ['owner', 'admin'], true);
    $memberCount = 1; try { $mq=db()->prepare('SELECT COUNT(*) FROM conversation_members WHERE conversation_id=?'); $mq->execute([$cid]); $memberCount=(int)$mq->fetchColumn(); } catch(Throwable $e) {}
    $deletedAccount = false;
    if ($c['type'] === 'private') {
        try {
            $dq = db()->prepare('SELECT u.deleted_at FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=? AND cm.user_id<>? LIMIT 1');
            $dq->execute([$cid, $uid]);
            $du = $dq->fetchColumn();
            $deletedAccount = !empty($du);
        } catch (Throwable $e) {}
    }
    json_out([
        'ok' => true,
        'conversation' => [
            'conversation_id' => (int)$c['id'],
            'type' => $c['type'],
            'title' => $c['title'],
            'slug' => $c['slug'],
            'description' => $c['description'],
            'is_public' => (bool)($c['is_public'] ?? 0),
            'member_count' => $memberCount,
            'avatar_path' => absolute_url($c['avatar_path'] ?? null),
            'role' => $role,
            'link' => !empty($c['slug']) ? (rtrim(APP_BASE_URL, '/') . '/mouj-messenger.html#c/' . $c['slug']) : null,
            'can_post' => ($c['type'] !== 'channel') || $isStaff,
            'can_edit' => $isStaff && in_array($c['type'], ['group', 'channel'], true),
            'deleted_account' => $deletedAccount,
        ],
    ]);
}



if ($action === 'messages') {
    $cid = (int)($in['conversation_id'] ?? 0);
    $after = (int)($in['after_id'] ?? 0);
    $q = db()->prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?');
    $q->execute([$cid, $uid]);
    if (!$q->fetch()) json_out(['ok' => false, 'error' => 'forbidden'], 403);

    // سازگاری با دیتابیس بدون ستون‌های media
    $hasMediaCols = true;
    try {
        db()->query('SELECT msg_type, file_path FROM messages LIMIT 0');
    } catch (Throwable $e) {
        $hasMediaCols = false;
    }

    if ($hasMediaCols) {
        $sql = 'SELECT m.id, m.body, m.msg_type, m.file_path, m.file_mime, m.file_name, m.file_size,
                       m.created_at, m.edited_at, m.sender_id, m.reply_to_id, u.first_name, u.last_name
                FROM messages m JOIN users u ON u.id = m.sender_id
                WHERE m.conversation_id = ? AND m.deleted_at IS NULL AND m.id > ?
                ORDER BY m.id ASC LIMIT 200';
    } else {
        $sql = 'SELECT m.id, m.body, m.created_at, m.sender_id, u.first_name, u.last_name
                FROM messages m JOIN users u ON u.id = m.sender_id
                WHERE m.conversation_id = ? AND m.deleted_at IS NULL AND m.id > ?
                ORDER BY m.id ASC LIMIT 200';
    }
    $q = db()->prepare($sql);
    $q->execute([$cid, $after]);
    $rows = $q->fetchAll();

    $otherRead = 0;
    try {
        $q2 = db()->prepare('SELECT MAX(last_read_message_id) AS mx FROM conversation_members WHERE conversation_id = ? AND user_id <> ?');
        $q2->execute([$cid, $uid]);
        $or = $q2->fetch();
        $otherRead = $or && $or['mx'] !== null ? (int)$or['mx'] : 0;
    } catch (Throwable $e) {}

    $out = [];
    foreach ($rows as $r) {
        $item = [
            'id' => (int)$r['id'],
            'body' => decrypt_message_body((string)$r['body']),
            'msg_type' => $hasMediaCols ? ($r['msg_type'] ?: 'text') : 'text',
            'file_path' => $hasMediaCols ? absolute_url($r['file_path'] ?? null) : null,
            'file_mime' => $hasMediaCols ? ($r['file_mime'] ?? null) : null,
            'file_name' => $hasMediaCols ? ($r['file_name'] ?? null) : null,
            'file_size' => ($hasMediaCols && $r['file_size'] !== null) ? (int)$r['file_size'] : null,
            'created_at' => $r['created_at'],
            'edited_at' => $r['edited_at'] ?? null,
            'sender_id' => (int)$r['sender_id'],
            'reply_to_id' => isset($r['reply_to_id']) && $r['reply_to_id'] ? (int)$r['reply_to_id'] : null,
            'first_name' => $r['first_name'],
            'last_name' => $r['last_name'],
        ];
        if ((int)$r['sender_id'] === $uid) {
            $item['status'] = ((int)$r['id'] <= $otherRead) ? 'seen' : 'sent';
        }
        $out[] = $item;
    }

    try {
        db()->prepare('UPDATE conversation_members SET last_read_message_id = (SELECT COALESCE(MAX(id), 0) FROM messages WHERE conversation_id = ?) WHERE conversation_id = ? AND user_id = ?')
            ->execute([$cid, $cid, $uid]);
    } catch (Throwable $e) {}

    $typing = [];
    try {
        $tq = db()->prepare('SELECT t.user_id, u.first_name FROM typing_status t JOIN users u ON u.id = t.user_id WHERE t.conversation_id = ? AND t.user_id <> ? AND t.updated_at > DATE_SUB(NOW(), INTERVAL 5 SECOND)');
        $tq->execute([$cid, $uid]);
        foreach ($tq as $tr) {
            $typing[] = ['user_id' => (int)$tr['user_id'], 'first_name' => $tr['first_name']];
        }
    } catch (Throwable $e) {}

    json_out(['ok' => true, 'messages' => $out, 'typing' => $typing]);
}


if ($action === 'send_message') {
    $cid = (int)($in['conversation_id'] ?? 0);
    $body = trim((string)($in['body'] ?? ''));
    $msgType = trim((string)($in['msg_type'] ?? 'text'));
    $replyTo = (int)($in['reply_to_id'] ?? 0) ?: null;
    if (!in_array($msgType, ['text', 'image', 'video', 'voice', 'video_message', 'file', 'sticker'], true)) $msgType = 'text';
    if ($cid < 1) json_out(['ok' => false, 'error' => 'invalid_input'], 422);

    // بلاک دوطرفه در چت خصوصی
    try {
        $bq = db()->prepare("SELECT c.type FROM conversations c WHERE c.id = ?");
        $bq->execute([$cid]);
        $bc = $bq->fetch();
        if ($bc && $bc['type'] === 'private') {
            $oq = db()->prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ? LIMIT 1');
            $oq->execute([$cid, $uid]);
            $other = $oq->fetch();
            if ($other) {
                $bl = db()->prepare('SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1');
                $bl->execute([$uid, $other['user_id'], $other['user_id'], $uid]);
                if ($bl->fetch()) json_out(['ok' => false, 'error' => 'blocked'], 403);
            }
        }
    } catch (Throwable $e) {}

    $q = db()->prepare('SELECT cm.role, c.type FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.conversation_id = ? AND cm.user_id = ?');
    $q->execute([$cid, $uid]);
    $mem = $q->fetch();
    if (!$mem) json_out(['ok' => false, 'error' => 'forbidden'], 403);
    if ($mem['type'] === 'channel' && !in_array($mem['role'], ['owner', 'admin'], true)) {
        json_out(['ok' => false, 'error' => 'only_admin_can_post'], 403);
    }

    $hasMediaCols = true;
    try {
        db()->query('SELECT msg_type, file_path FROM messages LIMIT 0');
    } catch (Throwable $e) {
        $hasMediaCols = false;
    }

    $filePath = null;
    $fileMime = null;
    $fileName = null;
    $fileSize = null;

    if (isset($_FILES['file']) && is_array($_FILES['file'])) {
        $err = (int)($_FILES['file']['error'] ?? UPLOAD_ERR_NO_FILE);
        if ($err !== UPLOAD_ERR_OK) {
            $map = [
                UPLOAD_ERR_INI_SIZE => 'file_too_large',
                UPLOAD_ERR_FORM_SIZE => 'file_too_large',
                UPLOAD_ERR_PARTIAL => 'upload_partial',
                UPLOAD_ERR_NO_FILE => 'no_file',
                UPLOAD_ERR_NO_TMP_DIR => 'server_upload_config',
                UPLOAD_ERR_CANT_WRITE => 'server_upload_config',
            ];
            json_out(['ok' => false, 'error' => $map[$err] ?? 'upload_failed', 'php_upload_error' => $err], 422);
        }
        if (!$hasMediaCols) {
            json_out(['ok' => false, 'error' => 'migration_required', 'hint' => 'migrate_v3.sql را اجرا کنید'], 500);
        }
        $f = $_FILES['file'];
        if ($f['size'] > 25 * 1024 * 1024) json_out(['ok' => false, 'error' => 'file_too_large'], 422);

        $mime = 'application/octet-stream';
        if (class_exists('finfo')) {
            $mime = (new finfo(FILEINFO_MIME_TYPE))->file($f['tmp_name']) ?: $mime;
        } elseif (function_exists('mime_content_type')) {
            $mime = mime_content_type($f['tmp_name']) ?: $mime;
        }
        // بعضی آیفون‌ها type را خالی یا اشتباه می‌فرستند
        $clientType = (string)($f['type'] ?? '');
        if ($mime === 'application/octet-stream' && $clientType) $mime = $clientType;

        $allowedImg = [
            'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'image/gif' => 'gif',
            'image/heic' => 'heic', 'image/heif' => 'heif', 'image/heic-sequence' => 'heic',
        ];
        $allowedVid = ['video/mp4' => 'mp4', 'video/webm' => 'webm', 'video/quicktime' => 'mov', 'video/3gpp' => '3gp'];
        $allowedFile = [
            'application/pdf' => 'pdf', 'application/zip' => 'zip', 'application/msword' => 'doc',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document' => 'docx',
            'audio/mpeg' => 'mp3', 'audio/ogg' => 'ogg', 'audio/webm' => 'webm', 'audio/mp4' => 'm4a', 'video/webm' => 'webm', 'text/plain' => 'txt',
            'application/octet-stream' => 'bin',
        ];
        $ext = null;
        if (isset($allowedImg[$mime]) || str_starts_with($mime, 'image/')) {
            $ext = $allowedImg[$mime] ?? 'jpg';
            if ($msgType === 'text' || $msgType === 'file') $msgType = 'image';
        } elseif (isset($allowedVid[$mime]) || str_starts_with($mime, 'video/')) {
            $ext = $allowedVid[$mime] ?? 'mp4';
            if ($msgType === 'text' || $msgType === 'file') $msgType = 'video';
            if ($msgType === 'video_message') $msgType = 'video_message';
        } elseif (str_starts_with($mime, 'audio/')) {
            $ext = $allowedFile[$mime] ?? 'webm';
            $msgType = ($msgType === 'voice') ? 'voice' : 'file';
        } elseif (isset($allowedFile[$mime])) {
            $ext = $allowedFile[$mime];
            if ($msgType === 'voice') $msgType = 'voice'; elseif ($msgType === 'text') $msgType = 'file';
        } elseif ($msgType === 'sticker' && str_starts_with($mime, 'image/')) {
            $ext = 'png';
        } else {
            // از روی پسوند فایل حدس بزن
            $orig = strtolower((string)($f['name'] ?? ''));
            if (preg_match('/\.(jpe?g|png|gif|webp|heic|heif)$/', $orig, $m)) {
                $ext = $m[1] === 'jpeg' ? 'jpg' : $m[1];
                $msgType = 'image';
            } elseif (preg_match('/\.(mp4|webm|mov|3gp)$/', $orig, $m)) {
                $ext = $m[1];
                $msgType = 'video';
            } else {
                json_out(['ok' => false, 'error' => 'invalid_file_type', 'mime' => $mime], 422);
            }
        }

        $uploadDir = __DIR__ . '/uploads';
        if (!is_dir($uploadDir)) {
            if (!@mkdir($uploadDir, 0755, true)) {
                json_out(['ok' => false, 'error' => 'upload_dir_failed'], 500);
            }
        }
        if (!is_writable($uploadDir)) {
            json_out(['ok' => false, 'error' => 'upload_dir_not_writable'], 500);
        }
        $name = bin2hex(random_bytes(12)) . '.' . $ext;
        if (!move_uploaded_file($f['tmp_name'], $uploadDir . '/' . $name)) {
            json_out(['ok' => false, 'error' => 'upload_failed'], 500);
        }
        $filePath = 'uploads/' . $name;
        $fileMime = $mime;
        $fileName = basename((string)($f['name'] ?? $name));
        $fileSize = (int)$f['size'];
        if ($body === '') {
            $body = $msgType === 'image' ? '📷 عکس' : ($msgType === 'video' ? '🎬 ویدیو' : ($msgType === 'voice' ? '🎤 ویس' : ($msgType === 'video_message' ? '🎥 پیام ویدیویی' : ($msgType === 'sticker' ? 'استیکر' : '📎 فایل'))));
        }
    } else {
        if ($body === '') json_out(['ok' => false, 'error' => 'invalid_input'], 422);
        if (mb_strlen($body) > 4000) json_out(['ok' => false, 'error' => 'message_too_long'], 422);
        // استیکرهای SVG داخلی بدون فایل آپلودی — فقط کلید در body
        if ($msgType !== 'sticker') {
            $msgType = 'text';
        }
    }

    // Encrypt the message body before storing it.
    // Previous build accidentally defined $bodyForDb inside open_chat,
    // so send_message could reach INSERT with an undefined variable and fail.
    $bodyForDb = encrypt_message_body($body);

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $hasReplyCol = true;
        try { db()->query('SELECT reply_to_id FROM messages LIMIT 0'); } catch (Throwable $e) { $hasReplyCol = false; }
        if ($hasMediaCols && $hasReplyCol) {
            $pdo->prepare('INSERT INTO messages(conversation_id, sender_id, body, msg_type, file_path, file_mime, file_name, file_size, reply_to_id) VALUES(?,?,?,?,?,?,?,?,?)')
                ->execute([$cid, $uid, $bodyForDb, $msgType, $filePath, $fileMime, $fileName, $fileSize, $replyTo]);
        } elseif ($hasMediaCols) {
            $pdo->prepare('INSERT INTO messages(conversation_id, sender_id, body, msg_type, file_path, file_mime, file_name, file_size) VALUES(?,?,?,?,?,?,?,?)')
                ->execute([$cid, $uid, $bodyForDb, $msgType, $filePath, $fileMime, $fileName, $fileSize]);
        } elseif ($hasReplyCol) {
            $pdo->prepare('INSERT INTO messages(conversation_id, sender_id, body, reply_to_id) VALUES(?,?,?,?)')
                ->execute([$cid, $uid, $bodyForDb, $replyTo]);
        } else {
            $pdo->prepare('INSERT INTO messages(conversation_id, sender_id, body) VALUES(?,?,?)')
                ->execute([$cid, $uid, $bodyForDb]);
        }
        $mid = (int)$pdo->lastInsertId();
        $pdo->prepare('UPDATE conversations SET updated_at = NOW() WHERE id = ?')->execute([$cid]);
        try {
            $pdo->prepare('DELETE FROM typing_status WHERE conversation_id = ? AND user_id = ?')->execute([$cid, $uid]);
        } catch (Throwable $e) {}
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        error_log('send_message: ' . $e->getMessage());
        json_out(['ok' => false, 'error' => 'server_error', 'detail' => $e->getMessage()], 500);
    }

    if ($hasMediaCols) {
        $q = $pdo->prepare('SELECT id, body, msg_type, file_path, file_mime, file_name, file_size, created_at, edited_at, sender_id FROM messages WHERE id = ?');
    } else {
        $q = $pdo->prepare('SELECT id, body, created_at, sender_id FROM messages WHERE id = ?');
    }
    $q->execute([$mid]);
    $msg = $q->fetch();
    if ($hasMediaCols) {
        $msg['file_path'] = absolute_url($msg['file_path'] ?? null);
    } else {
        $msg['msg_type'] = 'text';
        $msg['file_path'] = null;
    }
    $msg['status'] = 'sent';
    json_out(['ok' => true, 'message' => $msg]);
}

if ($action === 'typing') {
    $cid = (int)($in['conversation_id'] ?? 0);
    if ($cid < 1) json_out(['ok' => false, 'error' => 'invalid_input'], 422);
    $q = db()->prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?');
    $q->execute([$cid, $uid]);
    if (!$q->fetch()) json_out(['ok' => false, 'error' => 'forbidden'], 403);
    db()->prepare('INSERT INTO typing_status(conversation_id, user_id, updated_at) VALUES(?,?,NOW()) ON DUPLICATE KEY UPDATE updated_at = NOW()')
        ->execute([$cid, $uid]);
    json_out(['ok' => true]);
}


if ($action === 'my_sessions') {
    $t = trim((string)($_SERVER['HTTP_AUTHORIZATION'] ?? ''));
    if (stripos($t, 'Bearer ') === 0) $t = trim(substr($t, 7));
    $curHash = $t ? hash('sha256', $t) : '';

    $list = [];
    try {
        $st = db()->prepare('SELECT id, user_agent, device_label, ip, created_at, last_seen, token_hash FROM auth_sessions WHERE user_id = ? AND expires_at > NOW() ORDER BY last_seen DESC');
        $st->execute([$uid]);
        foreach ($st as $r) {
            $list[] = [
                'id' => (int)$r['id'],
                'device_label' => ($r['device_label'] ?: parse_device_label($r['user_agent'] ?? '')),
                'user_agent' => $r['user_agent'],
                'ip' => $r['ip'],
                'created_at' => $r['created_at'],
                'last_seen' => $r['last_seen'],
                'is_current' => ($r['token_hash'] === $curHash),
            ];
        }
    } catch (Throwable $e) {
        // ستون‌های user_agent/ip هنوز ساخته نشده‌اند — نسخه ساده
        try {
            $st = db()->prepare('SELECT id, created_at, last_seen, token_hash FROM auth_sessions WHERE user_id = ? AND expires_at > NOW() ORDER BY last_seen DESC');
            $st->execute([$uid]);
            foreach ($st as $r) {
                $list[] = [
                    'id' => (int)$r['id'],
                    'device_label' => ($r['token_hash'] === $curHash) ? 'همین دستگاه' : 'دستگاه دیگر',
                    'user_agent' => null,
                    'ip' => null,
                    'created_at' => $r['created_at'],
                    'last_seen' => $r['last_seen'],
                    'is_current' => ($r['token_hash'] === $curHash),
                ];
            }
        } catch (Throwable $e2) {
            error_log('my_sessions: ' . $e2->getMessage());
            json_out(['ok' => false, 'error' => 'server_error', 'detail' => $e2->getMessage()], 500);
        }
    }
    json_out(['ok' => true, 'sessions' => $list]);
}

if ($action === 'revoke_session') {
    $sid = (int)($in['session_id'] ?? 0);
    if ($sid < 1) json_out(['ok' => false, 'error' => 'invalid_input'], 422);
    $t = trim((string)($_SERVER['HTTP_AUTHORIZATION'] ?? ''));
    if (stripos($t, 'Bearer ') === 0) $t = trim(substr($t, 7));
    $curHash = $t ? hash('sha256', $t) : '';
    $q = db()->prepare('SELECT id, token_hash FROM auth_sessions WHERE id = ? AND user_id = ?');
    $q->execute([$sid, $uid]);
    $row = $q->fetch();
    if (!$row) json_out(['ok' => false, 'error' => 'not_found'], 404);
    if ($row['token_hash'] === $curHash) json_out(['ok' => false, 'error' => 'cannot_revoke_current'], 422);
    db()->prepare('DELETE FROM auth_sessions WHERE id = ?')->execute([$sid]);
    json_out(['ok' => true]);
}

if ($action === 'update_profile') {
    $first = trim((string)($in['first_name'] ?? ''));
    $last = trim((string)($in['last_name'] ?? ''));
    $username = strtolower(trim((string)($in['username'] ?? '')));

    if ($first === '' || !preg_match('/^[a-zA-Z0-9_]{3,32}$/', $username)) {
        json_out(['ok' => false, 'error' => 'invalid_input'], 422);
    }

    $q = db()->prepare('SELECT id FROM users WHERE username = ? AND id <> ?');
    $q->execute([$username, $uid]);
    if ($q->fetch()) json_out(['ok' => false, 'error' => 'username_taken'], 422);

    $avatar = null;
    if (isset($_FILES['avatar']) && $_FILES['avatar']['error'] === UPLOAD_ERR_OK) {
        if ($_FILES['avatar']['size'] > 3 * 1024 * 1024) {
            json_out(['ok' => false, 'error' => 'avatar_too_large'], 422);
        }
        $mime = (new finfo(FILEINFO_MIME_TYPE))->file($_FILES['avatar']['tmp_name']);
        $allowed = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
        if (!isset($allowed[$mime])) {
            json_out(['ok' => false, 'error' => 'invalid_avatar'], 422);
        }
        if (!is_dir(__DIR__ . '/uploads')) {
            mkdir(__DIR__ . '/uploads', 0755, true);
        }
        $name = bin2hex(random_bytes(12)) . '.' . $allowed[$mime];
        if (!move_uploaded_file($_FILES['avatar']['tmp_name'], __DIR__ . '/uploads/' . $name)) {
            json_out(['ok' => false, 'error' => 'avatar_upload_failed'], 500);
        }
        $avatar = 'uploads/' . $name;
    }

    if ($avatar) {
        db()->prepare('UPDATE users SET first_name = ?, last_name = ?, username = ?, avatar_path = ?, last_seen = NOW() WHERE id = ?')
            ->execute([$first, $last ?: null, $username, $avatar, $uid]);
    } else {
        db()->prepare('UPDATE users SET first_name = ?, last_name = ?, username = ?, last_seen = NOW() WHERE id = ?')
            ->execute([$first, $last ?: null, $username, $uid]);
    }

    $q = db()->prepare('SELECT id, phone, username, first_name, last_name, avatar_path, last_seen FROM users WHERE id = ?');
    $q->execute([$uid]);
    $user = $q->fetch();
    json_out(['ok' => true, 'user' => user_json($user)]);
}

if ($action === 'mark_read') {
    $cid = (int)($in['conversation_id'] ?? 0);
    $mid = (int)($in['message_id'] ?? 0);
    db()->prepare('UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?')
        ->execute([$mid, $cid, $uid]);
    json_out(['ok' => true]);
}


if ($action === 'edit_message') {
    $mid = (int)($in['message_id'] ?? 0);
    $body = trim((string)($in['body'] ?? ''));
    if ($mid < 1 || $body === '') json_out(['ok'=>false,'error'=>'invalid_input'],422);
    if (mb_strlen($body) > 4000) json_out(['ok'=>false,'error'=>'message_too_long'],422);

    $q = db()->prepare('SELECT id, conversation_id, sender_id, body, msg_type, deleted_at FROM messages WHERE id = ? LIMIT 1');
    $q->execute([$mid]);
    $m = $q->fetch();
    if (!$m) json_out(['ok'=>false,'error'=>'message_not_found'],404);
    if ((int)$m['sender_id'] !== $uid) json_out(['ok'=>false,'error'=>'forbidden'],403);
    if (!empty($m['deleted_at'])) json_out(['ok'=>false,'error'=>'message_deleted'],422);
    if (($m['msg_type'] ?? 'text') !== 'text') json_out(['ok'=>false,'error'=>'only_text_can_be_edited'],422);

    db()->prepare('UPDATE messages SET body = ?, edited_at = NOW() WHERE id = ? AND sender_id = ?')
       ->execute([encrypt_message_body($body), $mid, $uid]);
    $q = db()->prepare('SELECT id, conversation_id, sender_id, body, msg_type, created_at, edited_at FROM messages WHERE id = ?');
    $q->execute([$mid]);
    $out = $q->fetch();
    json_out(['ok'=>true,'message'=>array_merge($out ?: [], ['body'=>decrypt_message_body((string)($out['body'] ?? ''))])]);
}

if ($action === 'delete_message') {
    $mid = (int)($in['message_id'] ?? 0);
    $scope = (string)($in['scope'] ?? 'me'); // me | everyone
    if ($mid < 1) json_out(['ok' => false, 'error' => 'invalid_input'], 422);
    $q = db()->prepare('SELECT m.*, cm.user_id FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ? WHERE m.id = ?');
    $q->execute([$uid, $mid]);
    $m = $q->fetch();
    if (!$m) json_out(['ok' => false, 'error' => 'not_found'], 404);
    if ($scope === 'everyone') {
        if ((int)$m['sender_id'] !== $uid) json_out(['ok' => false, 'error' => 'forbidden'], 403);
        db()->prepare('UPDATE messages SET deleted_at = NOW(), body = ? WHERE id = ?')->execute(['این پیام حذف شد', $mid]);
    } else {
        // حذف برای خود: فعلاً همان soft delete فقط اگر فرستنده است؛ برای دیگران hide سمت کلاینت
        if ((int)$m['sender_id'] === $uid) {
            db()->prepare('UPDATE messages SET deleted_at = NOW(), body = ? WHERE id = ?')->execute(['این پیام حذف شد', $mid]);
        }
    }
    json_out(['ok' => true, 'message_id' => $mid, 'scope' => $scope]);
}

if ($action === 'pin_chat') {
    $cid = (int)($in['conversation_id'] ?? 0);
    $pin = !empty($in['pin']);
    $q = db()->prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?');
    $q->execute([$cid, $uid]);
    if (!$q->fetch()) json_out(['ok' => false, 'error' => 'forbidden'], 403);
    try {
        if ($pin) {
            db()->prepare('UPDATE conversation_members SET pinned_at = NOW() WHERE conversation_id = ? AND user_id = ?')->execute([$cid, $uid]);
        } else {
            db()->prepare('UPDATE conversation_members SET pinned_at = NULL WHERE conversation_id = ? AND user_id = ?')->execute([$cid, $uid]);
        }
    } catch (Throwable $e) {
        json_out(['ok' => false, 'error' => 'migration_required'], 500);
    }
    json_out(['ok' => true, 'pinned' => $pin]);
}

if ($action === 'block_user') {
    $tid = (int)($in['user_id'] ?? 0);
    if ($tid < 1 || $tid === $uid) json_out(['ok' => false, 'error' => 'invalid_input'], 422);
    try {
        db()->prepare('INSERT IGNORE INTO blocked_users(blocker_id, blocked_id) VALUES(?, ?)')->execute([$uid, $tid]);
    } catch (Throwable $e) {
        json_out(['ok' => false, 'error' => 'migration_required'], 500);
    }
    json_out(['ok' => true]);
}

if ($action === 'unblock_user') {
    $tid = (int)($in['user_id'] ?? 0);
    db()->prepare('DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?')->execute([$uid, $tid]);
    json_out(['ok' => true]);
}

if ($action === 'blocked_list') {
    try {
        $st = db()->prepare('SELECT u.id, u.username, u.first_name, u.last_name, u.avatar_path FROM blocked_users b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC');
        $st->execute([$uid]);
        $list = [];
        foreach ($st as $r) $list[] = user_json($r);
        json_out(['ok' => true, 'users' => $list]);
    } catch (Throwable $e) {
        json_out(['ok' => true, 'users' => []]);
    }
}

if ($action === 'save_push_subscription') {
    $endpoint = trim((string)($in['endpoint'] ?? ''));
    $p256dh = trim((string)($in['keys']['p256dh'] ?? $in['p256dh'] ?? ''));
    $auth = trim((string)($in['keys']['auth'] ?? $in['auth'] ?? ''));
    if ($endpoint === '' || $p256dh === '' || $auth === '') json_out(['ok' => false, 'error' => 'invalid_input'], 422);
    $ua = substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 500);
    try {
        db()->prepare('INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth, user_agent) VALUES(?,?,?,?,?)
            ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent)')
            ->execute([$uid, $endpoint, $p256dh, $auth, $ua ?: null]);
        json_out(['ok' => true]);
    } catch (Throwable $e) {
        json_out(['ok' => false, 'error' => 'migration_required', 'detail' => $e->getMessage()], 500);
    }
}

if ($action === 'search_in_chat') {
    $cid = (int)($in['conversation_id'] ?? 0);
    $qstr = trim((string)($in['q'] ?? ''));
    if ($cid < 1 || mb_strlen($qstr) < 1) json_out(['ok' => true, 'messages' => []]);
    $q = db()->prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?');
    $q->execute([$cid, $uid]);
    if (!$q->fetch()) json_out(['ok' => false, 'error' => 'forbidden'], 403);
    $st = db()->prepare('SELECT m.id, m.body, m.created_at, m.sender_id FROM messages m WHERE m.conversation_id = ? AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 500');
    $st->execute([$cid]);
    $out = [];
    foreach ($st as $r) {
        $plain = decrypt_message_body((string)$r['body']);
        if (mb_stripos($plain, $qstr) === false) continue;
        $out[] = ['id' => (int)$r['id'], 'body' => $plain, 'created_at' => $r['created_at'], 'sender_id' => (int)$r['sender_id']];
        if (count($out) >= 50) break;
    }
    json_out(['ok' => true, 'messages' => $out]);
}



if ($action === 'get_message') {
    $mid = (int)($in['message_id'] ?? 0);
    if ($mid < 1) json_out(['ok' => false, 'error' => 'invalid_input'], 422);
    $q = db()->prepare('SELECT m.*, c.type AS conv_type, c.title AS conv_title FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND m.deleted_at IS NULL');
    $q->execute([$mid]);
    $m = $q->fetch();
    if (!$m) json_out(['ok' => false, 'error' => 'not_found'], 404);
    $q = db()->prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?');
    $q->execute([(int)$m['conversation_id'], $uid]);
    if (!$q->fetch()) json_out(['ok' => false, 'error' => 'forbidden'], 403);
    $uq = db()->prepare('SELECT first_name, last_name, username FROM users WHERE id = ?');
    $uq->execute([(int)$m['sender_id']]);
    $sender = $uq->fetch() ?: [];
    json_out([
        'ok' => true,
        'message' => [
            'id' => (int)$m['id'],
            'conversation_id' => (int)$m['conversation_id'],
            'body' => decrypt_message_body((string)$m['body']),
            'msg_type' => $m['msg_type'] ?? 'text',
            'file_path' => absolute_url($m['file_path'] ?? null),
            'file_name' => $m['file_name'] ?? null,
            'created_at' => $m['created_at'],
            'sender_id' => (int)$m['sender_id'],
            'sender_name' => trim(($sender['first_name'] ?? '') . ' ' . ($sender['last_name'] ?? '')),
            'sender_username' => $sender['username'] ?? null,
        ],
        'conversation' => [
            'id' => (int)$m['conversation_id'],
            'type' => $m['conv_type'],
            'title' => $m['conv_title'],
        ],
    ]);
}

if ($action === 'forward_message') {
    $mid = (int)($in['message_id'] ?? 0);
    $targetCid = (int)($in['target_conversation_id'] ?? 0);
    $targetUid = (int)($in['target_user_id'] ?? 0);
    if ($mid < 1) json_out(['ok' => false, 'error' => 'invalid_input'], 422);

    $q = db()->prepare('SELECT m.* FROM messages m WHERE m.id = ? AND m.deleted_at IS NULL');
    $q->execute([$mid]);
    $m = $q->fetch();
    if (!$m) json_out(['ok' => false, 'error' => 'not_found'], 404);

    // must be member of source
    $q = db()->prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?');
    $q->execute([(int)$m['conversation_id'], $uid]);
    if (!$q->fetch()) json_out(['ok' => false, 'error' => 'forbidden'], 403);

    $pdo = db();
    if ($targetCid < 1 && $targetUid > 0) {
        // open/create private chat
        $q = $pdo->prepare("
            SELECT c.id FROM conversations c
            JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
            JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
            WHERE c.type = 'private' LIMIT 1
        ");
        $q->execute([$uid, $targetUid]);
        $c = $q->fetch();
        if ($c) {
            $targetCid = (int)$c['id'];
        } else {
            $pdo->prepare("INSERT INTO conversations(type, updated_at) VALUES('private', NOW())")->execute();
            $targetCid = (int)$pdo->lastInsertId();
            $pdo->prepare('INSERT INTO conversation_members(conversation_id, user_id) VALUES(?, ?), (?, ?)')
                ->execute([$targetCid, $uid, $targetCid, $targetUid]);
        }
    }
    if ($targetCid < 1) json_out(['ok' => false, 'error' => 'invalid_target'], 422);

    $q = $pdo->prepare('SELECT cm.role, c.type FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.conversation_id = ? AND cm.user_id = ?');
    $q->execute([$targetCid, $uid]);
    $mem = $q->fetch();
    if (!$mem) json_out(['ok' => false, 'error' => 'forbidden'], 403);
    if ($mem['type'] === 'channel' && !in_array($mem['role'], ['owner', 'admin'], true)) {
        json_out(['ok' => false, 'error' => 'only_admin_can_post'], 403);
    }

    $body = decrypt_message_body((string)($m['body'] ?? ''));
    $msgType = $m['msg_type'] ?? 'text';
    $filePath = $m['file_path'] ?? null;
    $fileMime = $m['file_mime'] ?? null;
    $fileName = $m['file_name'] ?? null;
    $fileSize = $m['file_size'] ?? null;
    // prefix forward marker in body for text clarity
    if ($msgType === 'text' || !$filePath) {
        if ($body !== '' && !str_starts_with($body, '↪ ')) {
            $body = '↪ ' . $body;
        }
    }

    try {
        $hasMedia = true;
        try { $pdo->query('SELECT msg_type FROM messages LIMIT 0'); } catch (Throwable $e) { $hasMedia = false; }
        if ($hasMedia) {
            $pdo->prepare('INSERT INTO messages(conversation_id, sender_id, body, msg_type, file_path, file_mime, file_name, file_size) VALUES(?,?,?,?,?,?,?,?)')
                ->execute([$targetCid, $uid, encrypt_message_body($body), $msgType, $filePath, $fileMime, $fileName, $fileSize]);
        } else {
            $pdo->prepare('INSERT INTO messages(conversation_id, sender_id, body) VALUES(?,?,?)')
                ->execute([$targetCid, $uid, encrypt_message_body($body)]);
        }
        $newId = (int)$pdo->lastInsertId();
        $pdo->prepare('UPDATE conversations SET updated_at = NOW() WHERE id = ?')->execute([$targetCid]);
        json_out(['ok' => true, 'message_id' => $newId, 'conversation_id' => $targetCid]);
    } catch (Throwable $e) {
        json_out(['ok' => false, 'error' => 'server_error', 'detail' => $e->getMessage()], 500);
    }
}

// ---- E2E crypto public keys ----
if ($action === 'set_crypto_key') {
    $pub = trim((string)($in['public_key'] ?? ''));
    if ($pub === '' || strlen($pub) > 2000) json_out(['ok' => false, 'error' => 'invalid_key'], 422);
    try {
        db()->prepare('UPDATE users SET crypto_public_key = ? WHERE id = ?')->execute([$pub, $uid]);
        json_out(['ok' => true]);
    } catch (Throwable $e) {
        // ستون هنوز ساخته نشده
        try {
            db()->exec('ALTER TABLE users ADD COLUMN crypto_public_key TEXT DEFAULT NULL');
            db()->prepare('UPDATE users SET crypto_public_key = ? WHERE id = ?')->execute([$pub, $uid]);
            json_out(['ok' => true]);
        } catch (Throwable $e2) {
            json_out(['ok' => false, 'error' => 'migration_required', 'detail' => $e2->getMessage()], 500);
        }
    }
}

if ($action === 'get_crypto_keys') {
    $ids = $in['user_ids'] ?? [];
    if (!is_array($ids)) $ids = [];
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids), fn($x) => $x > 0)));
    if (!$ids) json_out(['ok' => true, 'keys' => new stdClass()]);
    $ph = implode(',', array_fill(0, count($ids), '?'));
    try {
        $st = db()->prepare("SELECT id, crypto_public_key FROM users WHERE id IN ($ph)");
        $st->execute($ids);
        $keys = [];
        foreach ($st as $r) {
            if (!empty($r['crypto_public_key'])) $keys[(string)$r['id']] = $r['crypto_public_key'];
        }
        json_out(['ok' => true, 'keys' => $keys]);
    } catch (Throwable $e) {
        json_out(['ok' => true, 'keys' => new stdClass()]);
    }
}

json_out(['ok' => false, 'error' => 'unknown_action'], 400);
