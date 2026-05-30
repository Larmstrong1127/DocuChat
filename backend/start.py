"""Wrapper to start uvicorn with .env loaded."""
import os
from pathlib import Path

# Load .env explicitly from this file's directory
env_path = Path(__file__).parent / ".env"
for line in env_path.read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

import uvicorn
uvicorn.run("main:app", host="0.0.0.0", port=8000, log_level="warning")
