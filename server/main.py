import asyncio
import hmac
import os
import re
from datetime import datetime, timezone
from urllib.parse import quote
from uuid import UUID

import google.auth
from google.auth.transport.requests import AuthorizedSession
import httpx
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=[os.environ["PAGES_ORIGIN"]],
                   allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"])
TYPES = list(dict.fromkeys(s.strip() for s in os.getenv("DEFECT_TYPES", "").split("|") if s.strip()))
BASE = "https://cloud-api.yandex.net/v1/disk/resources"
ROOT = "/Дефекты"
NAMES = ("01-штрихкод.jpg", "02-товар.jpg", "03-дефект.jpg")
HEAD = ["ID сотрудника", "ШК", "RID", "Склад отправления", "Фото", "Тип дефекта", "Время UTC", "ID записи"]
SHEET = "https://sheets.googleapis.com/v4/spreadsheets/" + os.environ["SHEET_ID"]


def authorize(authorization: str = Header(default="")):
    if not hmac.compare_digest(authorization.encode(), ("Bearer " + os.environ["DEVICE_KEY"]).encode()):
        raise HTTPException(401)


@app.get("/settings", dependencies=[Depends(authorize)])
def settings():
    return {"types": TYPES}


def session():
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/spreadsheets"])
    return AuthorizedSession(credentials)


def google_call(client, method, url, **kwargs):
    result = client.request(method, url, timeout=25, **kwargs)
    result.raise_for_status()
    return result.json()


def tab_info(client):
    data = google_call(client, "GET", SHEET, params={"fields": "sheets.properties(sheetId,title)"})
    return {s["properties"]["title"]: s["properties"]["sheetId"] for s in data["sheets"]}


def setup():
    with session() as client:
        tabs = tab_info(client)
        for name in ("Дефекты", "Сводная"):
            if name not in tabs:
                google_call(client, "POST", SHEET + ":batchUpdate", json={"requests": [
                    {"addSheet": {"properties": {"title": name}}}]})
        tabs = tab_info(client)
        url = SHEET + "/values/" + quote("Дефекты!A1:H1", safe="")
        existing = google_call(client, "GET", url).get("values")
        if existing and existing != [HEAD]:
            raise RuntimeError("Проверьте заголовки листа Дефекты")
        google_call(client, "PUT", url, params={"valueInputOption": "RAW"}, json={"values": [HEAD]})
        # A native pivot works independently of the spreadsheet formula locale.
        pivot = {"source": {"sheetId": tabs["Дефекты"], "startColumnIndex": 0, "endColumnIndex": 8},
                 "rows": [{"sourceColumnOffset": 5, "showTotals": False, "sortOrder": "ASCENDING"}],
                 "filterSpecs": [{"columnOffsetIndex": 5, "filterCriteria": {
                     "condition": {"type": "NOT_BLANK"}}}],
                 "values": [{"sourceColumnOffset": 1, "summarizeFunction": "COUNTA", "name": "Количество"}]}
        google_call(client, "POST", SHEET + ":batchUpdate", json={"requests": [{"updateCells": {
            "start": {"sheetId": tabs["Сводная"], "rowIndex": 0, "columnIndex": 0},
            "rows": [{"values": [{"pivotTable": pivot}]}], "fields": "pivotTable"}}]})
        # RID accepts both letters and digits, including leading zeroes.
        google_call(client, "POST", SHEET + ":batchUpdate", json={"requests": [{"repeatCell": {
            "range": {"sheetId": tab_info(client)["Дефекты"], "startRowIndex": 1,
                      "startColumnIndex": 2, "endColumnIndex": 3},
            "cell": {"userEnteredFormat": {"numberFormat": {"type": "TEXT"}}},
            "fields": "userEnteredFormat.numberFormat"}}]})


def record(employee, barcode, kind, link, event):
    # The named range has a unique name. Google applies both requests atomically,
    # including when concurrent submissions or retries reach different workers.
    marker = "report_" + event.replace("-", "")
    with session() as client:
        sheet_id = tab_info(client)["Дефекты"]
        values = [employee, barcode, "", "", link, kind, datetime.now(timezone.utc).isoformat(), event]
        batch = [{"addNamedRange": {"namedRange": {"name": marker, "range": {
            "sheetId": sheet_id, "startRowIndex": 0, "endRowIndex": 1,
            "startColumnIndex": 0, "endColumnIndex": 1}}}},
            {"appendCells": {"sheetId": sheet_id, "rows": [{"values": [
                {"userEnteredValue": {"stringValue": v}} if v else {} for v in values]}],
                "fields": "userEnteredValue"}}]
        response = client.post(SHEET + ":batchUpdate", json={"requests": batch}, timeout=25)
        if response.status_code == 400:
            check = client.get(SHEET + "/values/" + marker, timeout=20)
            if check.ok:
                return
        response.raise_for_status()


async def store_photos(folder, images):
    async with httpx.AsyncClient(timeout=35) as client:
        auth = {"Authorization": "OAuth " + os.environ["YANDEX_TOKEN"]}
        path = ""
        for component in folder.strip("/").split("/"):
            path += "/" + component
            result = await client.put(BASE, params={"path": path}, headers=auth)
            if result.status_code != 409 or result.json().get("error") != "DiskPathPointsToExistentDirectoryError":
                result.raise_for_status()

        async def upload(name, image):
            target = folder + "/" + name
            ticket = await client.get(BASE + "/upload", params={"path": target, "overwrite": "true"}, headers=auth)
            ticket.raise_for_status()
            uploaded = await client.put(ticket.json()["href"], content=image, headers={"Content-Type": "image/jpeg"})
            uploaded.raise_for_status()
        await asyncio.gather(*(upload(n, b) for n, b in zip(NAMES, images)))


@app.post("/reports", dependencies=[Depends(authorize)])
async def report(employee: str = Form(), barcode: str = Form(), kind: str = Form(""),
                 request_id: UUID = Form(), photos: list[UploadFile] = File()):
    if not re.fullmatch(r"[0-9A-Za-zА-Яа-яЁё_-]{1,32}", employee) or not re.fullmatch(r"[0-9]{1,64}", barcode):
        raise HTTPException(422, "Некорректный ID или ШК")
    if len(photos) != 3 or (kind and kind not in TYPES):
        raise HTTPException(422, "Проверьте тип и количество фото")
    images = [await photo.read(2_000_001) for photo in photos]
    if any(len(image) > 2_000_000 or not image.startswith(b'\xff\xd8\xff') or not image.endswith(b'\xff\xd9') for image in images):
        raise HTTPException(422, "Ожидается JPEG до 2 МБ")
    event = str(request_id)
    folder = f"{ROOT}/{barcode}_{employee}/{event}"
    await store_photos(folder, images)
    link = "https://disk.yandex.ru/client/disk" + quote(folder)
    await asyncio.to_thread(record, employee, barcode, kind, link, event)
    return {"saved": True}


if __name__ == "__main__":
    setup()
