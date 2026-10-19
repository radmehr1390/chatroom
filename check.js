
const $ = id => document.getElementById(id);
const API = 'api.php';
const SITE_URL = 'https://chat.radmehrweb.ir/mouj-messenger.html';
const INVITE_MSG = `سلام! من از پیام‌رسان موج استفاده می‌کنم 🌊\nبیا تو هم عضو شو تا بتونیم راحت چت کنیم:\n${SITE_URL}`;

let mobile = '', verified = '', token = localStorage.getItem('mouj_token') || '', user = null;
let currentChat = 0, currentChatUser = null, lastId = 0, poll = null, otpInterval = null;
let msgPollCount = 0;
let currentTab = 'chats';
let chatFilter = 'private'; // private | group
let phoneContacts = JSON.parse(localStorage.getItem('mouj_phone_contacts') || '[]'); // [{name, phone}]
let matchedUsers = [];
let accounts = JSON.parse(localStorage.getItem('mouj_accounts') || '[]'); // max 3: [{token, user}]
let pendingAvatarFile = null;
let replyToMsg = null;
let msgCache = {};
let mediaBlobCache = {}; // file_path -> blob URL (فایل‌هایی که دانلود/آپلود شده‌اند و نیازی به دانلود دوباره ندارند)
let longPressTimer = null;
let unmatchedPhones = [];
let searchTimer = null;
let connState = 'online';
let mediaMode = 'voice';
let recorder = null, recorderChunks = [], recorderStream = null, recorderTimer = null, recorderStartedAt = 0, recorderIsVideo = false;
let callPoll = null, callSignalPoll = null, callInfoPoll = null;
let activeCallId = 0, activeCall = null, incomingCall = null, callSignalLastId = 0;
let callStream = null, callMuted = false, callPeers = {}, callCandidates = {};
let knownCallParticipantIds = new Set();


function isDesktop() {
  return window.matchMedia('(min-width: 900px)').matches;
}
function formatLastBody(body) {
  const s = String(body || '');
  if (s.startsWith('svg:')) return 'استیکر';
  if (s.startsWith('ENC1:')) return '🔒 پیام رمزنگاری‌شده';
  return s;
}
function show(id) {
  const app = $('appRoot');
  const authScreens = ['phone', 'otp', 'profile'];
  const mainScreens = ['home', 'chat', 'publicPreview'];

  if (isDesktop() && (id === 'home' || id === 'chat')) {
    // hide auth / preview overlays
    document.querySelectorAll('.screen').forEach(x => {
      if (x.id !== 'home' && x.id !== 'chat') x.classList.remove('on');
    });
    $('home').classList.add('on');
    if (app) app.classList.add('desktop-ready');
    if (id === 'chat') {
      $('chat').classList.add('on');
      if (app) app.classList.add('desktop-split');
    } else {
      $('chat').classList.remove('on');
      if (app) app.classList.remove('desktop-split');
      // clear active chat when returning to list-only
      currentChat = 0;
    }
    return;
  }

  document.querySelectorAll('.screen').forEach(x => x.classList.remove('on'));
  $(id).classList.add('on');
  if (app) {
    app.classList.remove('desktop-split');
    if (authScreens.includes(id)) app.classList.remove('desktop-ready');
    else if (mainScreens.includes(id)) app.classList.add('desktop-ready');
  }
}
function toast(x) {
  $('toast').textContent = x;
  $('toast').classList.add('show');
  clearTimeout(window.tt);
  window.tt = setTimeout(() => $('toast').classList.remove('show'), 2800);
}
let _loaderShownAt = 0;

function linkifyText(text) {
  const s = String(text || '');
  // escape first then inject links
  let out = esc(s);
  // @username
  out = out.replace(/(^|[^a-zA-Z0-9_])@([a-zA-Z0-9_]{3,32})\b/g, (m, pre, u) => {
    return pre + `<a href="javascript:void(0)" class="msg-link" data-mention="${u.toLowerCase()}" onclick="event.stopPropagation();openUserByUsername('${u.toLowerCase()}')">@${u}</a>`;
  });
  // channel/group link #c/slug or full URL with #c/
  out = out.replace(/(^|[^a-zA-Z0-9_])#c\/([a-zA-Z0-9_]{3,32})\b/g, (m, pre, slug) => {
    return pre + `<a href="javascript:void(0)" class="msg-link" onclick="event.stopPropagation();joinBySlug('${slug.toLowerCase()}')">#c/${slug}</a>`;
  });
  // profile short #u/username
  out = out.replace(/(^|[^a-zA-Z0-9_])#u\/([a-zA-Z0-9_]{3,32})\b/g, (m, pre, u) => {
    return pre + `<a href="javascript:void(0)" class="msg-link" onclick="event.stopPropagation();openUserByUsername('${u.toLowerCase()}')">#u/${u}</a>`;
  });
  // full app links ...#c/slug or ...#u/user
  out = out.replace(/(https?:\/\/[^\s<]+#c\/[a-zA-Z0-9_]{3,32})/g, (url) => {
    const slug = url.split('#c/')[1];
    return `<a href="javascript:void(0)" class="msg-link" onclick="event.stopPropagation();joinBySlug('${slug}')">${esc(url)}</a>`;
  });
  out = out.replace(/(https?:\/\/[^\s<]+#u\/[a-zA-Z0-9_]{3,32})/g, (url) => {
    const u = url.split('#u/')[1];
    return `<a href="javascript:void(0)" class="msg-link" onclick="event.stopPropagation();openUserByUsername('${u}')">${esc(url)}</a>`;
  });
  out = out.replace(/(https?:\/\/[^\s<]+#m\/\d+)/g, (url) => {
    const mid = url.split('#m/')[1];
    return `<a href="javascript:void(0)" class="msg-link" onclick="event.stopPropagation();openMessageById('${mid}')">${esc(url)}</a>`;
  });
  out = out.replace(/(^|[^a-zA-Z0-9_])#m\/(\d+)\b/g, (m, pre, mid) => {
    return pre + `<a href="javascript:void(0)" class="msg-link" onclick="event.stopPropagation();openMessageById('${mid}')">#m/${mid}</a>`;
  });
  return out;
}

async function openUserByUsername(username) {
  username = String(username || '').toLowerCase().replace(/^@/, '');
  if (!username) return;
  showLoader('در حال باز کردن پروفایل…');
  try {
    let r = await api('user_by_username', { username });
    if (!r.ok || !r.user) { toast('کاربر پیدا نشد'); return; }
    // نمایش مودال پروفایل + امکان چت
    const u = r.user;
    const letter = initials(u);
    const cols = colorFromString((u.id||'') + (u.first_name||''));
    const profileLink = (SITE_URL || location.href.split('#')[0]) + '#u/' + encodeURIComponent(u.username);
    $('profileModalCard').innerHTML = `
      <div class="sheet-handle"></div>
      <div class="modal-av" style="${u.avatar_path ? '' : `--av1:${cols.c1};--av2:${cols.c2};background:linear-gradient(135deg,var(--av1),var(--av2))`}">${u.avatar_path ? `<img src="${esc(u.avatar_path)}">` : letter}</div>
      <div class="modal-name">${esc(u.first_name)} ${esc(u.last_name || '')}</div>
      <div class="modal-meta">@${esc(u.username)}<br>${u.online ? 'آنلاین' : 'آخرین بازدید ' + humanSince(u.last_seen)}</div>
      <div class="info-row"><span>نام کاربری</span><b dir="ltr">@${esc(u.username)}</b></div>
      <div class="info-row"><span>لینک</span><b dir="ltr" style="font-size:11px;word-break:break-all">${esc(profileLink)}</b></div>
      <button class="btn" style="margin-top:14px" onclick="closeProfileModal();openChat(${u.id})">ارسال پیام</button>
      <button class="btn" style="margin-top:8px;background:var(--glass);color:var(--text);border:1px solid var(--line)" onclick="navigator.clipboard.writeText('${profileLink.replace(/'/g, "\\'")}').then(()=>toast('لینک کپی شد')).catch(()=>toast('${profileLink.replace(/'/g, "\\'")}'))">کپی لینک پروفایل</button>
      <button class="btn" style="margin-top:8px;background:var(--glass);color:var(--text);border:1px solid var(--line)" onclick="closeProfileModal()">بستن</button>
    `;
    $('profileModal').classList.add('on');
  } catch (e) { toast('خطا در دریافت پروفایل'); }
  finally { hideLoader(); }
}

function myProfileLink() {
  if (!user || !user.username) return '';
  const base = (typeof SITE_URL !== 'undefined' && SITE_URL) ? SITE_URL : (location.origin + location.pathname);
  return base.replace(/\/$/, '') + '#u/' + user.username;
}


function showLoader(text) {
  const el = $('loader');
  if (!el) return;
  $('loaderText').textContent = text || 'لطفاً صبر کنید…';
  _loaderShownAt = Date.now();
  el.classList.add('on');
}
function hideLoader() {
  const el = $('loader');
  if (!el) return;
  const elapsed = Date.now() - _loaderShownAt;
  // حداقل نمایش خیلی کوتاه تا پرش نکند، ولی سریع محو شود
  const wait = elapsed < 120 ? (120 - elapsed) : 0;
  setTimeout(() => el.classList.remove('on'), wait);
}

function norm(v) {
  let d = (v || '').replace(/\D/g, '');
  if (d.length === 10 && d[0] === '9') d = '0' + d;
  if (d.length === 12 && d.startsWith('98')) d = '0' + d.slice(2);
  return d;
}
function valid(v) { return /^09\d{9}$/.test(norm(v)); }
function human(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${fa(sec)} ثانیه دیگر`;
  let m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s ? `${fa(m)} دقیقه و ${fa(s)} ثانیه دیگر` : `${fa(m)} دقیقه دیگر`;
  let h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${fa(h)} ساعت و ${fa(mm)} دقیقه دیگر` : `${fa(h)} ساعت دیگر`;
}
function fa(n) { return String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]); }
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function colorFromString(str) {
  let h = 0;
  const s = String(str || 'موج');
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  h = Math.abs(h) % 360;
  return { c1: `hsl(${h},72%,52%)`, c2: `hsl(${(h + 48) % 360},68%,42%)` };
}
function initials(u) {
  const name = (u.first_name || u.username || u.title || u.name || 'م').trim();
  return (name[0] || 'م').toUpperCase();
}
function av(u) {
  if (u && u.avatar_path) return `<div class="av"><img src="${esc(u.avatar_path)}" alt=""></div>`;
  const letter = initials(u || {});
  const key = (u && (u.id || u.conversation_id || '')) + (u && (u.first_name || u.username || u.title || ''));
  const cols = colorFromString(key || letter);
  return `<div class="av" style="--av1:${cols.c1};--av2:${cols.c2}">${letter}</div>`;
}

// ---- Media upload/download progress (مثل واتساپ) ----
function formatBytes(n) {
  n = Number(n) || 0;
  if (!n) return '';
  if (n < 1024) return n + ' بایت';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function downloadWithProgress(url, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';
    xhr.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve(URL.createObjectURL(xhr.response));
      } else reject(new Error('http_' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.send();
  });
}

// خروجی HTML برای بخش رسانه یک پیام. اگر فایل قبلاً دانلود/آپلود شده باشد (در mediaBlobCache)
// مستقیم نمایش داده می‌شود؛ در غیر این صورت یک کاشی «برای دانلود لمس کنید» نشان داده می‌شود.
function renderMediaBlock(m) {
  const mt = m.msg_type || 'text';
  if (!m.file_path) return '';
  if (mt === 'sticker') {
    return `<img class="media" src="${esc(m.file_path)}" alt="استیکر" style="max-width:140px;background:transparent" loading="lazy">`;
  }
  const cached = mediaBlobCache[m.file_path];
  if (mt === 'image') {
    if (cached) {
      return `<div class="media-wrap ready"><img class="media" src="${esc(cached)}" onclick="event.stopPropagation();window.open('${esc(cached)}','_blank')"></div>`;
    }
    return `<div class="media-tile" data-dl="1"><div class="mt-icon">🖼️</div>
      <div class="mt-info"><div class="mt-name">عکس</div><div class="mt-sub">${formatBytes(m.file_size)} · برای دانلود لمس کنید ⬇️</div></div>
    </div>`;
  }
  if (mt === 'video') {
    if (cached) {
      return `<div class="media-wrap ready"><video class="media-video" src="${esc(cached)}" controls playsinline onclick="event.stopPropagation()"></video></div>`;
    }
    return `<div class="media-tile" data-dl="1"><div class="mt-icon">🎬</div>
      <div class="mt-info"><div class="mt-name">ویدیو</div><div class="mt-sub">${formatBytes(m.file_size)} · برای دانلود لمس کنید ⬇️</div></div>
    </div>`;
  }
  if (mt === 'voice') {
    const bars = Array.from({length: 24}, () => `<span style="height:${12 + Math.random()*70}%"></span>`).join('');
    return `<div class="voice-bubble"><button class="voice-play" type="button" onclick="event.stopPropagation();const a=this.nextElementSibling;if(a.paused){a.play();this.textContent='❚❚'}else{a.pause();this.textContent='▶'}">▶</button><audio src="${esc(m.file_path)}" preload="metadata" style="display:none" onended="this.previousElementSibling.textContent='▶'"></audio><div class="voice-wave">${bars}</div><span class="voice-time">ویس</span></div>`;
  }
  if (mt === 'video_message') {
    const src = cached || m.file_path;
    if (src) {
      return `<div class="vm-wrap" data-vm="1"><video src="${esc(src)}" playsinline preload="metadata"></video>
        <svg class="vm-ring" viewBox="0 0 198 198"><circle cx="99" cy="99" r="95"/><circle class="vm-prog" cx="99" cy="99" r="95"/></svg>
        <div class="vm-play">▶</div></div>`;
    }
    return `<div class="media-tile" data-dl="1"><div class="mt-icon">🎥</div><div class="mt-info"><div class="mt-name">پیام ویدیویی</div><div class="mt-sub">${formatBytes(m.file_size)} · برای دانلود لمس کنید ⬇️</div></div></div>`;
  }
  if (mt === 'file') {
    if (cached) {
      return `<a class="file-card" href="${esc(cached)}" download="${esc(m.file_name || 'file')}" onclick="event.stopPropagation()">
        <span style="font-size:22px">📎</span>
        <span style="min-width:0"><b style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.file_name || 'فایل')}</b>
        <span style="font-size:11px;opacity:.7">${formatBytes(m.file_size)} · آماده ✓</span></span>
      </a>`;
    }
    return `<div class="media-tile" data-dl="1"><div class="mt-icon">📎</div>
      <div class="mt-info"><div class="mt-name">${esc(m.file_name || 'فایل')}</div><div class="mt-sub">${formatBytes(m.file_size)} · برای دانلود لمس کنید ⬇️</div></div>
    </div>`;
  }
  return '';
}

function bindMediaDownload(tile, m) {
  if (!tile) return;
  tile.onclick = async (e) => {
    e.stopPropagation();
    if (tile.dataset.downloading === '1') return;
    tile.dataset.downloading = '1';
    const icon = tile.querySelector('.mt-icon');
    const sub = tile.querySelector('.mt-sub');
    if (icon) icon.innerHTML = `<div class="progress-ring"><span>0%</span></div>`;
    const ring = icon && icon.querySelector('.progress-ring');
    const span = icon && icon.querySelector('span');
    try {
      const blobUrl = await downloadWithProgress(m.file_path, (p) => {
        if (ring) ring.style.setProperty('--p', p);
        if (span) span.textContent = p + '%';
        if (sub) sub.textContent = 'در حال دانلود… ' + p + '%';
      });
      mediaBlobCache[m.file_path] = blobUrl;
      const mount = document.getElementById('mm-' + m.id);
      if (mount) mount.innerHTML = renderMediaBlock(m);
    } catch (err) {
      tile.dataset.downloading = '0';
      if (icon) icon.innerHTML = '⚠️';
      if (sub) sub.textContent = 'دانلود ناموفق — دوباره لمس کنید';
    }
  };
}

// ---- Connection status ----
function updateConnPill() {
  const p = $('connPill');
  if (!navigator.onLine) {
    p.textContent = 'بدون اینترنت';
    p.className = 'pill offline';
    connState = 'offline';
  } else if (connState === 'connecting') {
    p.textContent = 'در حال اتصال…';
    p.className = 'pill connecting';
  } else {
    p.textContent = 'موج';
    p.className = 'pill';
    connState = 'online';
  }
}
window.addEventListener('online', () => { connState = 'online'; updateConnPill(); });
window.addEventListener('offline', () => { connState = 'offline'; updateConnPill(); });
setInterval(updateConnPill, 5000);

// ---- Auth screens ----
$('phoneInput').oninput = () => { $('phoneBtn').disabled = !valid($('phoneInput').value); };
$('phoneBtn').onclick = async () => {
  mobile = norm($('phoneInput').value);
  $('phoneBtn').classList.add('loading');
  $('phoneBtn').disabled = true;
  try {
    let r = await post('send_otp.php', { mobile });
    if (r.ok) {
      buildOtp(); show('otp'); startTimer(r.retry_after || 120); toast('کد تایید ارسال شد');
    } else {
      toast(r.error === 'too_many_requests' ? human(r.retry_after || 120) : 'ارسال کد ناموفق بود');
    }
  } finally {
    $('phoneBtn').classList.remove('loading');
    $('phoneBtn').disabled = !valid($('phoneInput').value);
  }
};

function buildOtp() {
  $('otpBoxes').innerHTML = '';
  for (let i = 0; i < 5; i++) {
    let x = document.createElement('input');
    x.maxLength = 1; x.inputMode = 'numeric';
    x.oninput = () => {
      x.value = x.value.replace(/\D/g, '');
      if (x.value && i < 4) $('otpBoxes').children[i + 1].focus();
      $('verifyBtn').disabled = getCode().length !== 5;
    };
    x.onkeydown = e => { if (e.key === 'Backspace' && !x.value && i) $('otpBoxes').children[i - 1].focus(); };
    $('otpBoxes').appendChild(x);
  }
}
function getCode() { return [...$('otpBoxes').children].map(x => x.value).join(''); }

async function verify() {
  $('verifyBtn').classList.add('loading'); $('verifyBtn').disabled = true;
  showLoader('در حال تایید کد…');
  try {
    let r = await post('verify_otp.php', { mobile, code: getCode() });
    if (r.ok) {
      if (r.existing_user && r.session_token) {
        token = r.session_token; localStorage.setItem('mouj_token', token);
        user = r.user; saveCurrentAccount(); openHome(); toast('خوش آمدی دوباره 👋');
      } else {
        verified = r.verified_token; show('profile'); toast('شماره تایید شد');
      }
    } else {
      toast(r.error === 'wrong_code' ? 'کد اشتباه است' : r.error === 'code_expired' ? 'کد منقضی شده است' : 'تایید ناموفق بود');
    }
  } finally {
    hideLoader(); $('verifyBtn').classList.remove('loading');
    $('verifyBtn').disabled = getCode().length !== 5;
  }
}
$('verifyBtn').onclick = verify;

function startTimer(sec) {
  clearInterval(otpInterval);
  let end = Date.now() + sec * 1000;
  let tick = () => {
    let s = Math.ceil((end - Date.now()) / 1000);
    $('timer').textContent = s > 0 ? 'ارسال مجدد تا ' + human(s) : 'ارسال مجدد کد';
    if (s <= 0) { clearInterval(otpInterval); $('timer').onclick = resend; $('timer').style.cursor = 'pointer'; }
  };
  tick(); otpInterval = setInterval(tick, 1000);
}
async function resend() {
  let r = await post('send_otp.php', { mobile });
  if (r.ok) { startTimer(r.retry_after || 120); toast('کد جدید ارسال شد'); }
}

$('username').oninput = () => { $('username').value = $('username').value.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase(); };
$('avatar').onchange = () => {
  const f = $('avatar').files[0]; if (!f) return;
  $('avatarPreview').src = URL.createObjectURL(f);
  $('avatarPreview').style.display = 'block';
  $('avatarPlaceholder').style.display = 'none';
};
$('first').oninput = () => {
  const v = $('first').value.trim();
  if (v && !$('avatar').files[0]) $('avatarPlaceholder').textContent = v[0].toUpperCase();
};

$('finish').onclick = async () => {
  const first = $('first').value.trim();
  const username = $('username').value.trim();
  if (!first || username.length < 3) { toast('نام و نام‌کاربری (حداقل ۳ حرف) الزامی است'); return; }
  $('finish').classList.add('loading'); showLoader('در حال ساخت پروفایل…');
  let fd = new FormData();
  fd.append('verified_token', verified);
  fd.append('first_name', first);
  fd.append('last_name', $('last').value.trim());
  fd.append('username', username);
  if ($('avatar').files[0]) fd.append('avatar', $('avatar').files[0]);
  try {
    let r = await fetch('complete_profile.php', { method: 'POST', body: fd }).then(x => x.json());
    if (!r.ok) { toast(r.error === 'username_taken' ? 'این نام کاربری قبلاً گرفته شده' : 'ثبت پروفایل ناموفق بود'); return; }
    token = r.session_token; localStorage.setItem('mouj_token', token);
    user = r.user; saveCurrentAccount(); openHome(); toast('خوش آمدی 👋');
  } catch (e) { toast('خطا در ارتباط با سرور'); }
  finally { hideLoader(); $('finish').classList.remove('loading'); }
};

// ---- Helpers ----
async function post(url, data) {
  try {
    return await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json());
  } catch (e) { return { ok: false, error: 'network' }; }
}
async function api(action, data = {}) {
  connState = 'connecting'; updateConnPill();
  try {
    let r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ action, ...data })
    });
    if (r.status === 401) { logout(); throw 0; }
    connState = 'online'; updateConnPill();
    return r.json();
  } catch (e) {
    if (e !== 0) { connState = navigator.onLine ? 'connecting' : 'offline'; updateConnPill(); }
    throw e;
  }
}

function openHome() {
  show('home');
  if (isDesktop() && $('appRoot')) $('appRoot').classList.add('desktop-ready');
  ensureCryptoIdentity().catch(() => {});
  updateConnPill();
  startCallPoll();
  loadTab('chats');
  // بعد از ورود، پیشنهاد همگام‌سازی مخاطبین
  if (!localStorage.getItem('mouj_contacts_asked')) {
    setTimeout(() => {
      localStorage.setItem('mouj_contacts_asked', '1');
      toast('می‌تونی مخاطبین گوشی رو همگام کنی (+)');
    }, 1500);
  }
  handleDeepLink();
  showIosPwaTip();
}

// ---- Tabs & Search ----
document.querySelectorAll('.nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.nav button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  loadTab(b.dataset.tab);
});

$('searchInput').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = $('searchInput').value.trim();
    if (currentTab === 'chats') {
      if (chatFilter !== 'private' && q.length >= 2) searchPublicAndChats(q);
      else loadChats(q);
    } else if (currentTab === 'contacts') loadContacts(q);
  }, 280);
};

async function searchPublicAndChats(q) {
  try {
    const [chatsR, pubR] = await Promise.all([
      api('chats', { q }),
      api('search_public', { q })
    ]);
    let chats = (chatsR.chats || []).filter(c => c.type === 'group' || c.type === 'channel');
    const mineIds = new Set(chats.map(c => c.conversation_id));
    let html = '';
    if (chats.length) {
      html += '<div class="section-label">گفتگوهای شما</div>';
      html += chats.map(c => {
        const g = { title: c.title, conversation_id: c.conversation_id, id: c.conversation_id, avatar_path: c.avatar_path };
        return `<div class="row" onclick="openGroupChat(${c.conversation_id}, '${esc(c.title || '')}')">
          ${av(g)}
          <div class="mid">
            <div class="name">${c.type === 'channel' ? '📢 ' : ''}${esc(c.title || '')}</div>
            <div class="last">${c.slug ? '@' + esc(c.slug) : ''}</div>
          </div>
        </div>`;
      }).join('');
    }
    const pubs = (pubR.results || []).filter(c => !mineIds.has(c.conversation_id));
    if (pubs.length) {
      html += '<div class="section-label">کانال‌ها و گروه‌های عمومی</div>';
      html += pubs.map(c => {
        const g = { title: c.title, conversation_id: c.conversation_id, id: c.conversation_id, avatar_path: c.avatar_path };
        return `<div class="row" onclick="joinBySlug('${esc(c.slug)}')">
          ${av(g)}
          <div class="mid">
            <div class="name">${c.type === 'channel' ? '📢 ' : ''}${esc(c.title || '')}</div>
            <div class="last">@${esc(c.slug)} · عضویت</div>
          </div>
        </div>`;
      }).join('');
    }
    if (!html) html = '<div class="empty">نتیجه‌ای پیدا نشد.<br>آیدی یا نام کانال عمومی را جستجو کنید.</div>';
    $('list').innerHTML = html;
  } catch (e) {
    loadChats(q);
  }
}

async function loadTab(tab) {
  currentTab = tab;
  $('pageTitle').textContent = tab === 'chats' ? 'چت‌ها' : tab === 'contacts' ? 'مخاطبین' : tab === 'calls' ? 'تماس‌ها' : 'تنظیمات';
  $('fab').style.display = (tab === 'settings' || tab === 'calls') ? 'none' : 'block';
  $('searchWrap').style.display = (tab === 'settings' || tab === 'calls') ? 'none' : 'flex';
  $('chatTabs').style.display = (tab === 'chats') ? 'flex' : 'none';
  $('searchInput').value = '';
  $('searchInput').placeholder = tab === 'chats' ? 'جستجو در چت‌ها...' : 'جستجو نام یا @یوزرنیم...';
  if (tab === 'chats') loadChats();
  else if (tab === 'contacts') loadContacts();
  else if (tab === 'calls') loadCalls();
  else loadSettings();
}


// ---- Voice calls / WebRTC ----
function callEscName(u){ return esc((((u&&u.first_name)||'کاربر')+' '+((u&&u.last_name)||'')).trim()); }
function callAvatarHtml(u){ if(u&&u.avatar_path) return `<img src="${esc(u.avatar_path)}">`; return esc(initials(u||{})); }

async function loadCalls(){
  const box=$('callsList'); if(!box) return;
  try{
    const r=await api('call_list'); const calls=r.calls||[];
    if(!calls.length){ box.innerHTML='<div class="empty" style="padding-top:45px">هنوز تماسی ندارید.<br>از «تماس گروهی جدید» یا داخل یک چت تماس را شروع کنید.</div>'; return; }
    box.innerHTML=calls.map(c=>{
      const mine=!!c.mine, title=c.type==='group'?(c.title||'گروه'):c.creator_name;
      const action=c.status==='ended'?'<span class="call-meta">پایان‌یافته</span>':(mine?`<button class="call-action secondary" onclick="openLiveCall(${c.id},true)">بازگشت</button>`:`<button class="call-action" onclick="joinCallFromList(${c.id})">پیوستن</button>`);
      return `<div class="call-card"><div class="call-icon">${c.type==='group'?'👥':'📞'}</div><div class="call-main"><b>${esc(title)}</b><div class="call-meta">${c.type==='group'?'تماس گروهی · ':''}${fa(c.participants.length)} نفر · در حال برقراری</div></div>${action}</div>`;
    }).join('');
  }catch(e){ box.innerHTML='<div class="empty">خطا در بارگذاری تماس‌ها</div>'; }
}

async function createCallForConversation(cid){
  if(activeCallId){ toast('شما در یک تماس هستید'); return; }
  if(!cid) return;
  try{
    showLoader('در حال شروع تماس…');
    const r=await api('call_create',{conversation_id:cid});
    if(!r.ok){ toast(r.error==='invalid_conversation'?'این گفتگو قابل تماس نیست':'شروع تماس ناموفق بود'); return; }
    await openLiveCall(r.call_id,!r.existing);
  }catch(e){ toast('خطا در شروع تماس'); }
  finally{ hideLoader(); }
}
function startChatCall(){ if(currentChat) createCallForConversation(currentChat); }

async function openLiveCall(callId,isCreator=false){
  if(activeCallId && activeCallId!==callId) { toast('ابتدا تماس فعلی را تمام کنید'); return; }
  try{
    if(!callStream){ callStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false}); }
  }catch(e){ toast('دسترسی به میکروفون لازم است'); return; }
  activeCallId=Number(callId); callSignalLastId=0; callPeers={}; callCandidates={}; knownCallParticipantIds=new Set();
  if(!isCreator){ const jr=await api('call_join',{call_id:activeCallId}); if(!jr.ok){toast(jr.error==='call_ended'?'تماس تمام شده است':'امکان ورود به تماس نیست'); cleanupCallLocal();return;} }
  await refreshCallInfo();
  $('callRoom').classList.add('on');
  $('callRoomTitle').textContent=activeCall.type==='group'?(activeCall.title||'تماس گروهی'):'تماس صوتی';
  $('callRoomStatus').textContent='در حال اتصال…';
  startCallLoops();
}
async function refreshCallInfo(){
  if(!activeCallId)return;
  const r=await api('call_info',{call_id:activeCallId});
  if(!r.ok){ endLiveCall(true); return; }
  activeCall=r.call;
  const ids=new Set((activeCall.participants||[]).map(x=>Number(x.id)));
  for(const p of activeCall.participants||[]) if(Number(p.id)!==Number(user.id)) await ensureCallPeer(Number(p.id));
  for(const id of Object.keys(callPeers)) if(!ids.has(Number(id))) closeCallPeer(Number(id));
  renderCallParticipants();
  const count=(activeCall.participants||[]).length;
  $('callRoomStatus').textContent=count>1?`${fa(count)} نفر · متصل`:'در انتظار ورود…';
}
function renderCallParticipants(){
  const box=$('callParticipants'); if(!box||!activeCall)return;
  box.innerHTML=(activeCall.participants||[]).map(p=>`<div class="call-person"><div class="av">${callAvatarHtml(p)}</div><b>${callEscName(p)}${Number(p.id)===Number(user.id)?' (شما)':''}</b></div>`).join('');
}
async function ensureCallPeer(otherId){
  otherId=Number(otherId); if(!otherId||otherId===Number(user.id)||callPeers[otherId])return;
  const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}]});
  callPeers[otherId]=pc; callCandidates[otherId]=[];
  if(callStream) callStream.getTracks().forEach(t=>pc.addTrack(t,callStream));
  pc.onicecandidate=e=>{ if(e.candidate) sendCallSignal(otherId,'candidate',e.candidate); };
  pc.ontrack=e=>{
    let a=document.getElementById('call-audio-'+otherId);
    if(!a){a=document.createElement('audio');a.id='call-audio-'+otherId;a.autoplay=true;a.playsInline=true;document.getElementById('remoteAudios').appendChild(a);}
    if(e.streams&&e.streams[0]) a.srcObject=e.streams[0];
    a.play().catch(()=>{});
  };
  pc.onconnectionstatechange=()=>{ if(['failed','closed'].includes(pc.connectionState)) closeCallPeer(otherId); };
  // Deterministic initiator: smaller user id creates the offer.
  if(Number(user.id)<otherId){
    const offer=await pc.createOffer(); await pc.setLocalDescription(offer); await sendCallSignal(otherId,'offer',pc.localDescription);
  }
}
async function sendCallSignal(to,type,payload){ try{ await api('call_signal',{call_id:activeCallId,to_user_id:to,signal_type:type,payload}); }catch(e){} }
async function processCallSignals(){
  if(!activeCallId)return;
  try{
    const r=await api('call_signals',{call_id:activeCallId,after_id:callSignalLastId});
    for(const s of r.signals||[]){ callSignalLastId=Math.max(callSignalLastId,Number(s.id)); const from=Number(s.from_user_id); await ensureCallPeer(from); const pc=callPeers[from]; if(!pc)continue;
      try{
        if(s.signal_type==='offer'){
          await pc.setRemoteDescription(new RTCSessionDescription(s.payload));
          for(const c of (callCandidates[from]||[])) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{});
          callCandidates[from]=[];
          const ans=await pc.createAnswer(); await pc.setLocalDescription(ans); await sendCallSignal(from,'answer',pc.localDescription);
        }else if(s.signal_type==='answer'){
          if(pc.signalingState!=='stable') await pc.setRemoteDescription(new RTCSessionDescription(s.payload));
        }else if(s.signal_type==='candidate'){
          if(pc.remoteDescription&&pc.remoteDescription.type) await pc.addIceCandidate(new RTCIceCandidate(s.payload)).catch(()=>{}); else (callCandidates[from]||(callCandidates[from]=[])).push(s.payload);
        }
      }catch(e){}
    }
  }catch(e){}
}
function startCallLoops(){ clearInterval(callSignalPoll);clearInterval(callInfoPoll); callSignalPoll=setInterval(processCallSignals,700);callInfoPoll=setInterval(refreshCallInfo,1800); processCallSignals(); }
function closeCallPeer(id){ const pc=callPeers[id];if(pc){try{pc.close()}catch(e){}}delete callPeers[id];delete callCandidates[id];const a=document.getElementById('call-audio-'+id);if(a)a.remove(); }
function cleanupCallLocal(){ clearInterval(callSignalPoll);clearInterval(callInfoPoll); callSignalPoll=null;callInfoPoll=null; Object.keys(callPeers).forEach(closeCallPeer);callPeers={};callCandidates={};if(callStream){callStream.getTracks().forEach(t=>t.stop());callStream=null;}activeCallId=0;activeCall=null;callSignalLastId=0;$('callRoom')?.classList.remove('on');$('incomingCallOverlay')?.classList.remove('on'); }
async function endLiveCall(silent=false){ if(!activeCallId){cleanupCallLocal();return;} const id=activeCallId; try{await api('call_end',{call_id:id});}catch(e){} cleanupCallLocal(); if(!silent) { toast('تماس پایان یافت'); if(currentTab==='calls')loadCalls(); } }
async function leaveLiveCall(){ if(!activeCallId)return; const id=activeCallId;try{await api('call_leave',{call_id:id})}catch(e){}cleanupCallLocal(); }
function toggleCallMute(){ if(!callStream)return;callMuted=!callMuted;callStream.getAudioTracks().forEach(t=>t.enabled=!callMuted);$('callMuteBtn').textContent=callMuted?'🔇':'🎙️'; }

async function joinCallFromList(id){ if(activeCallId){toast('ابتدا تماس فعلی را تمام کنید');return;} await openLiveCall(id,false); }
function showIncomingCall(c){
  if(activeCallId||incomingCall)return;
  incomingCall=c; const title=c.type==='group'?(c.title||'تماس گروهی'):c.creator_name;
  $('incomingCallTitle').textContent=title; $('incomingCallSub').textContent=c.type==='group'?'تماس گروهی در حال برقراری است':'تماس صوتی ورودی'; $('incomingCallOverlay').classList.add('on');
}
async function answerIncomingCall(){ if(!incomingCall)return; const c=incomingCall;incomingCall=null;$('incomingCallOverlay').classList.remove('on');await openLiveCall(c.id,false); }
async function declineIncomingCall(){ if(!incomingCall)return; const id=incomingCall.id;incomingCall=null;$('incomingCallOverlay').classList.remove('on');try{await api('call_leave',{call_id:id});}catch(e){} }
async function startCallPoll(){
  clearInterval(callPoll); const tick=async()=>{ if(!token||activeCallId)return; try{const r=await api('call_list');const calls=r.calls||[];const incoming=calls.find(c=>!c.mine&&c.status!=='ended');if(incoming)showIncomingCall(incoming);if(currentTab==='calls')renderCallsFromData(calls);}catch(e){}}; await tick(); callPoll=setInterval(tick,2000);
}
function renderCallsFromData(calls){ const box=$('callsList');if(!box)return;if(!calls.length){box.innerHTML='<div class="empty" style="padding-top:45px">هنوز تماسی ندارید.<br>از «تماس گروهی جدید» یا داخل یک چت تماس را شروع کنید.</div>';return;} box.innerHTML=calls.map(c=>{const mine=!!c.mine,title=c.type==='group'?(c.title||'گروه'):c.creator_name;return `<div class="call-card"><div class="call-icon">${c.type==='group'?'👥':'📞'}</div><div class="call-main"><b>${esc(title)}</b><div class="call-meta">${c.type==='group'?'تماس گروهی · ':''}${fa(c.participants.length)} نفر · ${c.status==='ended'?'پایان‌یافته':'فعال'}</div></div>${c.status==='ended'?'<span class="call-meta">پایان‌یافته</span>':`<button class="call-action ${mine?'secondary':''}" onclick="${mine?`openLiveCall(${c.id},true)`:`joinCallFromList(${c.id})`}">${mine?'بازگشت':'پیوستن'}</button>`}</div>`;}).join(''); }

async function chooseCallConversation(groupOnly=false){
  try{const r=await api('chats',{q:''});const list=(r.chats||[]).filter(c=>groupOnly?c.type==='group':c.type==='private');
    $('actionSheetBody').innerHTML=`<h3 style="margin:0 0 12px">${groupOnly?'انتخاب گروه برای تماس':'انتخاب گفتگو برای تماس'}</h3>`+(list.length?list.map(c=>{const title=c.type==='private'?`${c.user.first_name} ${c.user.last_name||''}`:(c.title||'گروه');const cid=c.type==='private'?null:c.conversation_id;return `<div class="sheet-item" data-cid="${cid||''}" data-uid="${c.user?.id||''}"><div class="sheet-icon">${c.type==='group'?'👥':'📞'}</div><div><b>${esc(title)}</b><span>${c.type==='group'?'تماس گروهی':'تماس صوتی'}</span></div></div>`;}).join(''):'<div class="empty">گفتگوی مناسب پیدا نشد.</div>');
    openSheet($('actionSheet')); $('actionSheetBody').querySelectorAll('.sheet-item').forEach(el=>el.onclick=()=>{const cid=Number(el.dataset.cid);const uid=Number(el.dataset.uid);closeSheets();if(cid)createCallForConversation(cid);else if(uid)api('open_chat',{user_id:uid}).then(x=>x.ok&&createCallForConversation(x.conversation_id));});
  }catch(e){toast('خطا در دریافت گفتگوها');}
}
$('newGroupCallBtn').onclick=()=>chooseCallConversation(true);
$('newPrivateCallBtn').onclick=()=>chooseCallConversation(false);

// Chat sub-tabs (personal / groups)
document.querySelectorAll('#chatTabs button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('#chatTabs button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    chatFilter = b.dataset.filter;
    loadChats($('searchInput').value.trim());
  };
});

async function loadChats(q = '') {
  try {
    let r = await api('chats', { q });
    let chats = r.chats || [];
    // saved همیشه در تب شخصی
    const saved = chats.filter(c => c.type === 'saved');
    // فیلتر شخصی / گروه
    chats = chats.filter(c => {
      if (c.type === 'saved') return false;
      if (chatFilter === 'private') return c.type === 'private';
      return c.type === 'group' || c.type === 'channel';
    });

    let html = '';
    if (chatFilter === 'private' && !q) {
      // دکمه پیام‌های ذخیره‌شده
      html += `<div class="row" onclick="openSavedMessages()">
        <div class="av" style="background:linear-gradient(135deg,#f6c26c,#e89b3c)">🔖</div>
        <div class="mid">
          <div class="line"><div class="name">پیام‌های ذخیره‌شده</div></div>
          <div class="last">یادداشت‌ها و پیام‌های شخصی شما</div>
        </div>
      </div>`;
      if (saved.length && saved[0].last_message) {
        // already covered by button
      }
    }

    if (!chats.length && !(chatFilter === 'private' && !q)) {
      const emptyMsg = chatFilter === 'private'
        ? 'هنوز گفتگوی شخصی ندارید.<br>از دکمه ＋ یک چت جدید شروع کنید.'
        : 'هنوز گروه یا کانالی ندارید.<br>از دکمه ＋ گروه/کانال بسازید یا با لینک عضو شوید.';
      $('list').innerHTML = html + `<div class="empty">${emptyMsg}</div>`;
      return;
    }
    if (!chats.length && chatFilter === 'private' && !q) {
      $('list').innerHTML = html + '<div class="empty" style="padding-top:20px">هنوز گفتگوی شخصی ندارید.</div>';
      return;
    }

    html += chats.map(c => {
      if (c.type === 'private' && c.user) {
        return `<div class="row" onclick="openChat(${c.user.id})">
          ${av(c.user)}
          <div class="mid">
            <div class="line">
              <div class="name">${c.pinned ? '📌 ' : ''}${esc(c.user.first_name)} ${esc(c.user.last_name || '')}</div>
              <div class="time">${c.last_message ? new Date(c.last_message.created_at.replace(' ','T')).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'}) : ''}</div>
            </div>
            <div class="last">${c.last_message ? esc(formatLastBody(c.last_message.body)) : 'شروع گفتگو'}${c.unread_count > 0 ? `<span class="unread-badge">${fa(c.unread_count > 99 ? '99+' : c.unread_count)}</span>` : ''}</div>
          </div>
        </div>`;
      }
      const g = {
        title: c.title || (c.type === 'channel' ? 'کانال' : 'گروه'),
        conversation_id: c.conversation_id,
        id: c.conversation_id,
        avatar_path: c.avatar_path || null
      };
      const badge = c.type === 'channel' ? '📢 ' : '';
      return `<div class="row" onclick="openGroupChat(${c.conversation_id}, '${esc(g.title)}')">
        ${av(g)}
        <div class="mid">
          <div class="line"><div class="name">${c.pinned ? '📌 ' : ''}${badge}${esc(g.title)}</div>
          <div class="time">${c.last_message ? new Date(c.last_message.created_at.replace(' ','T')).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'}) : ''}</div></div>
          <div class="last"><span style="color:var(--c)">${c.member_count != null ? (c.type === 'channel' ? '📢 ' : '👥 ') + fa(c.member_count) + ' عضو' : ''}</span>${c.last_message ? (c.member_count != null ? ' · ' : '') + esc(formatLastBody(c.last_message.body)) : ''}${c.unread_count > 0 ? `<span class="unread-badge">${fa(c.unread_count > 99 ? '99+' : c.unread_count)}</span>` : ''}</div>
        </div>
      </div>`;
    }).join('');
    $('list').innerHTML = html;
  } catch (e) {
    $('list').innerHTML = '<div class="empty">خطا در بارگذاری چت‌ها</div>';
  }
}

async function loadContacts(q = '') {
  try {
    // سرچ سروری (نام / یوزرنیم — بدون نمایش شماره برای حفظ حریم)
    let serverUsers = [];
    if (q.length >= 2) {
      let sr = await api('search_users', { q });
      serverUsers = sr.users || [];
    } else {
      // مخاطبین همگام‌شده + همه کاربران (محدود)
      let r = await api('contacts', { q: '' });
      serverUsers = r.contacts || [];
    }

    // match phone contacts
    let html = '';
    if (matchedUsers.length && !q) {
      html += '<div class="section-label">مخاطبین موج</div>';
      html += matchedUsers.map(u => `
        <div class="row" onclick="openChat(${u.id})">
          ${av(u)}
          <div class="mid">
            <div class="name">${esc(u.first_name)} ${esc(u.last_name || '')}</div>
            <div class="status">${u.online ? 'آنلاین' : 'آخرین بازدید ' + humanSince(u.last_seen)}</div>
          </div>
        </div>`).join('');
    }

    if (unmatchedPhones.length && !q) {
      html += '<div class="section-label">دعوت به موج</div>';
      html += unmatchedPhones.map(p => {
        const pc = phoneContacts.find(c => norm(c.phone) === p);
        const name = pc ? pc.name : p;
        return `<div class="row" style="cursor:default">
          <div class="av">📱</div>
          <div class="mid">
            <div class="name">${esc(name)}</div>
            <div class="status">${esc(p)}</div>
          </div>
          <button class="invite-btn" onclick="inviteSms('${p}')">دعوت</button>
        </div>`;
      }).join('');
    }

    if (q.length >= 2) {
      html += '<div class="section-label">نتایج جستجو</div>';
      if (!serverUsers.length) {
        html += '<div class="empty">کسی پیدا نشد</div>';
      } else {
        html += serverUsers.map(u => `
          <div class="row" onclick="openChat(${u.id})">
            ${av(u)}
            <div class="mid">
              <div class="name">${esc(u.first_name)} ${esc(u.last_name || '')}</div>
              <div class="status">@${esc(u.username)}${u.phone ? '' : ''}</div>
            </div>
          </div>`).join('');
      }
    } else if (!matchedUsers.length && !unmatchedPhones.length) {
      html += serverUsers.length
        ? serverUsers.map(u => `
          <div class="row" onclick="openChat(${u.id})">
            ${av(u)}
            <div class="mid">
              <div class="name">${esc(u.first_name)} ${esc(u.last_name || '')}</div>
              <div class="status">${u.online ? 'آنلاین' : '@' + esc(u.username)}</div>
            </div>
          </div>`).join('')
        : '<div class="empty">مخاطبی نیست.<br>از دکمه ＋ مخاطبین گوشی را همگام کنید یا مخاطب اضافه کنید.</div>';
    }

    $('list').innerHTML = html;
  } catch (e) {
    $('list').innerHTML = '<div class="empty">خطا در بارگذاری مخاطبین</div>';
  }
}

function humanSince(s) {
  if (!s) return 'نامشخص';
  let d = Math.max(0, Math.floor((Date.now() - new Date(s.replace(' ', 'T'))) / 1000));
  if (d < 60) return 'همین الان';
  if (d < 3600) return fa(Math.floor(d / 60)) + ' دقیقه پیش';
  if (d < 86400) return fa(Math.floor(d / 3600)) + ' ساعت پیش';
  return fa(Math.floor(d / 86400)) + ' روز پیش';
}

// ---- Settings ----
function loadSettings() {
  if (!user) return;
  pendingAvatarFile = null;
  const accountsHtml = accounts.length ? accounts.map((a, i) => {
    const isCurrent = a.token === token;
    return `<div class="row" style="margin:4px 0;${isCurrent ? 'border-color:var(--c)' : ''}" onclick="${isCurrent ? '' : `switchAccount(${i})`}">
      ${av(a.user)}
      <div class="mid">
        <div class="name">${esc(a.user.first_name)} ${esc(a.user.last_name || '')} ${isCurrent ? '✓' : ''}</div>
        <div class="last">@${esc(a.user.username)}</div>
      </div>
      ${!isCurrent ? `<button class="invite-btn" style="background:var(--danger)" onclick="event.stopPropagation();removeAccount(${i})">حذف</button>` : ''}
    </div>`;
  }).join('') : '<div class="muted" style="padding:8px 4px">فقط همین حساب فعال است</div>';

  $('list').innerHTML = `
    <div class="settings-card">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px">
        <div class="avatar-box" style="width:72px;height:72px;margin:0;cursor:pointer" id="settingsAvatarBox" onclick="document.getElementById('settingsAvatar').click()">
          ${user.avatar_path ? `<img id="settingsAvPreview" src="${esc(user.avatar_path)}" style="width:100%;height:100%;object-fit:cover">` : `<span id="settingsAvLetter" style="font-size:28px;font-weight:800">${initials(user)}</span>`}
          <div class="cam">📷</div>
          <input id="settingsAvatar" type="file" accept="image/*" style="display:none">
        </div>
        <div>
          <div class="name" style="font-size:17px">${esc(user.first_name)} ${esc(user.last_name || '')}</div>
          <div class="last">@${esc(user.username)} · ${esc(user.phone || '')}</div>
          <div class="muted" style="font-size:11px;margin-top:4px">برای تغییر عکس پروفایل کلیک کنید</div>
        </div>
      </div>
      <div class="field" style="flex-direction:column;align-items:stretch;gap:0">
        <label>نام</label>
        <input id="editFirst" value="${esc(user.first_name)}">
      </div>
      <div class="field" style="flex-direction:column;align-items:stretch;gap:0">
        <label>نام خانوادگی</label>
        <input id="editLast" value="${esc(user.last_name || '')}">
      </div>
      <div class="field" style="flex-direction:column;align-items:stretch;gap:0">
        <label>نام کاربری</label>
        <input id="editUsername" dir="ltr" value="${esc(user.username)}">
      </div>
      <button class="btn edit-btn" id="saveProfileBtn">ذخیره تغییرات</button>
      <button class="btn" style="margin-top:10px;background:var(--glass);color:var(--text);border:1px solid var(--line)" id="copyProfileLinkBtn">کپی لینک پروفایل من</button>
      <div class="muted" style="font-size:11px;margin-top:8px;word-break:break-all;direction:ltr;text-align:left" id="myProfileLinkHint"></div>
    </div>

    <div class="settings-card" style="margin-top:12px">
      <div class="name" style="margin-bottom:10px">حساب‌ها (حداکثر ۳)</div>
      ${accountsHtml}
      ${accounts.length < 3 ? `<button class="btn" style="margin-top:10px;background:var(--glass);color:var(--text);border:1px solid var(--line)" id="addAccountBtn">+ افزودن حساب جدید</button>` : '<div class="muted" style="margin-top:8px;font-size:12px">حداکثر ۳ حساب فعال است</div>'}
    </div>

    <div class="settings-card" style="margin-top:12px" id="devicesCard">
      <div class="name" style="margin-bottom:10px">دستگاه‌های متصل</div>
      <div class="muted" id="devicesList">در حال بارگذاری…</div>
    </div>

    <div class="row" onclick="enableNotifications()" style="margin-top:8px">
      <div class="mid"><div class="name">فعال‌سازی نوتیفیکیشن</div><div class="last">اطلاع از پیام جدید</div></div>
    </div>
    <div class="row" onclick="syncPhoneContacts()" style="margin-top:8px">
      <div class="mid"><div class="name">همگام‌سازی مخاطبین گوشی</div></div>
    </div>
    <div class="settings-card" style="margin-top:12px" id="blockedCard">
      <div class="name" style="margin-bottom:10px">کاربران مسدود</div>
      <div class="muted" id="blockedList">—</div>
    </div>
    <div class="row" onclick="deleteMyAccount()" style="margin-top:8px">
      <div class="mid"><div class="name" style="color:var(--danger)">حذف دائمی حساب</div><div class="last">پیام‌ها و سابقه شما باقی می‌ماند و نام به «این اکانت حذف شده» تبدیل می‌شود.</div></div>
    </div>
    <div class="row" onclick="logout()" style="margin-top:8px">
      <div class="mid"><div class="name" style="color:var(--danger)">خروج از حساب فعلی</div></div>
    </div>
  `;
  loadDevices();
  loadBlockedList();
  // set gradient for letter if no avatar
  if (!user.avatar_path) {
    const box = $('settingsAvatarBox');
    const cols = colorFromString((user.id||'') + (user.first_name||''));
    box.style.background = `linear-gradient(135deg,${cols.c1},${cols.c2})`;
  }
  $('editUsername').oninput = () => { $('editUsername').value = $('editUsername').value.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase(); };
  $('saveProfileBtn').onclick = saveProfile;
  const pl = myProfileLink();
  const hint = $('myProfileLinkHint');
  if (hint) hint.textContent = pl;
  const copyBtn = $('copyProfileLinkBtn');
  if (copyBtn) copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(pl); toast('لینک پروفایل کپی شد'); }
    catch (e) { toast(pl); }
  };
  $('settingsAvatar').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    pendingAvatarFile = f;
    const url = URL.createObjectURL(f);
    const box = $('settingsAvatarBox');
    box.innerHTML = `<img id="settingsAvPreview" src="${url}" style="width:100%;height:100%;object-fit:cover"><div class="cam">📷</div><input id="settingsAvatar" type="file" accept="image/*" style="display:none">`;
    // rebind
    $('settingsAvatar').onchange = arguments.callee;
  };
  const addBtn = $('addAccountBtn');
  if (addBtn) addBtn.onclick = addNewAccount;
}

async function deleteMyAccount() {
  if (!confirm('حذف حساب انجام شود؟\nاین کار قابل بازگشت نیست و حساب شما برای دیگران با عنوان «این اکانت حذف شده» نمایش داده می‌شود.')) return;
  if (!confirm('برای تأیید نهایی، دوباره «حذف حساب» را تأیید کنید.')) return;
  showLoader('در حال حذف حساب…');
  try {
    const r = await api('delete_account', {});
    if (!r.ok) { toast(r.error || 'حذف حساب ناموفق بود'); return; }
    accounts = accounts.filter(a => a.token !== token);
    localStorage.setItem('mouj_accounts', JSON.stringify(accounts));
    localStorage.removeItem('mouj_token');
    token = ''; user = null;
    toast('حساب حذف شد');
    setTimeout(() => location.reload(), 400);
  } catch(e) { toast('خطا در حذف حساب'); }
  finally { hideLoader(); }
}

async function saveProfile() {
  const first = $('editFirst').value.trim();
  const last = $('editLast').value.trim();
  const username = $('editUsername').value.trim();
  if (!first || username.length < 3) { toast('نام و نام‌کاربری معتبر وارد کنید'); return; }
  $('saveProfileBtn').classList.add('loading'); showLoader('در حال ذخیره…');
  try {
    // اگر عکس جدید انتخاب شده، با FormData بفرست
    if (pendingAvatarFile) {
      const fd = new FormData();
      fd.append('action', 'update_profile');
      fd.append('first_name', first);
      fd.append('last_name', last);
      fd.append('username', username);
      fd.append('avatar', pendingAvatarFile);
      let r = await fetch(API, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: fd
      }).then(x => x.json());
      if (r.ok) {
        user = r.user;
        pendingAvatarFile = null;
        saveCurrentAccount();
        toast('اطلاعات و عکس ذخیره شد ✓');
        loadSettings();
      } else {
        toast(r.error === 'username_taken' ? 'این نام کاربری قبلاً گرفته شده' : (r.error || 'ذخیره ناموفق بود'));
      }
    } else {
      let r = await api('update_profile', { first_name: first, last_name: last, username });
      if (r.ok) {
        user = r.user;
        saveCurrentAccount();
        toast('اطلاعات ذخیره شد ✓');
        loadSettings();
      } else {
        toast(r.error === 'username_taken' ? 'این نام کاربری قبلاً گرفته شده' : 'ذخیره ناموفق بود');
      }
    }
  } catch (e) { toast('خطا در ارتباط'); }
  finally { hideLoader(); const btn = $('saveProfileBtn'); if (btn) btn.classList.remove('loading'); }
}



async function loadBlockedList() {
  const box = $('blockedList');
  if (!box) return;
  try {
    let r = await api('blocked_list');
    const list = r.users || [];
    if (!list.length) { box.innerHTML = '<div class="muted">کسی مسدود نیست</div>'; return; }
    box.innerHTML = list.map(u => `
      <div class="row" style="margin:4px 0">
        ${av(u)}
        <div class="mid"><div class="name">${esc(u.first_name)} ${esc(u.last_name||'')}</div>
        <div class="last">@${esc(u.username)}</div></div>
        <button class="invite-btn" onclick="unblockUser(${u.id})">رفع مسدودی</button>
      </div>`).join('');
  } catch (e) { box.innerHTML = '<div class="muted">—</div>'; }
}

async function loadDevices() {
  const box = $('devicesList');
  if (!box) return;
  try {
    let r = await api('my_sessions');
    if (!r || r.ok === false) {
      box.innerHTML = '<div class="muted">خطا در دریافت دستگاه‌ها' + (r && r.detail ? ' ('+esc(r.detail)+')' : '') + '</div>';
      return;
    }
    const list = r.sessions || [];
    if (!list.length) {
      box.innerHTML = '<div class="muted">دستگاهی ثبت نشده</div>';
      return;
    }
    box.innerHTML = list.map(s => {
      const when = s.last_seen ? new Date(s.last_seen.replace(' ','T')).toLocaleString('fa-IR') : '—';
      const created = s.created_at ? new Date(s.created_at.replace(' ','T')).toLocaleDateString('fa-IR') : '';
      return `<div class="row" style="margin:6px 0;padding:10px;background:rgba(0,0,0,.15);border-radius:14px">
        <div class="av" style="width:40px;height:40px;font-size:18px;background:var(--glass)">📱</div>
        <div class="mid">
          <div class="name" style="font-size:14px">${esc(s.device_label || 'دستگاه')}${s.is_current ? ' <span style="color:var(--c);font-size:11px">(همین دستگاه)</span>' : ''}</div>
          <div class="last" style="font-size:11px">آخرین فعالیت: ${when}${created ? ' · ورود: ' + created : ''}${s.ip ? ' · ' + esc(s.ip) : ''}</div>
        </div>
        ${!s.is_current ? `<button class="invite-btn" style="background:var(--danger)" onclick="revokeSession(${s.id})">خروج</button>` : ''}
      </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = '<div class="muted">خطا در دریافت دستگاه‌ها — اگر migrate_v3 را نزده‌اید اجرا کنید</div>';
  }
}

async function revokeSession(id) {
  if (!confirm('این دستگاه از حساب خارج شود؟')) return;
  try {
    let r = await api('revoke_session', { session_id: id });
    if (r.ok) { toast('دستگاه خارج شد'); loadDevices(); }
    else toast(r.error === 'cannot_revoke_current' ? 'نمی‌توانید دستگاه فعلی را حذف کنید' : 'خطا');
  } catch (e) { toast('خطا'); }
}

function saveCurrentAccount() {
  if (!token || !user) return;
  const idx = accounts.findIndex(a => a.token === token || (a.user && a.user.id === user.id));
  const entry = { token, user: { ...user } };
  if (idx >= 0) accounts[idx] = entry;
  else {
    if (accounts.length >= 3) accounts.shift();
    accounts.push(entry);
  }
  localStorage.setItem('mouj_accounts', JSON.stringify(accounts));
  localStorage.setItem('mouj_token', token);
}

function switchAccount(i) {
  if (!accounts[i]) return;
  token = accounts[i].token;
  user = accounts[i].user;
  localStorage.setItem('mouj_token', token);
  toast('حساب تغییر کرد');
  openHome();
}

function removeAccount(i) {
  if (!confirm('این حساب از لیست حذف شود؟')) return;
  const wasCurrent = accounts[i] && accounts[i].token === token;
  accounts.splice(i, 1);
  localStorage.setItem('mouj_accounts', JSON.stringify(accounts));
  if (wasCurrent) {
    if (accounts.length) {
      switchAccount(0);
    } else {
      logout();
    }
  } else {
    loadSettings();
  }
}

function addNewAccount() {
  if (accounts.length >= 3) { toast('حداکثر ۳ حساب مجاز است'); return; }
  // ذخیره حساب فعلی
  saveCurrentAccount();
  // خروج موقت و رفتن به صفحه ورود (بدون پاک کردن لیست حساب‌ها)
  clearInterval(poll);
  token = '';
  user = null;
  localStorage.removeItem('mouj_token');
  show('phone');
  toast('شماره حساب جدید را وارد کنید');
}

// ---- FAB menu ----
const fab = $('fab');
const overlay = $('overlay');
const fabSheet = $('fabSheet');
const actionSheet = $('actionSheet');

function openSheet(el) { overlay.classList.add('on'); el.classList.add('on'); fab.classList.add('open'); }
function closeSheets() {
  overlay.classList.remove('on');
  fabSheet.classList.remove('on');
  actionSheet.classList.remove('on');
  fab.classList.remove('open');
}
fab.onclick = () => {
  if (fabSheet.classList.contains('on')) closeSheets();
  else openSheet(fabSheet);
};
overlay.onclick = closeSheets;

fabSheet.querySelectorAll('.sheet-item').forEach(item => {
  item.onclick = () => {
    const a = item.dataset.action;
    closeSheets();
    if (a === 'new-chat') { document.querySelector('[data-tab="contacts"]').click(); }
    else if (a === 'add-contact') openAddContact();
    else if (a === 'new-group') openCreateGroup('group');
    else if (a === 'new-channel') openCreateGroup('channel');
    else if (a === 'sync-contacts') syncPhoneContacts();
  };
});

function openAddContact() {
  $('actionSheetBody').innerHTML = `
    <h3 style="margin:0 0 14px">افزودن مخاطب</h3>
    <div class="field" style="flex-direction:column;align-items:stretch;gap:0">
      <label>نام (اختیاری)</label>
      <input id="acName" placeholder="نام مخاطب">
    </div>
    <div class="field" style="flex-direction:column;align-items:stretch;gap:0">
      <label>شماره موبایل</label>
      <input id="acPhone" inputmode="numeric" placeholder="0912...">
    </div>
    <button class="btn" id="acSubmit">بررسی و افزودن</button>
  `;
  openSheet(actionSheet);
  $('acSubmit').onclick = async () => {
    const phone = norm($('acPhone').value);
    const name = $('acName').value.trim() || phone;
    if (!valid(phone)) { toast('شماره معتبر نیست'); return; }
    showLoader('در حال بررسی…');
    try {
      let r = await api('match_contacts', { phones: [phone] });
      closeSheets();
      if (r.matched && r.matched.length) {
        const u = r.matched[0];
        await api('add_contact', { phone });
        toast(u.first_name + ' به مخاطبین اضافه شد ✓');
        if (currentTab === 'contacts') loadContacts();
        openChat(u.id);
      } else {
        // دعوت
        phoneContacts.push({ name, phone });
        localStorage.setItem('mouj_phone_contacts', JSON.stringify(phoneContacts));
        unmatchedPhones = [...new Set([...unmatchedPhones, phone])];
        inviteSms(phone);
        toast('این شماره در موج نیست — دعوت ارسال شد');
        if (currentTab === 'contacts') loadContacts();
      }
    } catch (e) { toast('خطا'); }
    finally { hideLoader(); }
  };
}

// ---- انتخاب‌گر مخاطبین (برای افزودن عضو، هنگام ساخت یا بعد ساخت گروه/کانال) ----
function memberRowHtml(u, selected) {
  return `<div class="member-row ${selected ? 'sel' : ''}" data-uid="${u.id}">
    ${av(u)}
    <div class="mid">
      <div class="name">${esc(u.first_name)} ${esc(u.last_name || '')}</div>
      <div class="status">${u.username ? '@' + esc(u.username) : (u.online ? 'آنلاین' : '')}</div>
    </div>
    <div class="chk">${selected ? '✓' : ''}</div>
  </div>`;
}
function memberChipHtml(u) {
  return `<span class="member-chip">${esc(u.first_name || u.username || 'کاربر')}<b data-uid="${u.id}">✕</b></span>`;
}
// searchEl/listEl/chipsEl: عناصر DOM از قبل موجود در شیت. excludeIds: کاربرانی که نباید نشان داده شوند.
function setupMemberPicker({ searchEl, listEl, chipsEl, excludeIds = [] }) {
  const selected = new Map();
  let lastUsers = [];
  const excl = new Set(excludeIds.map(Number));

  function renderChips() {
    chipsEl.innerHTML = [...selected.values()].map(memberChipHtml).join('');
    chipsEl.querySelectorAll('b[data-uid]').forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); toggle(Number(b.dataset.uid)); };
    });
  }
  function renderList() {
    listEl.innerHTML = lastUsers.length
      ? lastUsers.map(u => memberRowHtml(u, selected.has(u.id))).join('')
      : '<div class="empty" style="padding:14px 0;font-size:12px">کسی پیدا نشد</div>';
    listEl.querySelectorAll('.member-row').forEach(row => {
      row.onclick = () => toggle(Number(row.dataset.uid));
    });
  }
  function toggle(id) {
    const u = lastUsers.find(x => x.id === id) || selected.get(id);
    if (!u) return;
    if (selected.has(id)) selected.delete(id); else selected.set(id, u);
    renderChips();
    const row = listEl.querySelector(`[data-uid="${id}"]`);
    if (row) {
      row.classList.toggle('sel', selected.has(id));
      const chk = row.querySelector('.chk');
      if (chk) chk.textContent = selected.has(id) ? '✓' : '';
    }
  }
  async function search(q) {
    try {
      let r = await api('contacts', { q: q || '' });
      lastUsers = (r.contacts || []).filter(u => !excl.has(u.id));
      renderList();
    } catch (e) { listEl.innerHTML = '<div class="empty" style="padding:14px 0;font-size:12px">خطا در بارگذاری</div>'; }
  }
  let t = null;
  searchEl.oninput = () => { clearTimeout(t); t = setTimeout(() => search(searchEl.value.trim()), 300); };
  search('');
  return { getSelectedIds: () => [...selected.keys()], getSelectedUsers: () => [...selected.values()] };
}

function openAddMembersSheet(cid, label) {
  $('actionSheetBody').innerHTML = `
    <h3 style="margin:0 0 12px">افزودن عضو به ${esc(label)}</h3>
    <div id="amChips" class="member-chips"></div>
    <input class="member-search" id="amSearch" placeholder="جستجوی نام یا آیدی…">
    <div class="member-list" id="amList"><div class="empty" style="padding:14px 0;font-size:12px">در حال بارگذاری…</div></div>
    <button class="btn" id="amSubmit" style="margin-top:14px">افزودن عضو</button>
  `;
  openSheet(actionSheet);
  const picker = setupMemberPicker({ searchEl: $('amSearch'), listEl: $('amList'), chipsEl: $('amChips') });
  $('amSubmit').onclick = async () => {
    const ids = picker.getSelectedIds();
    if (!ids.length) { toast('حداقل یک نفر را انتخاب کنید'); return; }
    showLoader('در حال افزودن…');
    try {
      let r = await api('add_members', { conversation_id: cid, member_ids: ids });
      closeSheets();
      if (r.ok) toast(fa(r.added) + ' نفر اضافه شد ✓');
      else toast(r.error === 'forbidden' ? 'دسترسی ندارید' : (r.error || 'خطا در افزودن'));
    } catch (e) { toast('خطا'); }
    finally { hideLoader(); }
  };
}

function openCreateGroup(kind) {
  const label = kind === 'channel' ? 'کانال' : 'گروه';
  const title = 'ایجاد ' + label;
  $('actionSheetBody').innerHTML = `
    <h3 style="margin:0 0 14px">${title}</h3>
    <div style="display:flex;justify-content:center;margin-bottom:14px">
      <div class="avatar-box" id="gAvatarBox" style="width:80px;height:80px;margin:0;cursor:pointer" onclick="document.getElementById('gAvatar').click()">
        <span id="gAvatarLetter" style="font-size:28px;font-weight:800">＋</span>
        <img id="gAvatarPreview" style="display:none;width:100%;height:100%;object-fit:cover">
        <div class="cam">📷</div>
        <input id="gAvatar" type="file" accept="image/*" style="display:none">
      </div>
    </div>
    <div class="field" style="flex-direction:column;align-items:stretch;gap:0">
      <label>نام ${label}</label>
      <input id="gTitle" placeholder="مثلاً دوستان">
    </div>
    <div class="field" style="flex-direction:column;align-items:stretch;gap:0">
      <label>آیدی یکتا (انگلیسی)</label>
      <input id="gSlug" dir="ltr" placeholder="my_${kind === 'channel' ? 'channel' : 'group'}" style="text-align:left">
    </div>
    <div class="field" style="flex-direction:column;align-items:stretch;gap:0">
      <label>توضیحات (اختیاری)</label>
      <input id="gDesc" placeholder="درباره ${label}">
    </div>
    <label style="display:flex;align-items:center;gap:10px;margin:8px 4px 14px;font-size:13px;color:var(--dim)">
      <input type="checkbox" id="gPublic" ${kind === 'channel' ? 'checked' : ''}> عمومی باشد (قابل جستجو و عضویت با لینک)
    </label>
    <p class="muted" style="margin:0 0 12px;font-size:12px">لینک بعد از ساخت: …/mouj-messenger.html#c/<b>آیدی</b></p>
    <div class="field" style="flex-direction:column;align-items:stretch;gap:0">
      <label>افزودن عضو (اختیاری)</label>
    </div>
    <div id="gMemberChips" class="member-chips"></div>
    <input class="member-search" id="gMemberSearch" placeholder="جستجوی نام یا آیدی…">
    <div class="member-list" id="gMemberList"><div class="empty" style="padding:14px 0;font-size:12px">در حال بارگذاری…</div></div>
    <button class="btn" id="gSubmit" style="margin-top:14px">ایجاد ${label}</button>
  `;
  openSheet(actionSheet);
  const gMemberPicker = setupMemberPicker({ searchEl: $('gMemberSearch'), listEl: $('gMemberList'), chipsEl: $('gMemberChips') });
  let gFile = null;
  $('gAvatar').onchange = () => {
    const f = $('gAvatar').files[0]; if (!f) return;
    gFile = f;
    $('gAvatarPreview').src = URL.createObjectURL(f);
    $('gAvatarPreview').style.display = 'block';
    $('gAvatarLetter').style.display = 'none';
  };
  $('gSlug').oninput = () => {
    $('gSlug').value = $('gSlug').value.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
  };
  $('gTitle').oninput = () => {
    if (!$('gSlug').dataset.touched) {
      const s = $('gTitle').value.trim().toLowerCase().replace(/[^a-z0-9_\u0600-\u06FF]/gi, '').replace(/[\u0600-\u06FF]/g, '').slice(0, 20);
      // فقط اگر کاربر چیزی انگلیسی نوشته باشد پیشنهاد نده — ساده نگه می‌داریم
    }
  };
  $('gSlug').onfocus = () => { $('gSlug').dataset.touched = '1'; };
  $('gSubmit').onclick = async () => {
    const t = $('gTitle').value.trim();
    const slug = $('gSlug').value.trim().toLowerCase();
    const desc = $('gDesc').value.trim();
    const isPublic = $('gPublic').checked ? 1 : 0;
    if (!t) { toast('نام را وارد کنید'); return; }
    if (!/^[a-z0-9_]{3,32}$/.test(slug)) { toast('آیدی باید ۳ تا ۳۲ حرف انگلیسی/عدد/_ باشد'); return; }
    showLoader('در حال ایجاد…');
    try {
      const fd = new FormData();
      fd.append('action', kind === 'channel' ? 'create_channel' : 'create_group');
      fd.append('title', t);
      fd.append('slug', slug);
      fd.append('description', desc);
      fd.append('is_public', isPublic);
      if (gFile) fd.append('avatar', gFile);
      gMemberPicker.getSelectedIds().forEach(id => fd.append('member_ids[]', String(id)));
      let r = await fetch(API, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: fd }).then(x => x.json());
      closeSheets();
      if (r.ok) {
        toast(label + ' ساخته شد ✓');
        if (r.link) toast('لینک: #' + slug);
        document.querySelector('[data-tab="chats"]').click();
      } else {
        toast(r.error === 'slug_taken' ? 'این آیدی قبلاً گرفته شده' : (r.error || 'خطا در ایجاد'));
      }
    } catch (e) { toast('خطا'); }
    finally { hideLoader(); }
  };
}

// ---- Contacts sync (Contacts Picker API + fallback) ----
async function syncPhoneContacts() {
  // Contacts Picker API فقط در Chrome Android (نه Safari)
  if ('contacts' in navigator && 'ContactsManager' in window) {
    try {
      const props = ['name', 'tel'];
      const opts = { multiple: true };
      const selected = await navigator.contacts.select(props, opts);
      const list = [];
      selected.forEach(c => {
        const name = (c.name && c.name[0]) || '';
        (c.tel || []).forEach(t => {
          const p = norm(t);
          if (valid(p)) list.push({ name: name || p, phone: p });
        });
      });
      if (list.length) {
        // ادغام با لیست قبلی
        const map = {};
        [...phoneContacts, ...list].forEach(c => { map[c.phone] = c; });
        phoneContacts = Object.values(map);
        localStorage.setItem('mouj_phone_contacts', JSON.stringify(phoneContacts));
        await matchStoredContacts();
        toast(list.length + ' مخاطب همگام شد');
        if (currentTab === 'contacts') loadContacts();
        return;
      }
    } catch (e) { /* user cancelled */ }
  }
  // Safari / iOS: افزودن دستی + امکان دعوت SMS
  openAddContact();
  if (isIos()) {
    toast('در Safari دفترچه تلفن مستقیم باز نمی‌شود — شماره را دستی وارد کنید');
  } else {
    toast('مرورگر از دفترچه تلفن پشتیبانی نمی‌کند — شماره را دستی وارد کنید');
  }
}

async function matchStoredContacts() {
  if (!phoneContacts.length) return;
  const phones = phoneContacts.map(c => c.phone);
  try {
    let r = await api('match_contacts', { phones });
    matchedUsers = r.matched || [];
    unmatchedPhones = r.unmatched || [];
  } catch (e) {}
}

function inviteSms(phone) {
  const body = encodeURIComponent(INVITE_MSG);
  // iOS Safari: sms:&body=  | Android: sms:?body=
  const isIosUa = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const href = isIosUa
    ? `sms:${phone}&body=${body}`
    : `sms:${phone}?body=${body}`;
  // بعضی مرورگرها location را بلاک می‌کنند — از <a> موقت استفاده کن
  const a = document.createElement('a');
  a.href = href;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 500);
}

// ---- Chat ----
async function openChat(uid) {
  showLoader('در حال باز کردن گفتگو…');
  try {
    let r = await api('open_chat', { user_id: uid });
    if (!r.ok) { toast(r.error === 'user_not_found' ? 'کاربر پیدا نشد' : 'خطا در باز کردن چت'); return; }
    currentChat = r.conversation_id;
    currentChatUser = r.user;
    lastId = 0; msgPollCount = 0; msgCache = {}; clearReply();
    $('chatName').textContent = r.user.first_name + ' ' + (r.user.last_name || '');
    $('chatStatus').textContent = r.user.online ? 'آنلاین' : humanSince(r.user.last_seen);
    $('chatCallBtn').style.display = 'grid';
    setChatAv(r.user);
    $('messages').innerHTML = '';
    ensureChatEditBtn(false);
    show('chat');
    await loadMessages();
    clearInterval(poll);
    startMsgPoll();
  } catch (e) { toast('خطا در باز کردن چت'); }
  finally { hideLoader(); }
}

function setChatAv(u) {
  const el = $('chatAv');
  if (u && u.avatar_path) {
    el.style.background = '';
    el.style.animation = 'none';
    el.innerHTML = `<img src="${esc(u.avatar_path)}" alt="">`;
  } else {
    const letter = initials(u || {});
    const key = (u && (u.id || u.conversation_id || '')) + (u && (u.first_name || u.username || u.title || ''));
    const cols = colorFromString(key || letter);
    el.style.setProperty('--av1', cols.c1);
    el.style.setProperty('--av2', cols.c2);
    el.style.background = `linear-gradient(135deg,${cols.c1},${cols.c2})`;
    el.style.animation = 'avShift 7s ease-in-out infinite alternate';
    el.innerHTML = letter;
  }
}

let currentConvInfo = null;

async function openGroupChat(cid, title) {
  currentChat = cid;
  currentChatUser = null;
  currentConvInfo = null;
  lastId = 0; msgPollCount = 0; msgCache = {}; clearReply();
  $('chatName').textContent = title || '…';
  $('chatStatus').textContent = '…';
  setChatAv({ title, conversation_id: cid, id: cid });
  $('messages').innerHTML = '';
  $('composer').style.display = 'flex';
  show('chat');
  try {
    let info = await api('conversation_info', { conversation_id: cid });
    if (info.ok && info.conversation) {
      currentConvInfo = info.conversation;
      const c = info.conversation;
      $('chatName').textContent = c.title || title;
      $('chatCallBtn').style.display = c.type === 'group' ? 'grid' : 'none';
      const typeLabel = c.type === 'channel' ? 'کانال' : (c.type === 'saved' ? 'ذخیره‌شده' : 'گروه');
      $('chatStatus').textContent = (c.member_count != null ? fa(c.member_count) + ' عضو · ' : '') + (c.slug ? typeLabel + ' · @' + c.slug : typeLabel);
      setChatAv({ title: c.title, conversation_id: cid, id: cid, avatar_path: c.avatar_path });
      if (c.type === 'channel' && !c.can_post) {
        $('composer').style.display = 'none';
      } else {
        $('composer').style.display = 'flex';
      }
      // دکمه ویرایش در هدر اگر ادمین باشد
      ensureChatEditBtn(c.can_edit);
    }
  } catch (e) {}
  await loadMessages();
  clearInterval(poll);
  startMsgPoll();
}

function ensureChatEditBtn(canEdit) {
  let btn = document.getElementById('chatEditBtn');
  let pinBtn = document.getElementById('chatPinBtn');
  let searchBtn = document.getElementById('chatSearchBtn');
  if (!searchBtn) {
    searchBtn = document.createElement('button');
    searchBtn.id = 'chatSearchBtn';
    searchBtn.className = 'back';
    searchBtn.style.fontSize = '16px';
    searchBtn.textContent = '🔍';
    searchBtn.onclick = (e) => { e.stopPropagation(); openChatSearch(); };
    $('chatHead').appendChild(searchBtn);
  }
  if (!pinBtn) {
    pinBtn = document.createElement('button');
    pinBtn.id = 'chatPinBtn';
    pinBtn.className = 'back';
    pinBtn.style.fontSize = '16px';
    pinBtn.textContent = '📌';
    pinBtn.onclick = (e) => { e.stopPropagation(); if (currentChat) togglePin(currentChat, false); };
    $('chatHead').appendChild(pinBtn);
  }
  if (!canEdit) {
    if (btn) btn.remove();
    return;
  }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'chatEditBtn';
    btn.className = 'back';
    btn.style.fontSize = '18px';
    btn.textContent = '✎';
    btn.onclick = (e) => { e.stopPropagation(); openEditConversation(); };
    $('chatHead').appendChild(btn);
  }
}

async function openSavedMessages() {
  showLoader('در حال باز کردن…');
  try {
    let r = await api('saved_messages');
    if (!r.ok) { toast('خطا'); return; }
    await openGroupChat(r.conversation_id, r.title || 'پیام‌های ذخیره‌شده');
  } catch (e) { toast('خطا'); }
  finally { hideLoader(); }
}

function openEditConversation() {
  if (!currentConvInfo || !currentConvInfo.can_edit) { toast('دسترسی ندارید'); return; }
  const c = currentConvInfo;
  const label = c.type === 'channel' ? 'کانال' : 'گروه';
  $('actionSheetBody').innerHTML = `
    <h3 style="margin:0 0 14px">ویرایش ${label}</h3>
    <div style="display:flex;justify-content:center;margin-bottom:14px">
      <div class="avatar-box" id="eAvatarBox" style="width:80px;height:80px;margin:0;cursor:pointer" onclick="document.getElementById('eAvatar').click()">
        ${c.avatar_path ? `<img id="eAvatarPreview" src="${esc(c.avatar_path)}" style="width:100%;height:100%;object-fit:cover">` : `<span id="eAvatarLetter" style="font-size:28px;font-weight:800">${(c.title||'؟')[0]}</span>`}
        <div class="cam">📷</div>
        <input id="eAvatar" type="file" accept="image/*" style="display:none">
      </div>
    </div>
    <div class="field" style="flex-direction:column;align-items:stretch;gap:0">
      <label>نام</label>
      <input id="eTitle" value="${esc(c.title || '')}">
    </div>
    <div class="field" style="flex-direction:column;align-items:stretch;gap:0">
      <label>آیدی</label>
      <input id="eSlug" dir="ltr" value="${esc(c.slug || '')}" disabled style="opacity:.6;text-align:left">
    </div>
    <div class="field" style="flex-direction:column;align-items:stretch;gap:0">
      <label>توضیحات</label>
      <input id="eDesc" value="${esc(c.description || '')}">
    </div>
    <label style="display:flex;align-items:center;gap:10px;margin:8px 4px 14px;font-size:13px;color:var(--dim)">
      <input type="checkbox" id="ePublic" ${c.is_public ? 'checked' : ''}> عمومی (قابل جستجو و عضویت با لینک)
    </label>
    ${c.link ? `<p class="muted" style="font-size:12px;word-break:break-all">لینک: <span dir="ltr">${esc(c.link)}</span></p>
    <button class="btn" style="margin-bottom:10px;background:var(--glass);color:var(--text);border:1px solid var(--line)" id="eCopyLink">کپی لینک</button>` : ''}
    <button class="btn" type="button" id="eAddMembers" style="margin-bottom:10px;background:var(--glass);color:var(--text);border:1px solid var(--line)">➕ افزودن عضو</button>
    <button class="btn danger-delete-conversation" type="button" id="eDeleteConversation">حذف ${label}</button>
    <button class="btn" id="eSubmit">ذخیره تغییرات</button>
  `;
  openSheet(actionSheet);
  $('eDeleteConversation').onclick = async () => {
    const what = label === 'کانال' ? 'کانال' : 'گروه';
    if (!confirm(`آیا مطمئن هستید که می‌خواهید ${what} «${c.title || ''}» را برای همه حذف کنید؟\nاین کار قابل بازگشت نیست.`)) return;
    showLoader(`در حال حذف ${what}…`);
    try {
      const r = await api('delete_conversation', { conversation_id: c.conversation_id });
      if (!r.ok) { toast(r.error === 'only_creator_can_delete' ? 'فقط سازنده می‌تواند حذف کند' : 'حذف ناموفق بود'); return; }
      closeSheets();
      currentChat = null; currentConvInfo = null;
      $('chat').classList.remove('on');
      toast(`${what} حذف شد ✓`);
      await loadChats();
    } catch(e) { toast('خطا در حذف'); }
    finally { hideLoader(); }
  };
  $('eAddMembers').onclick = () => openAddMembersSheet(c.conversation_id, label);
  let eFile = null;
  $('eAvatar').onchange = () => {
    const f = $('eAvatar').files[0]; if (!f) return;
    eFile = f;
    const box = $('eAvatarBox');
    box.innerHTML = `<img src="${URL.createObjectURL(f)}" style="width:100%;height:100%;object-fit:cover"><div class="cam">📷</div><input id="eAvatar" type="file" accept="image/*" style="display:none">`;
    $('eAvatar').onchange = arguments.callee;
  };
  const copyBtn = $('eCopyLink');
  if (copyBtn) copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(c.link); toast('لینک کپی شد'); } catch (e) { toast(c.link); }
  };
  $('eSubmit').onclick = async () => {
    const title = $('eTitle').value.trim();
    const desc = $('eDesc').value.trim();
    const isPublic = $('ePublic').checked ? 1 : 0;
    if (!title) { toast('نام را وارد کنید'); return; }
    showLoader('در حال ذخیره…');
    try {
      const fd = new FormData();
      fd.append('action', 'edit_conversation');
      fd.append('conversation_id', String(c.conversation_id));
      fd.append('title', title);
      fd.append('description', desc);
      fd.append('is_public', isPublic);
      if (eFile) fd.append('avatar', eFile);
      let r = await fetch(API, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: fd }).then(x => x.json());
      closeSheets();
      if (r.ok) {
        toast('ذخیره شد ✓');
        currentConvInfo = { ...currentConvInfo, ...r.conversation, can_edit: true, can_post: currentConvInfo.can_post };
        $('chatName').textContent = r.conversation.title;
        setChatAv({ title: r.conversation.title, conversation_id: c.conversation_id, id: c.conversation_id, avatar_path: r.conversation.avatar_path });
      } else toast(r.error || 'خطا');
    } catch (e) { toast('خطا'); }
    finally { hideLoader(); }
  };
}

async function joinBySlug(slug) {
  slug = String(slug || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (slug.length < 3) return;
  showLoader('در حال عضویت…');
  try {
    let r = await api('join_by_slug', { slug });
    if (r.ok) { toast('عضو شدید ✓'); await openGroupChat(r.conversation_id, r.title); }
    else toast(r.error === 'private_channel' ? 'این کانال خصوصی است' : r.error === 'not_found' ? 'پیدا نشد' : 'خطا');
  } catch(e){ toast('خطا'); } finally { hideLoader(); }
}

let previewSlug = '';
async function openPublicPreview(slug) {
  slug = String(slug||'').toLowerCase().replace(/[^a-z0-9_]/g,'');
  if (slug.length < 3) return;
  showLoader('در حال دریافت پیش‌نمایش…');
  try {
    const r = await fetch(API, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'public_conversation',slug})}).then(x=>x.json());
    if (!r.ok) { toast(r.error==='not_found'?'گروه یا کانال پیدا نشد':'این لینک عمومی نیست'); return; }
    previewSlug = slug;
    const c=r.conversation||{};
    const avatar = c.avatar_path ? `<div class="av"><img src="${esc(c.avatar_path)}"></div>` : av({title:c.title,conversation_id:c.conversation_id});
    let html=`<div class="preview-info">${avatar}<div class="preview-title">${c.type==='channel'?'📢 ':''}${esc(c.title||'')}</div><div class="preview-meta">${fa(c.member_count||0)} عضو · ${c.type==='channel'?'کانال عمومی':'گروه عمومی'}</div>${c.description?`<div class="preview-desc">${esc(c.description)}</div>`:''}</div><div class="section-label">پیام‌های قبلی</div>`;
    (r.messages||[]).forEach(m=>{
      const d=document.createElement('div'); d.className='bubble';
      let content=''; const mt=m.msg_type||'text';
      const sk=(typeof m.body==='string'&&m.body.startsWith('svg:'))?m.body.slice(4):'';
      if(sk && typeof stickerSvg==='function' && stickerSvg(sk)){ content+=`<div class="sticker-msg">${stickerSvg(sk)}</div>`; d.classList.add('sticker-bubble'); }
      else if(m.file_path){ if(mt==='image') content+=`<img class="media" src="${esc(m.file_path)}" loading="lazy">`; else if(mt==='video'||mt==='video_message') content+=`<video class="media-video ${mt==='video_message'?'video-message':''}" src="${esc(m.file_path)}" controls playsinline></video>`; else if(mt==='voice') content+=`<audio controls src="${esc(m.file_path)}" style="width:190px"></audio>`; }
      if(!(sk&&stickerSvg(sk)) && m.body && !/^📷 عکس$|^🎬 ویدیو$|^🎤 ویس$|^🎥 پیام ویدیویی$/.test(m.body)) content+=linkifyText(m.body);
      d.innerHTML=`<div style="font-size:10px;color:var(--dim);margin-bottom:3px">${esc((m.first_name||'کاربر')+' '+(m.last_name||''))}</div>${content}<small>${new Date(m.created_at.replace(' ','T')).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'})}</small>`;
      html+=d.outerHTML;
    });
    $('previewBody').innerHTML=html;
    $('previewJoinBtn').onclick=async()=>{ await joinBySlug(previewSlug); };
    show('publicPreview');
  } catch(e){ toast('خطا در دریافت پیش‌نمایش'); } finally { hideLoader(); }
}
$('previewBack').onclick=()=>show('home');

function handleDeepLink() {
  let slug=null, uname=null, mid=null;
  const hash=(location.hash||'').replace(/^#/,'');
  if(hash.startsWith('c/')) slug=hash.slice(2).split(/[/?#]/)[0];
  if(hash.startsWith('u/')) uname=hash.slice(2).split(/[/?#]/)[0];
  if(hash.startsWith('@')) uname=hash.slice(1).split(/[/?#]/)[0];
  if(hash.startsWith('m/')) mid=hash.slice(2).split(/[/?#]/)[0];
  const params=new URLSearchParams(location.search);
  if(!slug) slug=params.get('c'); if(!uname) uname=params.get('u'); if(!mid) mid=params.get('m');
  if(!slug&&!uname&&!mid){ const parts=location.pathname.split('/').filter(Boolean); const last=parts[parts.length-1]||''; if(last&&last!=='mouj-messenger.html'&&/^[a-z0-9_]{3,32}$/i.test(last)) slug=last; }
  if(mid && token){ openMessageById(mid); return; }
  if(uname && token){ openUserByUsername(uname); return; }
  if(slug){ openPublicPreview(slug); }
}

function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isInStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function showIosPwaTip() {
  if (!isIos() || isInStandalone()) return;
  if (localStorage.getItem('mouj_ios_tip_shown')) return;
  setTimeout(() => {
    localStorage.setItem('mouj_ios_tip_shown', '1');
    $('actionSheetBody').innerHTML = `
      <h3 style="margin:0 0 12px">نصب موج روی آیفون</h3>
      <div class="muted" style="line-height:2;font-size:13px;margin-bottom:14px">
        برای استفاده مثل اپلیکیشن:
        <br>۱. در Safari روی دکمه <b>اشتراک‌گذاری</b> (□↑) بزنید
        <br>۲. گزینه <b>Add to Home Screen</b> / افزودن به صفحه اصلی را انتخاب کنید
        <br>۳. نام «موج» را تأیید و Add بزنید
      </div>
      <button class="btn" onclick="closeSheets()">متوجه شدم</button>
    `;
    openSheet(actionSheet);
  }, 2500);
}

function closeChat() {
  clearInterval(poll);
  currentChat = 0;
  currentChatUser = null;
  currentConvInfo = null;
  lastId = 0;
  msgCache = {};
  clearReply();
  const btn = document.getElementById('chatEditBtn');
  if (btn) btn.remove();
  $('composer').style.display = 'flex';
  $('messages').innerHTML = '';
  show('home');
  loadChats();
}


function clearReply() {
  replyToMsg = null;
  const bar = $('replyBar');
  if (bar) bar.classList.remove('on');
}
function setReply(m) {
  replyToMsg = m;
  $('replyBarBody').textContent = 'پاسخ: ' + (m.body || 'پیام').slice(0, 60);
  $('replyBar').classList.add('on');
  $('messageInput').focus();
}
if ($('replyBarClose')) $('replyBarClose').onclick = clearReply;


function messageLink(mid) {
  const base = (typeof SITE_URL !== 'undefined' && SITE_URL) ? SITE_URL : (location.origin + location.pathname);
  return base.replace(/\/$/, '') + '#m/' + mid;
}

async function openMessageById(mid) {
  mid = parseInt(mid, 10);
  if (!mid) return;
  showLoader('در حال باز کردن پیام…');
  try {
    let r = await api('get_message', { message_id: mid });
    if (!r.ok) { toast(r.error === 'forbidden' ? 'به این گفتگو دسترسی ندارید' : 'پیام پیدا نشد'); return; }
    const cid = r.message.conversation_id;
    const conv = r.conversation || {};
    if (conv.type === 'private') {
      // پیدا کردن طرف مقابل
      let chats = await api('chats', { q: '' });
      const hit = (chats.chats || []).find(c => c.conversation_id === cid && c.user);
      if (hit && hit.user) await openChat(hit.user.id);
      else await openGroupChat(cid, conv.title || 'گفتگو');
    } else {
      await openGroupChat(cid, conv.title || 'گفتگو');
    }
    // صبر برای رندر و اسکرول
    setTimeout(() => highlightMessage(mid), 400);
  } catch (e) { toast('خطا'); }
  finally { hideLoader(); }
}

function highlightMessage(mid) {
  const el = document.querySelector(`[data-mid="${mid}"]`);
  if (!el) {
    // شاید پیام قدیمی‌تر از lastId باشد — ریست و بارگذاری از قبل
    toast('پیام در این صفحه نیست — به بالا بروید');
    return;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('highlight');
  setTimeout(() => el.classList.remove('highlight'), 2500);
}

async function openForwardPicker(m) {
  showLoader('بارگذاری چت‌ها…');
  try {
    let r = await api('chats', { q: '' });
    const chats = (r.chats || []).filter(c => c.type !== 'saved');
    let contactsHtml = '';
    try {
      let cr = await api('contacts', { q: '' });
      const contacts = cr.contacts || [];
      contactsHtml = contacts.slice(0, 30).map(u => `
        <div class="row" data-uid="${u.id}">
          ${av(u)}
          <div class="mid"><div class="name">${esc(u.first_name)} ${esc(u.last_name||'')}</div>
          <div class="last">@${esc(u.username)}</div></div>
        </div>`).join('');
    } catch (e) {}
    const chatsHtml = chats.map(c => {
      if (c.type === 'private' && c.user) {
        return `<div class="row" data-cid="${c.conversation_id}" data-uid="${c.user.id}">
          ${av(c.user)}
          <div class="mid"><div class="name">${esc(c.user.first_name)} ${esc(c.user.last_name||'')}</div>
          <div class="last">چت خصوصی</div></div>
        </div>`;
      }
      return `<div class="row" data-cid="${c.conversation_id}">
        ${av({ title: c.title, id: c.conversation_id, avatar_path: c.avatar_path })}
        <div class="mid"><div class="name">${c.type==='channel'?'📢 ':''}${esc(c.title||'گروه')}</div>
        <div class="last">${c.slug?'@'+esc(c.slug):''}</div></div>
      </div>`;
    }).join('');
    $('actionSheetBody').innerHTML = `
      <h3 style="margin:0 0 12px">فوروارد پیام</h3>
      <div class="muted" style="margin-bottom:10px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((m.body||'').slice(0,80))}</div>
      <div class="fwd-sheet" style="max-height:50vh;overflow:auto">
        ${chatsHtml || '<div class="empty">چتی نیست</div>'}
        ${contactsHtml ? '<div class="section-label">مخاطبین</div>' + contactsHtml : ''}
      </div>
    `;
    openSheet(actionSheet);
    $('actionSheetBody').onclick = async (e) => {
      const row = e.target.closest('.row');
      if (!row) return;
      const cid = parseInt(row.dataset.cid || '0', 10);
      const uid = parseInt(row.dataset.uid || '0', 10);
      closeSheets();
      showLoader('در حال فوروارد…');
      try {
        const payload = { message_id: m.id };
        if (cid) payload.target_conversation_id = cid;
        else if (uid) payload.target_user_id = uid;
        let fr = await api('forward_message', payload);
        if (fr.ok) {
          toast('فوروارد شد ✓');
          if (fr.conversation_id) {
            // optional: open target
          }
        } else if (fr.error === 'only_admin_can_post') toast('در کانال فقط ادمین می‌تواند بفرستد');
        else toast('فوروارد ناموفق');
      } catch (err) { toast('خطا'); }
      finally { hideLoader(); }
    };
  } catch (e) { toast('خطا در بارگذاری'); }
  finally { hideLoader(); }
}

async function editMessage(m) {
  if (!m || m.sender_id != user.id || (m.msg_type || 'text') !== 'text') return;
  const next = prompt('متن جدید پیام:', m.body || '');
  if (next === null) return;
  const body = next.trim();
  if (!body) { toast('متن پیام نمی‌تواند خالی باشد'); return; }
  if (body === (m.body || '').trim()) return;
  try {
    showLoader('در حال ویرایش پیام…');
    const r = await api('edit_message', { message_id: m.id, body });
    if (!r.ok) {
      toast(r.error === 'only_text_can_be_edited' ? 'فقط پیام متنی قابل ویرایش است' : 'ویرایش ناموفق بود');
      return;
    }
    await loadMessages();
    await loadChats();
    toast('پیام ویرایش شد ✓');
  } catch (e) { toast('خطا در ویرایش پیام'); }
  finally { hideLoader(); }
}

function bindMsgActions(el, m) {
  const openMenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const menu = $('ctxMenu');
    const isMe = m.sender_id == user.id;
    menu.innerHTML = `
      <button type="button" data-a="reply">پاسخ</button>
      <button type="button" data-a="forward">فوروارد</button>
      <button type="button" data-a="link">کپی لینک پیام</button>
      ${isMe && (m.msg_type || 'text') === 'text' && !m.deleted_at ? '<button type="button" data-a="edit">ویرایش پیام</button>' : ''}
      ${isMe ? '<button type="button" data-a="del" class="danger">حذف پیام</button>' : ''}
      <button type="button" data-a="copy">کپی متن</button>
    `;
    menu.classList.add('on');
    const rect = el.getBoundingClientRect();
    const app = document.querySelector('.app').getBoundingClientRect();
    let top = rect.top - app.top - 8;
    let left = rect.left - app.left;
    if (left + 170 > app.width) left = app.width - 180;
    if (top < 60) top = rect.bottom - app.top + 4;
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    menu.onclick = async (e) => {
      const btn = e.target.closest('button[data-a]');
      if (!btn) return;
      menu.classList.remove('on');
      const a = btn.dataset.a;
      if (a === 'reply') setReply(m);
      if (a === 'forward') openForwardPicker(m);
      if (a === 'link') {
        const link = messageLink(m.id);
        try { await navigator.clipboard.writeText(link); toast('لینک پیام کپی شد'); } catch (err) { toast(link); }
      }
      if (a === 'copy') {
        try { await navigator.clipboard.writeText(m.body || ''); toast('کپی شد'); } catch (err) { toast(m.body || ''); }
      }
      if (a === 'edit') {
        editMessage(m);
      }
      if (a === 'del') {
        if (!confirm('این پیام حذف شود؟')) return;
        try {
          let r = await api('delete_message', { message_id: m.id, scope: 'everyone' });
          if (r.ok) {
            el.classList.add('deleted');
            el.querySelector('small') && (el.innerHTML = 'این پیام حذف شد' + el.querySelector('small').outerHTML);
            toast('حذف شد');
          } else toast('حذف ناموفق');
        } catch (err) { toast('خطا'); }
      }
    };
  };
  el.addEventListener('contextmenu', openMenu);
  el.addEventListener('touchstart', (e) => {
    longPressTimer = setTimeout(() => openMenu(e), 450);
  }, { passive: true });
  el.addEventListener('touchend', () => clearTimeout(longPressTimer));
  el.addEventListener('touchmove', () => clearTimeout(longPressTimer));
}
document.addEventListener('click', (e) => {
  if (!$('ctxMenu').contains(e.target)) $('ctxMenu').classList.remove('on');
});

async function togglePin(cid, pinned) {
  try {
    let r = await api('pin_chat', { conversation_id: cid, pin: !pinned });
    if (r.ok) { toast(pinned ? 'از پین خارج شد' : 'پین شد'); loadChats(); }
    else toast(r.error === 'migration_required' ? 'مایگریشن v4 لازم است' : 'خطا');
  } catch (e) { toast('خطا'); }
}

async function blockUser(uid) {
  if (!confirm('این کاربر مسدود شود؟ دیگر نمی‌تواند به شما پیام بدهد.')) return;
  try {
    let r = await api('block_user', { user_id: uid });
    if (r.ok) { toast('مسدود شد'); closeChat(); }
    else toast('خطا');
  } catch (e) { toast('خطا'); }
}

async function unblockUser(uid) {
  try {
    let r = await api('unblock_user', { user_id: uid });
    if (r.ok) { toast('رفع مسدودی'); loadSettings(); }
  } catch (e) {}
}

// ---- Web Notifications (وقتی تب باز است + درخواست مجوز Push) ----
async function enableNotifications() {
  if (!('Notification' in window)) { toast('این مرورگر نوتیفیکیشن ندارد'); return; }
  let perm = Notification.permission;
  if (perm !== 'granted') perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('مجوز نوتیفیکیشن داده نشد'); return; }
  localStorage.setItem('mouj_notify', '1');
  toast('نوتیفیکیشن فعال شد');
  // Service Worker + Push (در صورت پشتیبانی)
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      // اشتراک Push نیاز به VAPID سمت سرور دارد — فعلاً نوتیف محلی هنگام پیام جدید
      await api('save_push_subscription', {
        endpoint: 'local-' + (user && user.id),
        keys: { p256dh: 'local', auth: 'local' }
      }).catch(() => {});
    } catch (e) {}
  }
}

function notifyNewMessage(title, body) {
  if (localStorage.getItem('mouj_notify') !== '1') return;
  if (document.visibilityState === 'visible') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title || 'موج', { body: body || 'پیام جدید', icon: 'icon-192.png', tag: 'mouj-msg' }); } catch (e) {}
}


function startMsgPoll() {
  clearInterval(poll);
  const ms = document.visibilityState === 'hidden' ? 8000 : 1800;
  poll = setInterval(loadMessages, ms);
}
document.addEventListener('visibilitychange', () => {
  if (currentChat) startMsgPoll();
  if (document.visibilityState === 'visible' && currentChat) loadMessages();
});

async function loadMessages() {
  if (!currentChat) return;
  try {
    msgPollCount++;
    // هر چند دور یک‌بار از کمی عقب‌تر بخوان تا تیک «سین» آپدیت شود
    let after = lastId;
    if (msgPollCount % 4 === 0 && lastId > 0) {
      after = Math.max(0, lastId - 30);
    }
    let r = await api('messages', { conversation_id: currentChat, after_id: after });
    if (r.messages && r.messages.length) {
      let box = $('messages');
      for (const m of r.messages) {
        const existingMsg = document.querySelector(`[data-mid="${m.id}"]`);
        if (existingMsg) {
          const oldEdited = existingMsg.dataset.edited || '';
          if (m.edited_at && m.edited_at !== oldEdited) {
            lastId = 0;
            msgCache = {};
            $('messages').innerHTML = '';
            setTimeout(loadMessages, 0);
            break;
          }
          const el = existingMsg.querySelector('.ticks');
          if (el && m.status) el.innerHTML = m.status === 'seen' ? '✓✓' : '✓';
          if (el && m.status === 'seen') el.classList.add('seen');
          lastId = Math.max(lastId, Number(m.id));
          continue;
        }
        // decrypt text body if encrypted
        let displayBody = m.body || '';
        if (displayBody.startsWith(CRYPTO_PREFIX)) {
          const peer = (m.sender_id == user.id) ? peerIdForCurrentChat() : m.sender_id;
          displayBody = await decryptBody(displayBody, currentChat, peer);
          m._plain = displayBody;
        }
        let d = document.createElement('div');
        d.className = 'bubble ' + (m.sender_id == user.id ? 'me' : '');
        d.dataset.mid = m.id;
        msgCache[m.id] = m;
        let content = '';
        if (m.reply_to_id && msgCache[m.reply_to_id]) {
          const rm = msgCache[m.reply_to_id];
          const rb = rm._plain || rm.body || '';
          content += `<div class="reply-quote">${esc(String(rb).startsWith(CRYPTO_PREFIX) ? 'پیام رمزنگاری‌شده' : String(rb).slice(0, 80))}</div>`;
        } else if (m.reply_to_id) {
          content += `<div class="reply-quote">پاسخ به پیام</div>`;
        }
        const mt = m.msg_type || 'text';
        const stickerKey = (typeof displayBody === 'string' && displayBody.startsWith('svg:')) ? displayBody.slice(4) : (mt === 'sticker' && displayBody && !m.file_path ? displayBody : '');
        if (stickerKey && stickerSvg(stickerKey)) {
          content += `<div class="sticker-msg">${stickerSvg(stickerKey)}</div>`;
          d.classList.add('sticker-bubble');
        } else if (m.file_path && mt !== 'text') {
          content += `<div class="msg-media" id="mm-${m.id}">${renderMediaBlock(m)}</div>`;
        }
        const isDefaultCap = /^(📷 عکس|🎬 ویدیو|استیکر|📎 فایل|این پیام حذف شد)$/.test(displayBody || '');
        const isSvgSticker = !!(stickerKey && stickerSvg(stickerKey));
        if (!isSvgSticker && displayBody && !(mt !== 'text' && isDefaultCap)) {
          content += linkifyText(displayBody);
        } else if (!isSvgSticker && mt === 'text') {
          content += linkifyText(displayBody || '');
        }
        if (displayBody === 'این پیام حذف شد' || m.body === 'این پیام حذف شد') d.classList.add('deleted');
        const ticks = (m.sender_id == user.id)
          ? `<span class="ticks ${m.status === 'seen' ? 'seen' : ''}">${m.status === 'seen' ? '✓✓' : '✓'}</span>`
          : '';
        d.dataset.edited = m.edited_at || '';
        d.innerHTML = content + '<small>' + ticks +
          new Date(m.created_at.replace(' ', 'T')).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) +
          (m.edited_at ? ' · ویرایش شد' : '') +
          '</small>';
        box.appendChild(d);
        bindMsgActions(d, m);
        const dlTile = d.querySelector('.media-tile[data-dl="1"]');
        if (dlTile) bindMediaDownload(dlTile, m);
        d.querySelectorAll('.vm-wrap').forEach(bindVideoMessage);
        lastId = Math.max(lastId, Number(m.id));
      }
      box.scrollTop = box.scrollHeight;
      const newest = r.messages[r.messages.length - 1];
      if (newest && newest.sender_id != user.id && document.visibilityState !== 'visible') {
        notifyNewMessage(newest.first_name || 'موج', newest.body || 'پیام جدید');
      }
    }
    // نمایش پیام ثابت برای چت خصوصی با حساب حذف‌شده
    const deletedFooter = $('deletedAccountFooter');
    if (deletedFooter) deletedFooter.remove();
    if (currentConvInfo && currentConvInfo.type === 'private' && currentConvInfo.deleted_account) {
      const f = document.createElement('div');
      f.id = 'deletedAccountFooter';
      f.className = 'deleted-account-footer';
      f.textContent = 'این اکانت حذف شده است';
      $('messages').appendChild(f);
      $('messages').scrollTop = $('messages').scrollHeight;
    }
    // typing indicator
    const tb = $('typingBar');
    if (tb) {
      if (r.typing && r.typing.length) {
        const names = r.typing.map(t => t.first_name).join('، ');
        tb.textContent = names + ' در حال نوشتن…';
      } else {
        tb.textContent = '';
      }
    }
  } catch (e) {}
}

let typingTimer = null;
function notifyTyping() {
  if (!currentChat) return;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    api('typing', { conversation_id: currentChat }).catch(() => {});
  }, 400);
}

$('messageInput').addEventListener('input', notifyTyping);

$('attachBtn').onclick = () => {
  $('actionSheetBody').innerHTML = `
    <h3 style="margin:0 0 12px">ارسال رسانه</h3>
    <div class="sheet-item" id="pickPhoto"><div class="sheet-icon">🖼️</div><div><b>عکس</b><span>ارسال تصویر</span></div></div>
    <div class="sheet-item" id="pickVideo"><div class="sheet-icon">🎬</div><div><b>ویدیو</b><span>ارسال فیلم</span></div></div>
    <div class="sheet-item" id="pickFile"><div class="sheet-icon">📎</div><div><b>فایل</b><span>سند، zip و …</span></div></div>
    <div class="sheet-item" id="pickSticker"><div class="sheet-icon">😊</div><div><b>استیکر</b><span>استیکرهای آماده</span></div></div>
  `;
  openSheet(actionSheet);
  $('pickPhoto').onclick = () => { closeSheets(); $('fileInput').accept = 'image/*'; $('fileInput').dataset.msgType = 'image'; $('fileInput').click(); };
  $('pickVideo').onclick = () => { closeSheets(); $('fileInput').accept = 'video/*'; $('fileInput').dataset.msgType = 'video'; $('fileInput').click(); };
  $('pickFile').onclick = () => { closeSheets(); $('fileInput').accept = '.pdf,.zip,.doc,.docx,.txt,audio/*,*/*'; $('fileInput').dataset.msgType = 'file'; $('fileInput').click(); };
  $('pickSticker').onclick = () => { closeSheets(); openStickerPicker(); };
};

$('fileInput').onchange = async () => {
  const files = [...($('fileInput').files || [])];
  $('fileInput').value = '';
  if (!files.length || !currentChat) return;
  const msgType = $('fileInput').dataset.msgType || 'file';
  for (const f of files) {
    await sendMedia(f, msgType);
  }
};

function uploadWithProgress(fd, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try { resolve(JSON.parse(xhr.responseText)); }
      catch (e) { reject(e); }
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.send(fd);
  });
}

async function sendMedia(file, msgType) {
  if (!currentChat) return;
  const box = $('messages');
  const tempId = 'tmp' + Date.now() + Math.random().toString(36).slice(2, 7);
  const localUrl = (msgType === 'image' || msgType === 'video') ? URL.createObjectURL(file) : null;
  const d = document.createElement('div');
  d.className = 'bubble me';
  let inner;
  if (msgType === 'image') {
    inner = `<div class="media-wrap" id="uw-${tempId}"><img class="media" src="${localUrl}"><div class="upload-overlay"><div class="progress-ring" id="pr-${tempId}"><span id="pt-${tempId}">0%</span></div></div></div>`;
  } else if (msgType === 'video') {
    inner = `<div class="media-wrap" id="uw-${tempId}"><video class="media-video" src="${localUrl}" muted></video><div class="upload-overlay"><div class="progress-ring" id="pr-${tempId}"><span id="pt-${tempId}">0%</span></div></div></div>`;
  } else {
    inner = `<div class="media-tile" style="cursor:default">
      <div class="progress-ring" id="pr-${tempId}"><span id="pt-${tempId}">0%</span></div>
      <div class="mt-info"><div class="mt-name">${esc(file.name)}</div><div class="mt-sub">${formatBytes(file.size)} · در حال ارسال…</div></div>
    </div>`;
  }
  d.innerHTML = inner + '<small>در حال ارسال…</small>';
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;

  try {
    const fd = new FormData();
    fd.append('action', 'send_message');
    fd.append('conversation_id', String(currentChat));
    fd.append('msg_type', msgType);
    fd.append('body', '');
    if (replyToMsg) fd.append('reply_to_id', String(replyToMsg.id));
    fd.append('file', file);
    const r = await uploadWithProgress(fd, (p) => {
      const ring = document.getElementById('pr-' + tempId);
      const span = document.getElementById('pt-' + tempId);
      if (ring) ring.style.setProperty('--p', p);
      if (span) span.textContent = p + '%';
    });
    d.remove();
    if (r.ok) {
      clearReply();
      // فایل رو همین الان محلی داریم، نیازی به دانلود دوباره برای خودمان نیست
      if (localUrl && r.message && r.message.file_path) mediaBlobCache[r.message.file_path] = localUrl;
      else if (localUrl) URL.revokeObjectURL(localUrl);
      await loadMessages();
    } else {
      if (localUrl) URL.revokeObjectURL(localUrl);
      if (r.error === 'only_admin_can_post') toast('فقط ادمین کانال می‌تواند پیام بفرستد');
      else if (r.error === 'file_too_large') toast('حجم فایل زیاد است (حداکثر ۲۵ مگ)');
      else if (r.error === 'invalid_file_type') toast('نوع فایل پشتیبانی نمی‌شود');
      else if (r.error === 'migration_required') toast('ابتدا migrate_v3.sql را روی دیتابیس اجرا کنید');
      else if (r.error === 'upload_dir_not_writable' || r.error === 'upload_dir_failed') toast('پوشه uploads روی سرور قابل نوشتن نیست');
      else if (r.error === 'upload_failed' || r.error === 'server_upload_config') toast('آپلود روی سرور ناموفق بود');
      else toast('ارسال ناموفق بود' + (r.error ? ' (' + r.error + ')' : ''));
    }
  } catch (e) {
    d.remove();
    if (localUrl) URL.revokeObjectURL(localUrl);
    toast('خطا در ارسال');
  }
}

const STICKER_SVGS = {
  wave: '<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gw" x1="8" y1="8" x2="56" y2="56"><stop stop-color="#7c6cf6"/><stop offset="1" stop-color="#33d9c9"/></linearGradient></defs><circle cx="32" cy="32" r="28" fill="url(#gw)" opacity=".18"/><path d="M10 36c4-8 8-8 12 0s8 8 12 0 8-8 12 0 8 8 12 0" stroke="url(#gw)" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M10 46c4-8 8-8 12 0s8 8 12 0 8-8 12 0 8 8 12 0" stroke="url(#gw)" stroke-width="3.2" stroke-linecap="round" fill="none" opacity=".7"/></svg>',
  heart: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gh" x1="12" y1="10" x2="52" y2="54"><stop stop-color="#ff6b8a"/><stop offset="1" stop-color="#7c6cf6"/></linearGradient></defs><path d="M32 52s-18-11-22-22c-3.2-8.8 2.4-16 10-16 4.6 0 8.2 2.6 12 7.2 3.8-4.6 7.4-7.2 12-7.2 7.6 0 13.2 7.2 10 16-4 11-22 22-22 22z" fill="url(#gh)"/></svg>',
  like: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gl" x1="10" y1="10" x2="54" y2="54"><stop stop-color="#33d9c9"/><stop offset="1" stop-color="#5b7cf0"/></linearGradient></defs><path d="M26 52H14a4 4 0 01-4-4V28a4 4 0 014-4h12v28z" fill="url(#gl)" opacity=".85"/><path d="M26 24l6-12a6 6 0 016-4c3.3 0 6 2.7 6 6v6h8a6 6 0 016 7l-4 21a6 6 0 01-6 5H26V24z" fill="url(#gl)"/></svg>',
  fire: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gf" x1="20" y1="8" x2="44" y2="56"><stop stop-color="#ffb347"/><stop offset=".55" stop-color="#ff6b8a"/><stop offset="1" stop-color="#7c6cf6"/></linearGradient></defs><path d="M32 8s14 12 14 28a14 14 0 11-28 0c0-8 6-16 10-20-1 6 2 10 6 10 0-8 4-14-2-18z" fill="url(#gf)"/><path d="M32 36c0 6 4 10 0 14 8 0 12-6 12-12 0-6-4-10-6-12-1 4-2 6-6 10z" fill="#fff" opacity=".35"/></svg>',
  star: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gs" x1="12" y1="10" x2="52" y2="54"><stop stop-color="#f0c14b"/><stop offset="1" stop-color="#33d9c9"/></linearGradient></defs><path d="M32 8l6.5 13.8 15.2 1.7-11.4 10.2 3.3 14.9L32 40.8 18.4 48.6l3.3-14.9L10.3 23.5l15.2-1.7L32 8z" fill="url(#gs)"/></svg>',
  party: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gp" x1="10" y1="14" x2="54" y2="52"><stop stop-color="#7c6cf6"/><stop offset="1" stop-color="#33d9c9"/></linearGradient></defs><path d="M18 48l8-28 22 22-30 6z" fill="url(#gp)"/><circle cx="44" cy="16" r="3" fill="#ff6b8a"/><circle cx="52" cy="28" r="2.5" fill="#f0c14b"/><circle cx="36" cy="12" r="2.2" fill="#33d9c9"/><path d="M40 20l8-8M48 24l8 2M42 28l10 6" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".7"/></svg>',
  check: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gc" x1="10" y1="10" x2="54" y2="54"><stop stop-color="#33d9c9"/><stop offset="1" stop-color="#7c6cf6"/></linearGradient></defs><circle cx="32" cy="32" r="24" fill="url(#gc)"/><path d="M20 33l8 8 16-16" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  cool: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="go" x1="12" y1="10" x2="52" y2="54"><stop stop-color="#5b7cf0"/><stop offset="1" stop-color="#33d9c9"/></linearGradient></defs><circle cx="32" cy="32" r="24" fill="url(#go)"/><rect x="14" y="26" width="36" height="10" rx="5" fill="#1a1430"/><circle cx="24" cy="31" r="3.5" fill="#33d9c9"/><circle cx="40" cy="31" r="3.5" fill="#33d9c9"/><path d="M24 42c3 3 13 3 16 0" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg>',
  rocket: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gr" x1="18" y1="8" x2="46" y2="56"><stop stop-color="#7c6cf6"/><stop offset="1" stop-color="#33d9c9"/></linearGradient></defs><path d="M32 8c10 10 14 22 12 34H20C18 30 22 18 32 8z" fill="url(#gr)"/><circle cx="32" cy="28" r="5" fill="#fff" opacity=".85"/><path d="M20 42l-6 10 10-4M44 42l6 10-10-4" fill="#ff6b8a"/><path d="M26 48c2 6 10 6 12 0" stroke="#f0c14b" stroke-width="3" stroke-linecap="round" fill="none"/></svg>',
  spark: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gk" x1="12" y1="12" x2="52" y2="52"><stop stop-color="#f0c14b"/><stop offset="1" stop-color="#7c6cf6"/></linearGradient></defs><path d="M32 6l3 14 14 3-14 3-3 14-3-14-14-3 14-3 3-14z" fill="url(#gk)"/><path d="M50 38l1.5 7 7 1.5-7 1.5-1.5 7-1.5-7-7-1.5 7-1.5 1.5-7z" fill="#33d9c9"/></svg>',
  clap: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="ga" x1="12" y1="14" x2="52" y2="52"><stop stop-color="#ffb347"/><stop offset="1" stop-color="#ff6b8a"/></linearGradient></defs><path d="M18 30l8-10 6 5-4 8h16l6-6 5 5-7 16H22l-4-18z" fill="url(#ga)"/><path d="M14 22l6-4M12 30l6 0M16 38l4 4" stroke="#f0c14b" stroke-width="2.5" stroke-linecap="round"/></svg>',
  strong: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gb" x1="10" y1="12" x2="54" y2="52"><stop stop-color="#7c6cf6"/><stop offset="1" stop-color="#33d9c9"/></linearGradient></defs><path d="M22 40c-6-2-8-8-6-14 3-8 12-10 18-6l2 2c2-6 10-8 16-4 4 3 5 9 2 14l-8 14c-2 4-6 6-10 6H28c-4 0-6-2-6-6v-6z" fill="url(#gb)"/><circle cx="44" cy="22" r="4" fill="#fff" opacity=".5"/></svg>',
  laugh: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gj" x1="12" y1="10" x2="52" y2="54"><stop stop-color="#f0c14b"/><stop offset="1" stop-color="#ff6b8a"/></linearGradient></defs><circle cx="32" cy="32" r="24" fill="url(#gj)"/><path d="M20 28c2-4 6-4 8 0M36 28c2-4 6-4 8 0" stroke="#1a1430" stroke-width="3" stroke-linecap="round" fill="none"/><path d="M20 36c4 10 20 10 24 0" fill="#1a1430"/><path d="M24 38h16" stroke="#fff" stroke-width="2" opacity=".35"/></svg>',
  love: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="ge" x1="12" y1="10" x2="52" y2="54"><stop stop-color="#ff6b8a"/><stop offset="1" stop-color="#f0c14b"/></linearGradient></defs><circle cx="32" cy="32" r="24" fill="url(#ge)"/><path d="M22 30c0-4 3-7 7-7 2.2 0 4 1 5 2.6 1-1.6 2.8-2.6 5-2.6 4 0 7 3 7 7 0 8-12 14-12 14S22 38 22 30z" fill="#fff"/><path d="M22 42c3 2 7 3 10 3s7-1 10-3" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none" opacity=".7"/></svg>',
  think: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gt" x1="12" y1="10" x2="52" y2="54"><stop stop-color="#5b7cf0"/><stop offset="1" stop-color="#7c6cf6"/></linearGradient></defs><circle cx="30" cy="28" r="20" fill="url(#gt)"/><circle cx="24" cy="26" r="2.5" fill="#fff"/><circle cx="36" cy="26" r="2.5" fill="#fff"/><path d="M24 34c2 3 10 3 12 0" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none"/><circle cx="46" cy="46" r="5" fill="url(#gt)"/><circle cx="52" cy="54" r="3" fill="url(#gt)"/></svg>',
  ok: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gk2" x1="12" y1="10" x2="52" y2="54"><stop stop-color="#33d9c9"/><stop offset="1" stop-color="#5b7cf0"/></linearGradient></defs><circle cx="32" cy="32" r="24" fill="url(#gk2)"/><path d="M28 22c-6 2-8 10-4 16 3 5 10 7 16 4" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none"/><circle cx="38" cy="26" r="5" fill="#fff" opacity=".9"/><path d="M22 40c4 6 16 8 24 2" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none" opacity=".7"/></svg>',
  bounce: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gbo" x1="12" y1="10" x2="52" y2="54"><stop stop-color="#7c6cf6"/><stop offset="1" stop-color="#33d9c9"/></linearGradient></defs><circle cx="32" cy="34" r="18" fill="url(#gbo)"/><circle cx="26" cy="30" r="2.5" fill="#fff"/><circle cx="38" cy="30" r="2.5" fill="#fff"/><path d="M26 38c2 3 10 3 12 0" stroke="#fff" stroke-width="2.5" stroke-linecap="round" fill="none"/><path d="M18 14c2 4 4 4 6 0M40 12c2 4 4 4 6 0" stroke="#f0c14b" stroke-width="2.5" stroke-linecap="round"/></svg>',
  mute: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gm" x1="12" y1="10" x2="52" y2="54"><stop stop-color="#ff6b8a"/><stop offset="1" stop-color="#7c6cf6"/></linearGradient></defs><circle cx="32" cy="32" r="24" fill="url(#gm)" opacity=".9"/><path d="M22 26v12h8l10 8V18l-10 8h-8z" fill="#fff"/><path d="M44 26l8 12M52 26l-8 12" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>',
  confetti: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="12" y="12" width="8" height="8" rx="2" fill="#7c6cf6" transform="rotate(12 16 16)"/><rect x="44" y="14" width="7" height="7" rx="2" fill="#33d9c9" transform="rotate(-18 47 17)"/><rect x="30" y="8" width="6" height="6" rx="2" fill="#ff6b8a"/><rect x="18" y="40" width="7" height="7" rx="2" fill="#f0c14b" transform="rotate(20 21 43)"/><rect x="42" y="38" width="8" height="8" rx="2" fill="#5b7cf0" transform="rotate(-10 46 42)"/><circle cx="32" cy="32" r="10" fill="url(#none)" stroke="#fff" stroke-width="2"/><path d="M28 32h8M32 28v8" stroke="#7c6cf6" stroke-width="2.5" stroke-linecap="round"/></svg>',
  moon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gmo" x1="16" y1="10" x2="52" y2="54"><stop stop-color="#5b7cf0"/><stop offset="1" stop-color="#7c6cf6"/></linearGradient></defs><path d="M40 12a20 20 0 1016 28 16 16 0 11-16-28z" fill="url(#gmo)"/><circle cx="42" cy="22" r="2" fill="#fff" opacity=".5"/><circle cx="48" cy="34" r="1.5" fill="#fff" opacity=".4"/></svg>'
};
const STICKER_ORDER = ['wave','heart','like','fire','star','party','check','cool','rocket','spark','clap','strong','laugh','love','think','ok','bounce','mute','confetti','moon'];
function stickerSvg(id) {
  let svg = STICKER_SVGS[id] || '';
  if (!svg) return '';
  // یکتا کردن id گرادیان‌ها تا چند استیکر هم‌زمان با هم تداخل نکنند
  const uid = id + '_' + Math.random().toString(36).slice(2, 8);
  svg = svg.replace(/\bid="(g[a-z0-9]+)"/g, `id="$1_${uid}"`);
  svg = svg.replace(/url\(#(g[a-z0-9]+)\)/g, `url(#$1_${uid})`);
  return svg;
}
function openStickerPicker() {
  $('actionSheetBody').innerHTML = `
    <h3 style="margin:0 0 12px">استیکر SVG</h3>
    <div class="sticker-grid" id="stickerGrid">
      ${STICKER_ORDER.map(id => `<button type="button" data-s="${id}" title="${id}">${stickerSvg(id)}</button>`).join('')}
    </div>
  `;
  openSheet(actionSheet);
  $('stickerGrid').onclick = async (e) => {
    const btn = e.target.closest('button[data-s]');
    if (!btn || !currentChat) return;
    closeSheets();
    const body = 'svg:' + btn.dataset.s;
    try {
      let r = await api('send_message', { conversation_id: currentChat, body, msg_type: 'sticker' });
      if (r.ok) await loadMessages();
      else toast('ارسال ناموفق');
    } catch (err) { toast('خطا'); }
  };
}

// ---- E2E message encryption (AES-GCM + ECDH P-256) ----
const CRYPTO_PREFIX = 'ENC1:';
let _cryptoReady = null;
let _privKey = null;
let _pubJwk = null;
const _peerKeyCache = {};
const _sharedKeyCache = {};

function cryptoStorageKey(uid) {
  return 'mouj_crypto_priv_' + uid;
}

async function ensureCryptoIdentity() {
  if (!user || !user.id) return false;
  if (_privKey && _pubJwk) return true;
  if (_cryptoReady) return _cryptoReady;
  _cryptoReady = (async () => {
    try {
      if (!window.crypto?.subtle) return false;
      const sk = cryptoStorageKey(user.id);
      const stored = localStorage.getItem(sk);
      if (stored) {
        const jwk = JSON.parse(stored);
        _privKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
        // rebuild public from private is not direct — store both
        const pubStored = localStorage.getItem(sk + '_pub');
        if (pubStored) {
          _pubJwk = JSON.parse(pubStored);
        }
      }
      if (!_privKey || !_pubJwk) {
        const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
        _privKey = pair.privateKey;
        const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
        _pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
        localStorage.setItem(sk, JSON.stringify(privJwk));
        localStorage.setItem(sk + '_pub', JSON.stringify(_pubJwk));
      }
      // upload public key (best-effort)
      const pubStr = JSON.stringify(_pubJwk);
      api('set_crypto_key', { public_key: pubStr }).catch(() => {});
      return true;
    } catch (e) {
      console.warn('crypto init failed', e);
      return false;
    }
  })();
  return _cryptoReady;
}

async function importPeerPublic(jwkStr) {
  const jwk = typeof jwkStr === 'string' ? JSON.parse(jwkStr) : jwkStr;
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

async function getSharedAesKey(peerUserId) {
  const cacheKey = String(peerUserId);
  if (_sharedKeyCache[cacheKey]) return _sharedKeyCache[cacheKey];
  if (!_privKey) await ensureCryptoIdentity();
  if (!_privKey) return null;
  let pubStr = _peerKeyCache[cacheKey];
  if (!pubStr) {
    try {
      const r = await api('get_crypto_keys', { user_ids: [peerUserId] });
      pubStr = (r.keys || {})[cacheKey] || (r.keys || {})[peerUserId];
      if (pubStr) _peerKeyCache[cacheKey] = pubStr;
    } catch (e) { return null; }
  }
  if (!pubStr) return null;
  try {
    const peerKey = await importPeerPublic(pubStr);
    const aes = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerKey },
      _privKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    _sharedKeyCache[cacheKey] = aes;
    return aes;
  } catch (e) {
    return null;
  }
}

// Fallback symmetric key from conversation id (for groups / when peer has no key yet)
async function getConvFallbackKey(conversationId) {
  if (!_privKey) await ensureCryptoIdentity();
  const material = new TextEncoder().encode('mouj-conv-' + conversationId + '-' + (user && user.id));
  const hash = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptBody(plain, conversationId, peerUserId) {
  if (!plain || typeof plain !== 'string') return plain;
  if (plain.startsWith(CRYPTO_PREFIX) || plain.startsWith('svg:')) return plain;
  try {
    if (!window.crypto?.subtle) return plain;
    await ensureCryptoIdentity();
    let key = null;
    if (peerUserId) key = await getSharedAesKey(peerUserId);
    if (!key) key = await getConvFallbackKey(conversationId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
    const packed = new Uint8Array(iv.length + ct.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(ct), iv.length);
    let bin = '';
    packed.forEach(b => bin += String.fromCharCode(b));
    return CRYPTO_PREFIX + btoa(bin);
  } catch (e) {
    console.warn('encrypt failed', e);
    return plain;
  }
}

async function decryptBody(body, conversationId, peerUserId) {
  if (!body || typeof body !== 'string' || !body.startsWith(CRYPTO_PREFIX)) return body;
  try {
    if (!window.crypto?.subtle) return '🔒 پیام رمزنگاری‌شده';
    await ensureCryptoIdentity();
    const raw = atob(body.slice(CRYPTO_PREFIX.length));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const iv = bytes.slice(0, 12);
    const data = bytes.slice(12);
    let key = null;
    if (peerUserId) key = await getSharedAesKey(peerUserId);
    // try peer key first, then fallback
    const tryDecrypt = async (k) => {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, data);
      return new TextDecoder().decode(pt);
    };
    if (key) {
      try { return await tryDecrypt(key); } catch (e) {}
    }
    const fb = await getConvFallbackKey(conversationId);
    try { return await tryDecrypt(fb); } catch (e) {}
    // also try fallback as if we were the peer (same device multi-account edge)
    return '🔒 پیام رمزنگاری‌شده';
  } catch (e) {
    return '🔒 پیام رمزنگاری‌شده';
  }
}

function peerIdForCurrentChat() {
  if (currentChatUser && currentChatUser.id) return currentChatUser.id;
  return null;
}

// ---- Voice / Video Message recorder (WhatsApp / Telegram style) ----
function preferredMime(video=false){
  const list=video?['video/webm;codecs=vp8,opus','video/webm']:['audio/webm;codecs=opus','audio/webm','audio/mp4'];
  return list.find(x=>window.MediaRecorder&&MediaRecorder.isTypeSupported(x))||'';
}

let recCancel = false;
let recStartX = 0;
let recAnalyser = null;
let recAudioCtx = null;
let recAnimFrame = null;
let recWaveData = null;

function formatRecTime(sec) {
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return m + ':' + String(s).padStart(2, '0');
}

function stopRecorder(send = true) {
  recCancel = !send;
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

function cleanupRecUI() {
  if (recAnimFrame) cancelAnimationFrame(recAnimFrame);
  recAnimFrame = null;
  try { recAudioCtx?.close(); } catch (e) {}
  recAudioCtx = null;
  recAnalyser = null;
  const ov = $('recOverlay');
  if (ov) ov.classList.remove('on');
  const vp = $('recVideoPreview');
  if (vp) { vp.srcObject = null; }
  $('mediaModeBtn')?.classList.remove('voice-recording');
  if ($('mediaModeBtn')) {
    $('mediaModeBtn').textContent = mediaMode === 'video' ? '📷' : '🎤';
  }
  if ($('messageInput')) $('messageInput').placeholder = 'پیام بنویسید…';
  const hint = $('recHint');
  if (hint) { hint.textContent = 'برای لغو به راست بکشید ←'; hint.classList.remove('cancel'); }
  const bar = $('recSlideBar');
  if (bar) { bar.style.width = '30%'; }
  $('recSlide')?.classList.remove('cancel');
}

function drawWaveform() {
  const canvas = $('recWaveCanvas');
  if (!canvas || !recAnalyser) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const buf = new Uint8Array(recAnalyser.frequencyBinCount);
  const draw = () => {
    if (!recAnalyser) return;
    recAnimFrame = requestAnimationFrame(draw);
    recAnalyser.getByteTimeDomainData(buf);
    ctx.clearRect(0, 0, w, h);
    // background bars from level
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += Math.abs(buf[i] - 128);
    const level = Math.min(1, (sum / buf.length) / 40);
    const bars = 48;
    const gap = 2;
    const bw = (w - gap * bars) / bars;
    for (let i = 0; i < bars; i++) {
      const idx = Math.floor((i / bars) * buf.length);
      const v = Math.abs(buf[idx] - 128) / 128;
      const bh = Math.max(4, v * h * (0.5 + level));
      const x = i * (bw + gap);
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#33d9c9');
      grad.addColorStop(1, '#7c6cf6');
      ctx.fillStyle = grad;
      ctx.beginPath();
      const radius = 2;
      const y = (h - bh) / 2;
      ctx.roundRect?.(x, y, bw, bh, radius);
      if (!ctx.roundRect) {
        ctx.fillRect(x, y, bw, bh);
      } else {
        ctx.fill();
      }
    }
  };
  draw();
}

async function startRecorder(video) {
  if (!currentChat) { toast('ابتدا یک گفتگو را باز کنید'); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('مرورگر شما ضبط رسانه را پشتیبانی نمی‌کند'); return;
  }
  try {
    recorderIsVideo = video;
    recorderChunks = [];
    recCancel = false;
    recorderStream = await navigator.mediaDevices.getUserMedia(
      video
        ? { audio: true, video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } } }
        : { audio: true }
    );
    const mime = preferredMime(video);
    recorder = new MediaRecorder(recorderStream, mime ? { mimeType: mime } : undefined);
    recorderStartedAt = Date.now();
    mediaMode = video ? 'video' : 'voice';

    // UI
    const ov = $('recOverlay');
    ov.classList.add('on');
    $('recVideoBox').style.display = video ? 'block' : 'none';
    $('recVoicePanel').style.display = 'flex';
    if (video) {
      const v = $('recVideoPreview');
      v.srcObject = recorderStream;
      v.play().catch(() => {});
    }
    $('mediaModeBtn').classList.add('voice-recording');
    $('mediaModeBtn').textContent = '⏹';
    $('messageInput').placeholder = video ? 'در حال ضبط پیام ویدیویی…' : 'در حال ضبط ویس…';
    $('recTimer').textContent = '0:00';
    $('recHint').textContent = 'برای لغو به راست بکشید ←';
    $('recHint').classList.remove('cancel');

    // audio analyser for heartbeat waveform
    try {
      recAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = recAudioCtx.createMediaStreamSource(recorderStream);
      recAnalyser = recAudioCtx.createAnalyser();
      recAnalyser.fftSize = 256;
      src.connect(recAnalyser);
      drawWaveform();
    } catch (e) {}

    recorder.ondataavailable = e => { if (e.data.size) recorderChunks.push(e.data); };
    recorder.onstop = async () => {
      clearInterval(recorderTimer);
      cleanupRecUI();
      recorderStream?.getTracks().forEach(t => t.stop());
      const dur = Math.min(60, (Date.now() - recorderStartedAt) / 1000);
      const cancelled = recCancel;
      recCancel = false;
      if (cancelled || dur < 0.4) { recorder = null; return; }
      const blob = new Blob(recorderChunks, { type: recorder.mimeType || (video ? 'video/webm' : 'audio/webm') });
      const file = new File([blob], video ? 'video-message.webm' : 'voice.webm', { type: blob.type });
      await sendMedia(file, video ? 'video_message' : 'voice');
      recorder = null;
    };
    recorder.start(200);
    recorderTimer = setInterval(() => {
      const sec = (Date.now() - recorderStartedAt) / 1000;
      $('recTimer').textContent = formatRecTime(sec);
      if (sec >= 60) stopRecorder(true);
    }, 200);
  } catch (e) {
    toast('اجازه دسترسی به میکروفن/دوربین داده نشد');
    recorderStream?.getTracks().forEach(t => t.stop());
    cleanupRecUI();
  }
}

// Hold-to-record + slide right to cancel
let mediaPressTimer = null;
let recPointerId = null;

function recPointerDown(e) {
  if (e.button !== 0 && e.pointerType !== 'touch') return;
  if (recorder && recorder.state === 'recording') return;
  recStartX = e.clientX;
  recCancel = false;
  recPointerId = e.pointerId;
  try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch (err) {}
  clearTimeout(mediaPressTimer);
  mediaPressTimer = setTimeout(() => {
    if (!recorder) startRecorder(mediaMode === 'video');
  }, 220);
}

function recPointerMove(e) {
  if (!recorder || recorder.state !== 'recording') return;
  // In RTL UI, "slide right" to cancel (clientX increases)
  const dx = e.clientX - recStartX;
  const progress = Math.min(1, Math.max(0, dx / 110));
  const bar = $('recSlideBar');
  if (bar) bar.style.width = (30 + progress * 70) + '%';
  const willCancel = dx > 80;
  recCancel = willCancel;
  const hint = $('recHint');
  const slide = $('recSlide');
  if (willCancel) {
    if (hint) { hint.textContent = 'رها کنید تا لغو شود'; hint.classList.add('cancel'); }
    slide?.classList.add('cancel');
  } else {
    if (hint) { hint.textContent = 'برای لغو به راست بکشید ←'; hint.classList.remove('cancel'); }
    slide?.classList.remove('cancel');
    if (bar) bar.style.width = (30 + progress * 70) + '%';
  }
}

function recPointerUp(e) {
  clearTimeout(mediaPressTimer);
  if (recorder && recorder.state === 'recording') {
    stopRecorder(!recCancel);
    if (recCancel) toast('ضبط لغو شد');
  }
  recPointerId = null;
}

$('mediaModeBtn').onclick = (e) => {
  // short tap toggles mode only when not recording
  if (recorder && recorder.state === 'recording') return;
  // if press was long enough we already started — ignore click
};

$('mediaModeBtn').addEventListener('pointerdown', recPointerDown);
$('mediaModeBtn').addEventListener('pointermove', recPointerMove);
$('mediaModeBtn').addEventListener('pointerup', recPointerUp);
$('mediaModeBtn').addEventListener('pointercancel', recPointerUp);
// short click without hold → toggle voice/video mode
let recDidStart = false;
const _origRecDown = recPointerDown;
// track if recording actually started during this press
const _btn = $('mediaModeBtn');
_btn.addEventListener('pointerdown', () => { recDidStart = false; }, true);
// mark when startRecorder is called - patch via wrapper
const _startRec = startRecorder;
startRecorder = async function(video) {
  recDidStart = true;
  return _startRec(video);
};
_btn.addEventListener('click', (e) => {
  if (recDidStart || (recorder && recorder.state === 'recording')) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  mediaMode = mediaMode === 'voice' ? 'video' : 'voice';
  _btn.textContent = mediaMode === 'voice' ? '🎤' : '📷';
  _btn.title = mediaMode === 'voice' ? 'نگه دارید برای ویس' : 'نگه دارید برای پیام ویدیویی';
});

// Telegram-style circular video message player
function bindVideoMessage(wrap) {
  if (!wrap || wrap.dataset.bound) return;
  wrap.dataset.bound = '1';
  const video = wrap.querySelector('video');
  const prog = wrap.querySelector('.vm-prog');
  const circumference = 2 * Math.PI * 95;
  if (prog) {
    prog.style.strokeDasharray = String(circumference);
    prog.style.strokeDashoffset = String(circumference);
  }
  const update = () => {
    if (!video.duration || !prog) return;
    const p = video.currentTime / video.duration;
    prog.style.strokeDashoffset = String(circumference * (1 - p));
  };
  wrap.addEventListener('click', (e) => {
    e.stopPropagation();
    if (video.paused) {
      // pause other video messages
      document.querySelectorAll('.vm-wrap.playing video').forEach(v => { if (v !== video) { v.pause(); v.parentElement.classList.remove('playing'); } });
      video.play();
      wrap.classList.add('playing');
    } else {
      video.pause();
      wrap.classList.remove('playing');
    }
  });
  video.addEventListener('timeupdate', update);
  video.addEventListener('ended', () => {
    wrap.classList.remove('playing');
    if (prog) prog.style.strokeDashoffset = String(circumference);
    video.currentTime = 0;
  });
  video.addEventListener('pause', () => {
    if (video.currentTime < video.duration - 0.05) wrap.classList.remove('playing');
  });
}


$('composer').onsubmit = async e => {
  e.preventDefault();
  let body = $('messageInput').value.trim();
  if (!body || !currentChat) return;
  try {
    const encBody = await encryptBody(body, currentChat, peerIdForCurrentChat());
    const payload = { conversation_id: currentChat, body: encBody, msg_type: 'text' };
    if (replyToMsg) payload.reply_to_id = replyToMsg.id;
    let r = await api('send_message', payload);
    if (r.ok) { $('messageInput').value = ''; clearReply(); await loadMessages(); }
    else if (r && r.error === 'only_admin_can_post') toast('فقط ادمین کانال می‌تواند پیام بفرستد');
    else toast('ارسال پیام ناموفق بود');
  } catch (e) { toast('خطا در ارسال'); }
};

// ---- Profile modal on chat header click ----
$('chatHead').onclick = async () => {
  if (!currentChatUser) {
    if (currentConvInfo && currentConvInfo.can_edit) openEditConversation();
    return;
  }
  showLoader();
  try {
    let r = await api('user_profile', { user_id: currentChatUser.id });
    const u = r.user || currentChatUser;
    const letter = initials(u);
    const cols = colorFromString((u.id||'') + (u.first_name||''));
    $('profileModalCard').innerHTML = `
      <div class="sheet-handle"></div>
      <div class="modal-av" style="${u.avatar_path ? '' : `--av1:${cols.c1};--av2:${cols.c2};background:linear-gradient(135deg,var(--av1),var(--av2));animation:avShift 7s ease-in-out infinite alternate`}">${u.avatar_path ? `<img src="${esc(u.avatar_path)}">` : letter}</div>
      <div class="modal-name">${esc(u.first_name)} ${esc(u.last_name || '')}</div>
      <div class="modal-meta">@${esc(u.username)}<br>${u.online ? 'آنلاین' : 'آخرین بازدید ' + humanSince(u.last_seen)}</div>
      <div class="info-row"><span>نام کاربری</span><b dir="ltr">@${esc(u.username)}</b></div>
      ${u.phone ? `<div class="info-row"><span>شماره</span><b dir="ltr">${esc(u.phone)}</b></div>` : ''}
      <div class="info-row"><span>وضعیت</span><b>${u.online ? 'آنلاین' : 'آفلاین'}</b></div>
      <button class="btn" style="margin-top:12px;background:var(--glass);color:var(--text);border:1px solid var(--line)" onclick="closeProfileModal();if(currentChat)togglePin(currentChat, !!(currentConvInfo&&currentConvInfo.pinned))">پین / برداشتن پین چت</button>
      <button class="btn" style="margin-top:8px;background:rgba(255,107,138,.15);color:var(--danger);border:1px solid var(--danger)" onclick="closeProfileModal();blockUser(${u.id})">مسدود کردن</button>
      <button class="btn" style="margin-top:8px" onclick="closeProfileModal()">بستن</button>
    `;
    $('profileModal').classList.add('on');
  } catch (e) { toast('خطا در دریافت پروفایل'); }
  finally { hideLoader(); }
};
function closeProfileModal() { $('profileModal').classList.remove('on'); }
$('profileModal').onclick = e => { if (e.target === $('profileModal')) closeProfileModal(); };

function logout() {
  clearInterval(poll);
  // حذف فقط حساب فعلی از لیست
  accounts = accounts.filter(a => a.token !== token);
  localStorage.setItem('mouj_accounts', JSON.stringify(accounts));
  localStorage.removeItem('mouj_token');
  token = ''; user = null;
  if (accounts.length) {
    // سوییچ به اولین حساب باقی‌مانده
    switchAccount(0);
    toast('از حساب خارج شدید — حساب دیگر فعال شد');
  } else {
    show('phone');
    toast('از حساب خارج شدید');
  }
}


// جستجو در چت
let chatSearchTimer = null;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && currentChat) {
    e.preventDefault();
    openChatSearch();
  }
  if (e.key === 'Escape') closeChatSearch();
});
function openChatSearch() {
  $('chatSearch').classList.add('on');
  $('chatSearchResults').classList.remove('on');
  $('chatSearchResults').innerHTML = '';
  $('chatSearchInput').value = '';
  $('chatSearchInput').focus();
}
function closeChatSearch() {
  $('chatSearch').classList.remove('on');
  $('chatSearchResults').classList.remove('on');
  $('chatSearchResults').innerHTML = '';
  $('chatSearchInput').value = '';
}
if ($('chatSearchClose')) $('chatSearchClose').onclick = closeChatSearch;
if ($('chatSearchInput')) $('chatSearchInput').oninput = () => {
  clearTimeout(chatSearchTimer);
  chatSearchTimer = setTimeout(runChatSearch, 280);
};
async function runChatSearch() {
  const q = $('chatSearchInput').value.trim();
  const box = $('chatSearchResults');
  if (!currentChat || q.length < 1) {
    box.classList.remove('on');
    box.innerHTML = '';
    return;
  }
  try {
    let r = await api('search_in_chat', { conversation_id: currentChat, q });
    const list = r.messages || [];
    if (!list.length) {
      box.innerHTML = '<div class="empty" style="padding:16px">نتیجه‌ای نیست</div>';
      box.classList.add('on');
      return;
    }
    box.innerHTML = list.map(m => `
      <div class="sr-item" data-mid="${m.id}">
        <b>${new Date(m.created_at.replace(' ','T')).toLocaleString('fa-IR')}</b>
        ${esc((m.body || '').slice(0, 120))}
      </div>`).join('');
    box.classList.add('on');
    box.onclick = (e) => {
      const item = e.target.closest('.sr-item');
      if (!item) return;
      const mid = item.dataset.mid;
      closeChatSearch();
      highlightMessage(mid);
    };
  } catch (e) {
    box.innerHTML = '<div class="empty" style="padding:16px">خطا در جستجو</div>';
    box.classList.add('on');
  }
}
if ($('chatHead')) {
  $('chatHead').addEventListener('dblclick', openChatSearch);
}


// Auto login + restore contacts
(async () => {
  updateConnPill();
  // همگام‌سازی accounts با token فعلی
  if (token && !accounts.find(a => a.token === token)) {
    // ممکن است از قبل باشد
  }
  if (token) {
    showLoader('در حال ورود…');
    try {
      let r = await api('me');
      if (r.ok) {
        user = r.user;
        saveCurrentAccount();
        openHome();
        if (phoneContacts.length) await matchStoredContacts();
      } else {
        // توکن نامعتبر — حذف از لیست
        accounts = accounts.filter(a => a.token !== token);
        localStorage.setItem('mouj_accounts', JSON.stringify(accounts));
        localStorage.removeItem('mouj_token');
        token = '';
      }
    } catch (e) {}
    finally { hideLoader(); }
  } else if (accounts.length) {
    switchAccount(0);
  } else {
    handleDeepLink();
  }
})();
