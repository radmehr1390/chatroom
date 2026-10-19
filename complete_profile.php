<?php
declare(strict_types=1);
require_once __DIR__.'/config.php';

if($_SERVER['REQUEST_METHOD']!=='POST') json_out(['ok'=>false,'error'=>'method_not_allowed'],405);
$token=trim((string)($_POST['verified_token']??''));
$first=trim((string)($_POST['first_name']??'')); $last=trim((string)($_POST['last_name']??'')); $username=strtolower(trim((string)($_POST['username']??'')));
if(!preg_match('/^[a-zA-Z0-9_]{3,32}$/',$username) || $first==='') json_out(['ok'=>false,'error'=>'invalid_input'],422);
if(!preg_match('/^[a-zA-Z0-9_]{3,32}$/',$username)) json_out(['ok'=>false,'error'=>'invalid_username'],422);
$st=db()->prepare('SELECT phone FROM verified_sessions WHERE token=? AND expires_at>NOW() LIMIT 1'); $st->execute([$token]); $v=$st->fetch();
if(!$v) json_out(['ok'=>false,'error'=>'invalid_verified_token'],401); $phone=$v['phone'];
$pdo=db();
try{
 $pdo->beginTransaction();
 $q=$pdo->prepare('SELECT id FROM users WHERE phone=? LIMIT 1');$q->execute([$phone]);$u=$q->fetch();
 if($u){ $q=$pdo->prepare('SELECT id FROM users WHERE username=? AND id<>?');$q->execute([$username,$u['id']]); if($q->fetch()) throw new RuntimeException('username_taken'); }
 else { $q=$pdo->prepare('SELECT id FROM users WHERE username=?');$q->execute([$username]); if($q->fetch()) throw new RuntimeException('username_taken'); }
 $avatar=null;
 if(isset($_FILES['avatar']) && $_FILES['avatar']['error']===UPLOAD_ERR_OK){
   if($_FILES['avatar']['size']>3*1024*1024) throw new RuntimeException('avatar_too_large');
   $mime=(new finfo(FILEINFO_MIME_TYPE))->file($_FILES['avatar']['tmp_name']); $allowed=['image/jpeg'=>'jpg','image/png'=>'png','image/webp'=>'webp']; if(!isset($allowed[$mime])) throw new RuntimeException('invalid_avatar');
   if(!is_dir(__DIR__.'/uploads')) mkdir(__DIR__.'/uploads',0755,true); $name=bin2hex(random_bytes(12)).'.'.$allowed[$mime];
   if(!move_uploaded_file($_FILES['avatar']['tmp_name'],__DIR__.'/uploads/'.$name)) throw new RuntimeException('avatar_upload_failed'); $avatar='uploads/'.$name;
 }
 if($u){
   $sql='UPDATE users SET username=?,first_name=?,last_name=?,last_seen=NOW()'.($avatar?',avatar_path=?':'').' WHERE id=?'; $args=[$username,$first,$last]; if($avatar)$args[]=$avatar; $args[]=$u['id']; $pdo->prepare($sql)->execute($args); $uid=(int)$u['id'];
 } else { $sql='INSERT INTO users(phone,username,first_name,last_name,avatar_path,last_seen) VALUES(?,?,?,?,?,NOW())';$pdo->prepare($sql)->execute([$phone,$username,$first,$last,$avatar]);$uid=(int)$pdo->lastInsertId(); }
 $session=bin2hex(random_bytes(32)); $hash=hash('sha256',$session); $exp=(new DateTimeImmutable('+'.SESSION_DAYS.' days'))->format('Y-m-d H:i:s');
 $pdo->prepare('DELETE FROM auth_sessions WHERE expires_at<NOW()')->execute(); $ua=substr((string)($_SERVER['HTTP_USER_AGENT']??''),0,500); $ip=substr((string)($_SERVER['HTTP_X_FORWARDED_FOR']??$_SERVER['REMOTE_ADDR']??''),0,45); if(str_contains($ip,','))$ip=trim(explode(',',$ip)[0]); $pdo->prepare('INSERT INTO auth_sessions(user_id,token_hash,user_agent,device_label,ip,expires_at) VALUES(?,?,?,?,?,?)')->execute([$uid,$hash,$ua?:null,null,$ip?:null,$exp]);
 $pdo->prepare('DELETE FROM verified_sessions WHERE token=?')->execute([$token]); $pdo->commit();
 $q=$pdo->prepare('SELECT id,phone,username,first_name,last_name,avatar_path,last_seen FROM users WHERE id=?');$q->execute([$uid]);$user=$q->fetch();$user['avatar_path']=absolute_url($user['avatar_path']);
 json_out(['ok'=>true,'session_token'=>$session,'user'=>$user]);
}catch(RuntimeException $e){if($pdo->inTransaction())$pdo->rollBack(); json_out(['ok'=>false,'error'=>$e->getMessage()],422);}catch(Throwable $e){if($pdo->inTransaction())$pdo->rollBack(); error_log($e->getMessage());json_out(['ok'=>false,'error'=>'server_error'],500);}