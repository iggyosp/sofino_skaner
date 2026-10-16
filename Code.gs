// Google Apps Script. Секрет задаётся в свойствах скрипта, НЕ в этом файле.
function spreadsheetId_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Добавьте SPREADSHEET_ID в свойства скрипта');
  return id;
}
const SHEET_NAME = 'Сканер';
const HEADERS = ['Дата и время', 'Сотрудник', 'Зона / маршрут', 'Код', 'ID записи'];

function sheet_() {
  const sheet = SpreadsheetApp.openById(spreadsheetId_()).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Не найден лист Сканер');
  return sheet;
}

// Выполнить один раз из редактора. Не очищает существующие строки.
function setup() {
  const key = PropertiesService.getScriptProperties().getProperty('STAFF_KEY');
  if (!key || key.length < 20) throw new Error('Добавьте STAFF_KEY длиной не менее 20 символов в свойства скрипта');
  const sheet = sheet_();
  const existing = sheet.getRange(1, 1, 1, 5).getValues()[0];
  if (existing.some((value, i) => value && value !== HEADERS[i])) {
    throw new Error('Заголовки отличаются. Сначала проверьте столбцы A:E');
  }
  sheet.getRange(1, 1, 1, 5).setValues([HEADERS]);
  sheet.setFrozenRows(1);
  sheet.getRange('D:E').setNumberFormat('@');
  sheet.getRange('A:A').setNumberFormat('dd.MM.yyyy HH:mm:ss');
  SpreadsheetApp.openById(spreadsheetId_()).setSpreadsheetTimeZone('Europe/Moscow');
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return json_({ok: true, service: 'sofino-scanner', version: 1});
}

function text_(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('INVALID_RECORD');
  return value.trim();
}

// Предотвращает интерпретацию данных сотрудника или штрихкода как формулы.
function cellText_(value) { return /^[=+@\-']/.test(value) ? "'" + value : value; }

function doPost(e) {
  let lock;
  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > 100000) return json_({ok: false, error: 'INVALID_REQUEST'});
    const body = JSON.parse(raw);
    const key = PropertiesService.getScriptProperties().getProperty('STAFF_KEY');
    if (!key || key.length < 20 || body.key !== key) return json_({ok: false, error: 'UNAUTHORIZED'});
    if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 50) return json_({ok: false, error: 'INVALID_REQUEST'});
    // Validate entire batch before any mutation.
    const records = body.records.map(r => {
      const id = text_(r.eventId, 80);
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(id)) throw new Error('INVALID_RECORD');
      const date = new Date(r.scannedAt);
      if (typeof r.scannedAt !== 'string' || !Number.isFinite(date.getTime())) throw new Error('INVALID_RECORD');
      return {eventId: id, date, employee: text_(r.employee, 100), route: text_(r.route, 100), code: text_(r.code, 500)};
    });
    lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return json_({ok: false, error: 'BUSY'});
    const sheet = sheet_();
    const headers = sheet.getRange(1, 1, 1, 5).getValues()[0];
    if (HEADERS.some((h, i) => headers[i] !== h)) return json_({ok: false, error: 'RUN_SETUP'});
    const lastRow = sheet.getLastRow();
    const known = new Set(lastRow > 1 ? sheet.getRange(2, 5, lastRow - 1, 1).getValues().map(row => String(row[0])) : []);
    const rows = [];
    for (const record of records) {
      if (known.has(record.eventId)) continue;
      rows.push([record.date, cellText_(record.employee), cellText_(record.route), cellText_(record.code), record.eventId]);
      known.add(record.eventId);
    }
    if (rows.length) {
      if (lastRow + rows.length > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), lastRow + rows.length - sheet.getMaxRows());
      sheet.getRange(lastRow + 1, 4, rows.length, 2).setNumberFormat('@');
      // The idempotency ID is stored in the SAME write as the scan.
      sheet.getRange(lastRow + 1, 1, rows.length, 5).setValues(rows);
      SpreadsheetApp.flush();
    }
    return json_({ok: true, accepted: records.map(r => r.eventId), inserted: rows.length});
  } catch (error) {
    return json_({ok: false, error: error.message === 'INVALID_RECORD' ? 'INVALID_RECORD' : 'SERVER_ERROR'});
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}
