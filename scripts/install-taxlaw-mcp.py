"""Install the reviewed provider fork in its own venv; never use a floating branch."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import urllib.request
import zipfile


def main() -> None:
    if sys.version_info < (3, 11):
        raise SystemExit("Python 3.11 or newer is required on the server.")
    root = Path(__file__).resolve().parents[1]
    pin = json.loads((root / "upstreams/korean-taxlaw-mcp.json").read_text(encoding="utf-8"))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=root / ".runtime/taxlaw")
    parser.add_argument("--dev", action="store_true", help="Include upstream offline-test dependencies")
    options = parser.parse_args()
    directory = options.directory.resolve()
    release = directory / pin["commit"]
    release.mkdir(parents=True, exist_ok=True)
    archive = release / "source.zip"
    if not archive.exists():
        request = urllib.request.Request(pin["archive_url"], headers={"User-Agent": "TaxLab-reviewed-provider-installer"})
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = response.read(20 * 1024 * 1024 + 1)
        if len(payload) > 20 * 1024 * 1024:
            raise SystemExit("Upstream archive exceeds the installation budget.")
        archive.write_bytes(payload)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != pin["archive_sha256"]:
        raise SystemExit("Archive hash mismatch; refusing installation. No activation occurred.")
    source = release / "source"
    source.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if sum(e.file_size for e in entries) > 100 * 1024 * 1024 or len(entries) > 2000:
            raise SystemExit("Unreasonable upstream archive size.")
        for entry in entries:
            if entry.is_dir():
                continue
            parts = PurePosixPath(entry.filename).parts[1:]
            if not parts or any(p in (".", "..") or "\\" in p or ":" in p for p in parts):
                raise SystemExit("Unsafe path in upstream archive.")
            target = source.joinpath(*parts).resolve()
            if not target.is_relative_to(source.resolve()):
                raise SystemExit("Archive target escapes installation directory.")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(bundle.read(entry))
    # Prevent dotenv parent lookup if an upstream dependency ever enables it.
    (source / ".env").write_text("# Dedicated upstream environment; no application secrets.\n", encoding="utf-8")
    safe_names = {"PATH", "SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES"}
    env = {k: v for k, v in os.environ.items() if k.upper() in safe_names}
    env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PIP_CONFIG_FILE=os.devnull, PIP_DISABLE_PIP_VERSION_CHECK="1")

    def run(args: list[str], **kwargs):
        return subprocess.run(args, env=env, cwd=source, check=True,
                              creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0, **kwargs)

    venv = release / "venv"
    run([sys.executable, "-I", "-m", "venv", str(venv)])
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    run([str(python), "-I", "-m", "pip", "install", str(source) + ("[dev]" if options.dev else "")])
    version = run([str(python), "-I", "-c", "from korean_taxlaw_mcp import __version__; print(__version__)"], capture_output=True, text=True).stdout.strip()
    if version != pin["version"]:
        raise SystemExit("Installed provider version differs from the reviewed pin.")
    dependencies = run([str(python), "-I", "-m", "pip", "freeze"], capture_output=True, text=True).stdout
    (release / "installed-dependencies.txt").write_text(dependencies, encoding="utf-8")
    selected = {"version": version, "commit": pin["commit"], "python": str(python), "cwd": str(source)}
    pending = directory / "active.pending.json"
    pending.write_text(json.dumps(selected, indent=2) + "\n", encoding="utf-8")
    os.replace(pending, directory / "active.json")
    print("Installed reviewed tax-law MCP. Selection:", directory / "active.json")
    print("Restart the application after validation to load the selection; no service was restarted.")


if __name__ == "__main__":
    main()
