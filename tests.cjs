const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const rows = [['Дата и время','Сотрудник','Зона / маршрут','Код','Исходный код','ID записи']];
let lockAvailable = true;
const sheet = {
  getRange(r,c,n=1,m=1) { return {
    getValues: () => Array.from({length:n},(_,i) => Array.from({length:m},(_,j)=>rows[r-1+i]?.[c-1+j] ?? '')),
    setValues(values) { values.forEach((row,i)=>{rows[r-1+i] ||= [];row.forEach((v,j)=>rows[r-1+i][c-1+j]=v);}); return this; },
    setNumberFormat(){return this;}
  };}, getLastRow:()=>rows.length, getMaxRows:()=>1000, insertRowsAfter(){}, setFrozenRows(){}
};
const context = vm.createContext({
  SpreadsheetApp:{openById:()=>({getSheetByName:()=>sheet}),flush(){}},
  PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'test-spreadsheet-id'})},
  ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})},
  LockService:{getScriptLock:()=>({tryLock:()=>lockAvailable,hasLock:()=>lockAvailable,releaseLock(){}})}
});
vm.runInContext(fs.readFileSync(__dirname+'/Code.gs','utf8'),context);
function post(records) { return JSON.parse(context.doPost({postData:{contents:JSON.stringify({records})}}).text); }
const record={eventId:'12345678-1234-1234-1234-123456789012',scannedAt:'2026-10-16T07:30:00.000Z',employee:'Иван',route:'12',code:'00123',rawCode:'  prefix:ABC==  '};
assert.equal(post([record]).inserted,1);assert.equal(rows[1][3],'00123');assert.equal(rows[1][4],record.rawCode);assert.equal(rows[1][5],record.eventId);
assert.equal(post([record]).inserted,0);assert.equal(rows.length,2);
assert.equal(post([{...record,eventId:'22345678-1234-1234-1234-123456789012'}, {...record,code:''}]).error,'INVALID_RECORD');assert.equal(rows.length,2);
lockAvailable=false; assert.equal(post([record]).error,'BUSY');lockAvailable=true;
assert.equal(post([{...record,eventId:'32345678-1234-1234-1234-123456789012',code:'=IMPORTXML("x")'}]).inserted,1);
assert.ok(rows[2][3].startsWith("'="));
const previousRows = rows.map(r=>r.slice());
rows.length = 0; rows.push(['Дата и время','Сотрудник','Зона / маршрут','Код','ID записи'], ['date','name','location','123','original-event-id']);
sheet.insertColumnBefore = c => rows.forEach(r => r.splice(c-1,0,''));
const book = {getSheetByName:()=>sheet,getId:()=> 'test-spreadsheet-id',setSpreadsheetTimeZone(){}};
context.SpreadsheetApp.getActiveSpreadsheet = () => book;
context.SpreadsheetApp.openById = () => book;
context.PropertiesService.getScriptProperties = () => ({getProperty:()=> 'test-spreadsheet-id',setProperty(){}});
context.LockService.getScriptLock = () => ({waitLock(){},releaseLock(){}});
context.setup(); assert.equal(rows[1][5],'original-event-id'); assert.equal(rows[1][4],''); assert.equal(rows[0][4],'Исходный код');
context.setup(); assert.equal(rows[1][5],'original-event-id');
console.log('PASS: migration preserves IDs and repeated setup is safe');
console.log('PASS: server password-free writes, idempotency, leading zeros, batch validation, locking, formula protection');

const elements = new Map();
function element(id) { if (!elements.has(id)) elements.set(id,{value:'',checked:false,style:{},addEventListener(){},replaceChildren(){},append(){},click(){}}); return elements.get(id); }
const storage = new Map();
const browser = vm.createContext({
 document:{getElementById:element,createElement:()=>({append(){}})},
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
 window:{addEventListener(){}}, navigator:{onLine:true}, crypto:require('node:crypto').webcrypto,
 setInterval(){},setTimeout,clearTimeout,AbortController,console,
 fetch:async()=>{throw Error('Network down');},atob,btoa,confirm:()=>true
});
vm.runInContext(fs.readFileSync(__dirname+'/app.js','utf8'),browser);
for (const value of ['0','1','255','256','43069882907','1099511627775']) {
  const encoded = browser.encodeNumericToBarcode(value);
  assert.equal(browser.decodeBarcodeToNumeric(encoded), value);
}
for (const value of ['-1','1.5','1e3','abc','1099511627776','']) {
  assert.throws(() => browser.encodeNumericToBarcode(value));
}
assert.equal(browser.encodeNumericToBarcode('000123'), browser.encodeNumericToBarcode('123'));
console.log('PASS: inverse round-trip, range limits and numeric validation');
(async()=>{
 element('employee').value='Иван';element('route-input').value='12';
 browser.addScan('00123');
 assert.equal(JSON.parse(storage.get('sofino_scanner_v2')).records[0].rawCode,'00123');
 assert.equal(JSON.parse(storage.get('sofino_scanner_v2')).records[0].sent,false);
 browser.window.SCANNER_CONFIG = {endpoint:'https://script.google.com/macros/s/TEST/exec'};
 await browser.sync();assert.equal(JSON.parse(storage.get('sofino_scanner_v2')).records[0].sent,false);
 browser.fetch=async()=>({ok:true,json:async()=>({ok:true,version:2,accepted:[]})});
 await browser.sync();assert.equal(JSON.parse(storage.get('sofino_scanner_v2')).records[0].sent,false);
 browser.fetch=async(url,options={})=>({ok:true,json:async()=>({ok:true,version:2,accepted:options.body ? JSON.parse(options.body).records.map(r=>r.eventId) : []})});
 await browser.sync();assert.equal(JSON.parse(storage.get('sofino_scanner_v2')).records[0].sent,true);
 browser.addScan('00123');assert.equal(JSON.parse(storage.get('sofino_scanner_v2')).records.length,1);
 browser.navigator.onLine = false;
 browser.window.SCANNER_CONFIG.decodeMartinkevich = true;
 browser.addScan(' prefix:meta:AAECAwQF ');
 const decoded = JSON.parse(storage.get('sofino_scanner_v2')).records.at(-1);
 assert.equal(decoded.code,'16909060');
 assert.equal(decoded.rawCode,' prefix:meta:AAECAwQF ');
 element('numeric-code').value = '0001234';
 browser.window.SCANNER_CONFIG.decodeMartinkevich = false;
 element('manual-form').onsubmit({preventDefault(){}});
 const manual = JSON.parse(storage.get('sofino_scanner_v2')).records.at(-1);
 assert.equal(manual.code, '0001234');
 assert.equal(manual.rawCode, browser.encodeNumericToBarcode('1234'));
 assert.equal(element('generated-code').value, manual.rawCode);
 console.log('PASS: manual entry stores number in D and generated text in E without relying on decoder setting');
 console.log('PASS: client retains queue on network failure/missing acknowledgement, accepts confirmed IDs, preserves zeros and rejects local duplicates');
})().catch(error=>{console.error(error);process.exitCode=1;});
