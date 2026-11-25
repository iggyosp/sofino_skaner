'use strict';
const el = id => document.getElementById(id);
const labels = ['Штрихкод','Общий вид','Дефект'];
let stage = 0, stream, timer, generation = 0, detector, fallback, requestId, photos = [], locked = false;
let token = sessionStorage.getItem('device') || '';
let employee = sessionStorage.getItem('employee') || '';
el('employee').value = employee;
el('keyLabel').hidden = !!token;
const note = message => el('status').textContent = message;
const base = (window.API_URL || '').replace(/\/$/,'');
function stop() {
  generation++;
  clearTimeout(timer);
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  el('video').srcObject = null;
}
function clearPhotos() {
  photos.forEach(photo => URL.revokeObjectURL(photo.url));
  photos = [];
  el('barcode').value = '';
  el('barcode').disabled = el('kind').disabled = false;
  el('kind').selectedIndex = 0;
  requestId = crypto.randomUUID();
}
async function api(path, options = {}) {
  const response = await fetch(base + path, {...options, headers:{Authorization:'Bearer ' + token}, signal:AbortSignal.timeout(90000)});
  if (!response.ok) throw Error(response.status === 401 ? 'Проверьте ключ устройства.' : 'Сервер не подтвердил операцию. Проверьте связь и повторите.');
  return response.json();
}
el('enter').onsubmit = async event => {
  event.preventDefault();
  if (!base) return note('Укажите адрес сервера в config.js.');
  const submit = event.submitter;
  submit.disabled = true;
  token = el('key').value || token;
  try {
    const settings = await api('/settings');
    el('kind').replaceChildren(new Option('Пропустить',''), ...settings.types.map(v => new Option(v,v)));
    el('typeLabel').hidden = !settings.types.length;
    employee = el('employee').value.trim();
    sessionStorage.setItem('device',token);
    sessionStorage.setItem('employee',employee);
    el('login').hidden = true;
    el('work').hidden = el('change').hidden = false;
    clearPhotos();
    await show(0);
  } catch (e) {el('keyLabel').hidden = false; note(e.message);}
  finally {submit.disabled = false;}
};
function frame() {
  const video = el('video');
  if (!video.videoWidth || video.readyState < 2) throw Error('Подождите, пока появится изображение.');
  const scale = Math.min(1,1600 / Math.max(video.videoWidth,video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
  return canvas;
}
async function capture(canvas, code, epoch) {
  locked = true;
  el('primary').disabled = true;
  try {
    const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',0.78));
    if (epoch !== generation) return;
    if (!blob) throw Error('Не удалось сохранить кадр. Повторите снимок.');
    if (photos[stage]) URL.revokeObjectURL(photos[stage].url);
    photos[stage] = {blob,url:URL.createObjectURL(blob)};
    if (stage === 0) el('barcode').value = code;
    await show(stage + 1);
  } finally {locked = false; el('primary').disabled = false;}
}
function readBarcode(canvas) {
  const {width,height} = canvas;
  const pixels = canvas.getContext('2d').getImageData(0,0,width,height).data;
  const gray = new Uint8ClampedArray(width*height);
  for (let i=0,j=0; i<gray.length; i++,j+=4) {
    gray[i] = (pixels[j] + 2*pixels[j+1] + pixels[j+2]) >> 2;
  }
  const source = new ZXing.RGBLuminanceSource(gray,width,height);
  return fallback.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source))).getText();
}
async function scan(epoch) {
  if (epoch !== generation || locked) return;
  try {
    const canvas = frame();
    let code;
    if (detector) {
      try {code = (await detector.detect(canvas)).find(item => /^\d{1,64}$/.test(item.rawValue))?.rawValue;}
      catch {detector = null;}
    }
    if (!code && fallback) {
      try {code = readBarcode(canvas);} catch {}
    }
    if (/^\d{1,64}$/.test(code) && epoch === generation && !locked) return await capture(canvas,code,epoch);
  } catch {}
  if (epoch === generation) timer = setTimeout(()=>scan(epoch),240);
}
async function show(next) {
  stage = next;
  const epoch = ++generation;
  clearTimeout(timer);
  note('');
  const review = stage === 3;
  el('step').textContent = 'ID ' + employee + ' · ' + (stage+1) + ' из 4';
  el('title').textContent = review ? 'Проверка и отправка' : ['Наведите на штрихкод','Снимите товар целиком','Снимите дефект'][stage];
  el('review').hidden = !review;
  el('video').hidden = review;
  el('back').hidden = stage === 0;
  el('primary').textContent = review ? 'Отправить' : stage ? 'Сделать фото' : 'Снять ШК и ввести цифры';
  if (review) {
    stop();
    el('thumbs').replaceChildren(...photos.map((photo,i)=>{
      const figure=document.createElement('figure'), img=new Image(), caption=document.createElement('figcaption');
      img.src=photo.url; img.alt=labels[i]; caption.textContent=labels[i]; figure.append(img,caption); return figure;
    }));
    return;
  }
  if (!stream) {
    try {
      const camera = await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1600},height:{ideal:1200}}});
      if(epoch !== generation) {camera.getTracks().forEach(t=>t.stop());return;}
      stream = camera;
      el('video').srcObject = stream;
      await el('video').play();
    } catch {if(epoch===generation){stop();note('Разрешите доступ к камере в настройках браузера.');el('primary').textContent='Открыть камеру';}return;}
  }
  if (!stage && epoch === generation) {
    try {if (!detector && window.BarcodeDetector) detector = new BarcodeDetector();} catch {}
    if (!fallback && window.ZXing) fallback = new ZXing.MultiFormatReader();
    timer=setTimeout(()=>scan(epoch),250);
  }
}
el('primary').onclick = async () => {
  if (locked) return;
  try {
    if (stage < 3) {
      if (!stream) return await show(stage);
      return await capture(frame(),'',generation);
    }
    const barcode = el('barcode').value.trim();
    if (!/^\d{1,64}$/.test(barcode)) {el('barcode').focus();return note('Введите ШК цифрами.');}
    locked = true;
    el('primary').disabled = el('back').disabled = el('change').disabled = true;
    const data = new FormData();
    for (const [k,v] of Object.entries({employee,barcode,kind:el('kind').value,request_id:requestId})) data.append(k,v);
    photos.forEach((p,i)=>data.append('photos',p.blob,i+'.jpg'));
    el('back').hidden = true;
    el('barcode').disabled = el('kind').disabled = true;
    note('Отправка трёх фото…');
    await api('/reports',{method:'POST',body:data});
    clearPhotos(); await show(0); if(stream) note('Товар ' + barcode + ' сохранён. Можно сканировать следующий.');
  } catch(e) {note(e.message);}
  finally {locked=false;el('primary').disabled=el('back').disabled=el('change').disabled=false;}
};
el('back').onclick = ()=>{if(!locked) show(stage-1);};
el('change').onclick = ()=>{
  if(locked || (photos.length && !confirm('Сбросить текущую карточку?'))) return;
  stop();clearPhotos();el('work').hidden=el('change').hidden=true;el('login').hidden=false;note('');
};
window.addEventListener('pagehide',stop);
