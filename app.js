'use strict';
const $ = id => document.getElementById(id);
const STORAGE = 'sofino_scanner_v2';
let state = {records: [], employee: '', route: ''};
let storageReady = true, busy = false, scanner = null, audio = null, torch = false;
let heldCode = '', heldAt = 0;
function status(message, error = false) {
  $('status-display').textContent = message;
  $('status-display').style.color = error ? '#ff8178' : '#63e695';
}
try {
  const raw = localStorage.getItem(STORAGE);
  if (raw) {
    const loaded = JSON.parse(raw);
    if (!loaded || !Array.isArray(loaded.records) || loaded.records.some(r => !r || typeof r.eventId !== 'string' || typeof r.code !== 'string')) throw Error();
    state = {...state, ...loaded};
  }
  localStorage.setItem('sofino_storage_test', '1');
  localStorage.removeItem('sofino_storage_test');
} catch {
  storageReady = false;
  status('Хранилище недоступно или повреждено. Не очищайте данные браузера; обратитесь к руководителю.', true);
}
function persist() {
  if (!storageReady) return false;
  try { localStorage.setItem(STORAGE, JSON.stringify(state)); return true; }
  catch { storageReady = false; status('Не удалось сохранить запись. Сканирование остановлено. Выгрузите резервную копию.', true); return false; }
}
$('employee').value = state.employee;
$('route-input').value = state.route;
for (const [input, key] of [['employee','employee'], ['route-input','route']]) {
  $(input).addEventListener('change', () => { state[key] = $(input).value.trim(); persist(); render(); });
}
function render() {
  const pending = state.records.filter(r => !r.sent).length;
  $('queue').textContent = `На телефоне: ${state.records.length} · Ожидают отправки: ${pending}`;
  $('sync').disabled = busy || !pending || !storageReady;
  $('sync').textContent = busy ? 'Отправка…' : 'Отправить сейчас';
  const list = $('history-box'); list.replaceChildren();
  for (const r of state.records.filter(r => r.route === $('route-input').value.trim()).slice(-100).reverse()) {
    const item = document.createElement('div'); item.className = 'history-item';
    const label = document.createElement('b'); label.textContent = r.code;
    const detail = document.createElement('small');
    detail.textContent = `${r.employee} · ${new Date(r.scannedAt).toLocaleString('ru-RU')} · ${r.sent ? 'В таблице' : 'Ожидает'}`;
    item.append(label, detail); list.append(item);
  }
}
function initAudio() {
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch {}
}
function beep() {
  if (!audio) return;
  const osc = audio.createOscillator(), gain = audio.createGain();
  osc.connect(gain); gain.connect(audio.destination); osc.frequency.value = 1000;
  gain.gain.setValueAtTime(0.15, audio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + .12);
  osc.start(); osc.stop(audio.currentTime + .12);
}
function addScan(raw) { return saveScan(raw); }
function saveScan(raw, numericCode = null) {
  if (!storageReady) return;
  const employee = $('employee').value.trim(), route = $('route-input').value.trim();
  if (!employee || !route) { status('Укажите ФИО и местоположение.', true); return; }
  if (typeof raw !== 'string' || raw.length > 4000) { status('Слишком длинный код.', true); return; }
  const rawCode = raw;
  let code = numericCode === null ? raw.trim() : numericCode;
  if (numericCode === null && window.SCANNER_CONFIG?.decodeMartinkevich) {
    const parts = code.split(':'); if (parts.length > 2) code = parts[2];
    code = decodeBarcodeToNumeric(code);
  }
  if (!code || code.length > 500) { status('Пустой или слишком длинный код.', true); return; }
  // Suppress continuous readings while the same label remains in view.
  const now = Date.now(), same = heldCode === code && now - heldAt < 2000;
  heldCode = code; heldAt = now;
  if (same) return;
  if (state.records.some(r => r.route === route && r.code === code)) { status('Уже отсканирован здесь: ' + code, true); return; }
  const record = {eventId: crypto.randomUUID(), scannedAt: new Date().toISOString(), employee, route, code, rawCode, sent: false};
  state.employee = employee; state.route = route; state.records.push(record);
  if (!persist()) { render(); return; }
  beep(); if (navigator.vibrate) navigator.vibrate(50);
  status('Сохранено на телефоне: ' + code); render(); sync();
}
async function sync() {
  if (busy || !storageReady || !state.records.some(r => !r.sent)) return;
  const endpoint = (window.SCANNER_CONFIG?.endpoint || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(endpoint)) {
    status('Записи сохранены на телефоне. Подключение таблицы ещё не завершено.', true); return;
  }
  if (!navigator.onLine) { status('Нет сети. Записи ждут отправки на этом телефоне.', true); return; }
  busy = true; render();
  try {
    const probeController = new AbortController();
    const probeTimeout = setTimeout(() => probeController.abort(), 20000);
    try {
      const response = await fetch(endpoint, {credentials:'omit', signal:probeController.signal});
      const service = await response.json();
      if (!response.ok || service.version !== 2) throw Error('Нужно обновить обработчик Google для сохранения исходного кода');
    } finally { clearTimeout(probeTimeout); }
    while (state.records.some(r => !r.sent)) {
      const batch = state.records.filter(r => !r.sent).slice(0, 10);
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 45000);
      let result;
      try {
        // text/plain avoids a preflight request. Never use no-cors: an opaque response is NOT an acknowledgement.
        const response = await fetch(endpoint, {method:'POST', redirect:'follow', credentials:'omit', headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify({records:batch}), signal:controller.signal});
        if (!response.ok) throw Error('Сервер недоступен');
        result = await response.json();
      } finally { clearTimeout(timeout); }
      if (!result.ok) {
        const errors = {RUN_SETUP:'Выполните setup в Apps Script', BUSY:'Таблица занята — повторим позже', INVALID_RECORD:'Ошибка формата записи'};
        throw Error(errors[result.error] || 'Ошибка обработчика Google');
      }
      if (!Array.isArray(result.accepted) || !batch.every(r => result.accepted.includes(r.eventId))) throw Error('Нет подтверждения всех записей');
      const ids = new Set(batch.map(r => r.eventId));
      state.records.forEach(r => { if (ids.has(r.eventId)) r.sent = true; });
      if (!persist()) break;
      render();
    }
    if (storageReady) status('Все записи подтверждены Google Таблицей.');
  } catch (error) {
    status(`Записи остаются в очереди. ${error.name === 'AbortError' ? 'Ответ не получен вовремя' : error.message}.`, true);
  } finally { busy = false; render(); }
}
$('start').onclick = async () => {
  if (!storageReady) return;
  if (!$('employee').value.trim() || !$('route-input').value.trim()) { status('Сначала укажите ФИО и местоположение.', true); return; }
  initAudio(); $('start').disabled = true;
  try {
    if (!window.Html5Qrcode) throw Error('Не загрузилась библиотека сканера. Проверьте интернет и обновите страницу.');
    scanner ||= new Html5Qrcode('reader');
    await scanner.start({facingMode:'environment'}, {fps:15, qrbox:(w,h) => ({width:Math.min(250,w*.8), height:Math.min(250,h*.8)})}, addScan);
    $('stop').disabled = false;
    const track = document.querySelector('#reader video')?.srcObject?.getVideoTracks()[0];
    $('torch').hidden = !track?.getCapabilities?.().torch;
    status('Камера включена. Наведите её на код.');
  } catch(error) { $('start').disabled = false; status('Камера недоступна. Проверьте разрешение и HTTPS. ' + error.message, true); }
};
$('stop').onclick = async () => {
  try { await scanner.stop(); $('start').disabled = false; $('stop').disabled = true; $('torch').hidden = true; torch = false; }
  catch { status('Не удалось остановить камеру.', true); }
};
$('torch').onclick = async () => {
  try { await scanner.applyVideoConstraints({advanced:[{torch:!torch}]}); torch = !torch; }
  catch { status('Фонарик недоступен на этом устройстве.', true); }
};
// A 40-bit ID plus a zero suffix byte produces 8 Base64 characters.
// The suffix cannot be recovered from the ID; this is a canonical NEW code.
function encodeNumericToBarcode(value) {
  const digits = value.trim();
  if (!/^[0-9]{1,13}$/.test(digits)) throw Error('Введите целое неотрицательное число, только цифры.');
  let number = BigInt(digits);
  if (number > 1099511627775n) throw Error('Максимальный номер: 1099511627775.');
  const bytes = new Uint8Array(6);
  for (let i = 4; i >= 0; i--) { bytes[i] = Number(number % 256n); number /= 256n; }
  return '*' + btoa(String.fromCharCode(...bytes));
}
$('manual-form').onsubmit = event => {
  event.preventDefault();
  try {
    const input = $('numeric-code').value.trim();
    const encoded = encodeNumericToBarcode(input);
    $('generated-code').value = encoded;
    // D keeps the entered number (including leading zeroes); E gets the new code.
    saveScan(encoded, input);
  } catch (error) { $('generated-code').value = ''; status(error.message, true); }
};
$('sync').onclick = sync;
$('backup').onclick = () => {
  const blob = new Blob([JSON.stringify({exportedAt:new Date().toISOString(), records:state.records, legacy:localStorage.getItem('scanner_routes')}, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'sofino-scans.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
};
$('clear').onclick = () => {
  if (busy) { status('Дождитесь окончания отправки.', true); return; }
  if (!storageReady || !confirm('Удалить с телефона только подтверждённые записи? После этого их коды можно сканировать повторно. Данные в таблице останутся.')) return;
  const old = state.records;
  state.records = old.filter(r => !r.sent);
  if (!persist()) state.records = old;
  heldCode = ''; render();
};
window.addEventListener('online', sync);
// One active tab per origin; avoids stale tabs overwriting the same queue.
window.addEventListener('storage', e => {
  if (e.key === STORAGE) { storageReady = false; status('Данные изменены в другой вкладке. Закройте эту вкладку и работайте в одной.', true); render(); }
});
setInterval(sync, 30000);
render();

// Original Martinkevich decoder; optional pending validation on real labels.
    function decodeBarcodeToNumeric(text) {
        let clean = text.trim();
        
        // Очищаем от возможных префиксов сканера
        if (clean.includes('-*-')) {
            clean = clean.split('-*-')[1];
        } else if (clean.startsWith('*')) {
            clean = clean.substring(1);
        }
        
        // Убираем случайные пробелы внутри кода
        clean = clean.replace(/\s+/g, '');

        // Если это уже чистые цифры, декодировать не нужно
        if (/^\d+$/.test(clean)) {
            return clean;
        }

        // Карта перевода русской раскладки клавиатуры в английскую (QWERTY)
        const rusToEng = {
            'Й':'Q', 'Ц':'W', 'У':'E', 'К':'R', 'Е':'T', 'Н':'Y', 'Г':'U', 'Ш':'I', 'Щ':'O', 'З':'P', 'Х':'[', 'Ъ':']',
            'Ф':'A', 'Ы':'S', 'В':'D', 'А':'F', 'П':'G', 'Р':'H', 'О':'J', 'Л':'K', 'Д':'L', 'Ж':';', 'Э':'\'',
            'Я':'Z', 'Ч':'X', 'С':'C', 'М':'V', 'И':'B', 'Т':'N', 'Ь':'M', 'Б':',', 'Ю':'.',
            'й':'q', 'ц':'w', 'у':'e', 'к':'r', 'е':'t', 'н':'y', 'г':'u', 'ш':'i', 'щ':'o', 'з':'p', 'х':'[', 'ъ':']',
            'ф':'a', 'ы':'s', 'в':'d', 'а':'f', 'п':'g', 'р':'h', 'о':'j', 'л':'k', 'д':'l', 'ж':';', 'э':'\'',
            'я':'z', 'ч':'x', 'с':'c', 'м':'v', 'и':'b', 'т':'n', 'ь':'m', 'б':',', 'ю':'.'
        };
        
        let latinStr = "";
        for (let i = 0; i < clean.length; i++) {
            let char = clean.charAt(i);
            latinStr += rusToEng[char] || char;
        }

        // Оставляем только валидные символы Base64
        latinStr = latinStr.replace(/[^A-Za-z0-9+/]/g, '');
        if (latinStr.length < 8) return text; // Если код слишком короткий, возвращаем как есть

        try {
            // Декодируем строку Base64 в бинарный вид
            let binaryString = atob(latinStr);
            if (binaryString.length < 5) return text;

            // Восстанавливаем числовой ID из первых 5 байт (Big-Endian математика)
            let numericId = 0;
            for (let i = 0; i < 5; i++) {
                numericId = (numericId * 256) + binaryString.charCodeAt(i);
            }
            return numericId.toString();
        } catch (e) {
            console.error("Ошибка декодирования Base64:", e);
            return text; // В случае сбоя оставляем оригинальный текст
        }
    }

