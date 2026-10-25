"""AI dispatcher: Gemini writes a radio briefing for a finished simulation, ElevenLabs reads it aloud.

Keys stay on the server (backend/.env.local), never in the browser:
    GEMINI_API_KEY        https://aistudio.google.com/apikey
    ELEVENLABS_API_KEY    https://elevenlabs.io/app/settings/api-keys
Without a key the route answers 503 and the frontend falls back to its own
briefing text and the browser's built-in voice.
"""

import json
import os
import urllib.error
import urllib.request

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

router = APIRouter(prefix="/dispatch", tags=["dispatch"])

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128"

SYSTEM_PROMPT = """You are the incident commander's dispatcher on an emergency radio channel.
You get the results of a computer simulation of a disaster as JSON. Write the briefing you would
read out to all units: under 90 words, plain spoken English, no markdown, lists or emoji.
Start with "All units, simulated incident" and the place. Cover how fast and which way it is
spreading, what it reaches and when, and what crews should do (name the real stations given),
and who should evacuate. Use only the facts given; never invent street names or numbers.
The wind speed is not how fast the hazard moves: describe spread with the areas and reach
distances. Round times to whole hours ("about seven hours in") and shorten station names
("Station 4"). Compass directions are where it is heading or where the station is."""


class BriefingRequest(BaseModel):
    facts: dict = Field(description="Simulation summary built by the frontend (lib/sim/briefing.ts)")


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1200)


def _post(url: str, headers: dict, body: dict) -> bytes:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **headers}
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.read()
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"Upstream error {e.code}: {e.read()[:300].decode(errors='replace')}")
    except urllib.error.URLError as e:
        raise HTTPException(502, f"Upstream unreachable: {e.reason}")
    except TimeoutError:
        raise HTTPException(504, "Upstream timed out")


@router.get("/status")
def status():
    """Which services are configured, so the UI can label where the briefing came from."""
    return {"gemini": bool(os.getenv("GEMINI_API_KEY")), "elevenlabs": bool(os.getenv("ELEVENLABS_API_KEY"))}


@router.post("/briefing")
def briefing(data: BriefingRequest):
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise HTTPException(503, "GEMINI_API_KEY is not set")
    facts = json.dumps(data.facts)
    if len(facts) > 6000:
        raise HTTPException(413, "facts too large")
    # Flash-lite answers in a few seconds; the bigger Flash models took 15-60 s (October 2026).
    model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
    out = json.loads(
        _post(
            GEMINI_URL.format(model=model),
            {"x-goog-api-key": key},
            {
                "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [{"text": facts}]}],
                "generationConfig": {"temperature": 0.4},
            },
        )
    )
    parts = (out.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    text = " ".join(p["text"] for p in parts if "text" in p and not p.get("thought")).strip()
    if not text:
        raise HTTPException(502, "Gemini returned no text")
    return {"text": text, "source": "gemini", "model": model}


@router.post("/speech")
def speech(data: SpeechRequest):
    key = os.getenv("ELEVENLABS_API_KEY")
    if not key:
        raise HTTPException(503, "ELEVENLABS_API_KEY is not set")
    # Default voice: "George", one of ElevenLabs' premade voices.
    voice = os.getenv("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
    audio = _post(
        ELEVENLABS_URL.format(voice=voice),
        {"xi-api-key": key, "Accept": "audio/mpeg"},
        {"text": data.text, "model_id": os.getenv("ELEVENLABS_MODEL", "eleven_flash_v2_5")},
    )
    return Response(audio, media_type="audio/mpeg")
