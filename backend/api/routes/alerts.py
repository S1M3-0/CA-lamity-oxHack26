"""Evacuation alerts: real SMS and phone calls through Twilio, for people pinned on the map.

Keys go in backend/.env.local (gitignored):
    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   https://console.twilio.com
    TWILIO_FROM                             your Twilio phone number, e.g. +447700900123
    PUBLIC_URL (optional)                   public https URL of this backend, so calls can play the
                                            ElevenLabs voice; without it Twilio's own voice reads the alert
On a Twilio trial you can only text and call numbers verified in the Twilio console.
"""

import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from xml.sax.saxutils import escape

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from api.routes.dispatch import synthesize

router = APIRouter(prefix="/alerts", tags=["alerts"])

# Must match SIM_PREFIX in frontend/src/lib/sim/alerts.ts. Always added server-side so a
# message that could be mistaken for a real evacuation order can never go out.
SIM_PREFIX = "SIMULATION - not a real emergency."
PHONE = re.compile(r"^\+[1-9]\d{7,14}$")
MAX_SENDS = 50  # per server run, so a stuck loop can't drain the Twilio credit

_sent = 0
_audio: dict[str, bytes] = {}


class AlertRequest(BaseModel):
    to: str = Field(description="E.164 phone number, e.g. +447700900123")
    text: str = Field(min_length=1, max_length=600)
    call: bool = False


def _twilio():
    sid, token, sender = (os.getenv(k) for k in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"))
    return (sid, token, sender) if sid and token and sender else None


def _twilio_post(sid: str, token: str, resource: str, fields: dict) -> dict:
    req = urllib.request.Request(
        f"https://api.twilio.com/2010-04-01/Accounts/{sid}/{resource}.json",
        data=urllib.parse.urlencode(fields).encode(),
        headers={"Authorization": "Basic " + base64.b64encode(f"{sid}:{token}".encode()).decode()},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as e:
        detail = json.loads(e.read() or b"{}").get("message", "")
        raise HTTPException(502, f"Twilio error {e.code}: {detail}")
    except (urllib.error.URLError, TimeoutError):
        raise HTTPException(502, "Twilio unreachable")


@router.get("/status")
def status():
    return {"twilio": _twilio() is not None, "voice": bool(os.getenv("PUBLIC_URL") and os.getenv("ELEVENLABS_API_KEY"))}


@router.post("/send")
def send(data: AlertRequest):
    global _sent
    creds = _twilio()
    if not creds:
        raise HTTPException(503, "Twilio is not configured")
    to = re.sub(r"[\s()-]", "", data.to)
    if not PHONE.match(to):
        raise HTTPException(422, "Phone number must be in international format, e.g. +447700900123")
    if _sent >= MAX_SENDS:
        raise HTTPException(429, f"Alert limit of {MAX_SENDS} reached; restart the backend to reset")
    _sent += 1

    text = data.text if data.text.startswith(SIM_PREFIX) else f"{SIM_PREFIX} {data.text}"
    sid, token, sender = creds
    result = {"sms": _twilio_post(sid, token, "Messages", {"To": to, "From": sender, "Body": text})["sid"]}

    if data.call:
        public = os.getenv("PUBLIC_URL", "").rstrip("/")
        twiml = f'<Response><Say voice="Polly.Brian">{escape(text)}</Say></Response>'
        if public and os.getenv("ELEVENLABS_API_KEY"):
            try:
                audio_id = uuid.uuid4().hex
                _audio[audio_id] = synthesize(text)
                twiml = f"<Response><Play>{escape(public)}/api/alerts/audio/{audio_id}.mp3</Play></Response>"
            except HTTPException:
                pass  # keep Twilio's own voice
        result["call"] = _twilio_post(sid, token, "Calls", {"To": to, "From": sender, "Twiml": twiml})["sid"]
    return result


@router.get("/audio/{audio_id}.mp3")
def audio(audio_id: str):
    if audio_id not in _audio:
        raise HTTPException(404, "No such recording")
    return Response(_audio[audio_id], media_type="audio/mpeg")
