const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const rows = [['Дата и время','Сотрудник','Зона / маршрут','Код','ID записи']];
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
const record={eventId:'12345678-1234-1234-1234-123456789012',scannedAt:'2026-10-16T07:30:00.000Z',employee:'Иван',route:'12',code:'00123'};
assert.equal(post([record]).inserted,1);assert.equal(rows[1][3],'00123');
assert.equal(post([record]).inserted,0);assert.equal(rows.length,2);
assert.equal(post([{...record,eventId:'22345678-1234-1234-1234-123456789012'}, {...record,code:''}]).error,'INVALID_RECORD');assert.equal(rows.length,2);
lockAvailable=false; assert.equal(post([record]).error,'BUSY');lockAvailable=true;
assert.equal(post([{...record,eventId:'32345678-1234-1234-1234-123456789012',code:'=IMPORTXML("x")'}]).inserted,1);
assert.ok(rows[2][3].startsWith("'="));
console.log('PASS: server password-free writes, idempotency, leading zeros, batch validation, locking, formula protection');

const elements = new Map();
function element(id) { if (!elements.has(id)) elements.set(id,{value:'',checked:false,style:{},addEventListener(){},replaceChildren(){},append(){},click(){}}); return elements.get(id); }
const storage = new Map();
const browser = vm.createContext({
 document:{getElementById:element,createElement:()=>({append(){}})},
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
 window:{addEventListener(){}}, navigator:{onLine:true}, crypto:require('node:crypto').webcrypto,
 setInterval(){},setTimeout,clearTimeout,AbortController,console,
 fetch:async()=>{throw Error('Network down');},atob,confirm:()=>true
});
vm.runInContext(fs.readFileSync(__dirname+'/app.js','utf8'),browser);
(async()=>{
 element('employee').value='Иван';element('route-input').value='12';
 browser.addScan('00123');
 assert.equal(JSON.parse(storage.get('sofino_scanner_v2')).records[0].sent,false);
 browser.window.SCANNER_CONFIG = {endpoint:'https://script.google.com/macros/s/TEST/exec'};
 await browser.sync();assert.equal(JSON.parse(storage.get('sofino_scanner_v2')).records[0].sent,false);
 browser.fetch=async()=>({ok:true,json:async()=>({ok:true,accepted:[]})});
 await browser.sync();assert.equal(JSON.parse(storage.get('sofino_scanner_v2')).records[0].sent,false);
 browser.fetch=async(url,options)=>({ok:true,json:async()=>({ok:true,accepted:JSON.parse(options.body).records.map(r=>r.eventId)})});
 await browser.sync();assert.equal(JSON.parse(storage.get('sofino_scanner_v2')).records[0].sent,true);
 browser.addScan('00123');assert.equal(JSON.parse(storage.get('sofino_scanner_v2')).records.length,1);
 console.log('PASS: client retains queue on network failure/missing acknowledgement, accepts confirmed IDs, preserves zeros and rejects local duplicates');
})().catch(error=>{console.error(error);process.exitCode=1;});
