"""Validate a commit-pinned GitHub ZIP before extracting into owned staging."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import zipfile

MAX_ENTRIES = 100000
MAX_EXPANDED = 1024 * 1024 * 1024
MAX_FILE = 128 * 1024 * 1024


def extract(archive, destination, commit, version):
    destination = Path(destination)
    destination.mkdir(exist_ok=False)
    expected_root = f"cocos-engine-{commit}"
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) > MAX_ENTRIES:
            raise ValueError("Archive entry limit exceeded")
        total = 0
        names = set()
        validated = []
        for entry in entries:
            name = entry.filename
            parts = PurePosixPath(name).parts
            if (not parts or parts[0] != expected_root or "\\" in name
                    or name.startswith("/") or any(p in (".", "..") for p in parts)
                    or any(re.search(r'[<>:"|?*\x00-\x1f]', p) for p in parts)
                    or any(p.endswith((".", " ")) for p in parts)
                    or any(re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", p, re.I) for p in parts)):
                raise ValueError(f"Unsafe archive path: {name}")
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError(f"Unsupported archive entry: {name}")
            relative = parts[1:]
            if not relative:
                if not entry.is_dir():
                    raise ValueError("Invalid archive root")
                continue
            key = "/".join(relative).casefold()
            if key in names:
                raise ValueError(f"Duplicate archive path: {name}")
            names.add(key)
            total += entry.file_size
            if entry.file_size > MAX_FILE or total > MAX_EXPANDED or entry.flag_bits & 1:
                raise ValueError("Archive size/encryption limit exceeded")
            validated.append((entry, destination.joinpath(*relative)))
        for entry, target in validated:
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(entry) as source, target.open("xb") as output:
                written = 0
                while chunk := source.read(1024 * 1024):
                    written += len(chunk)
                    if written > entry.file_size:
                        raise ValueError("Expanded entry exceeds declared size")
                    output.write(chunk)
                if written != entry.file_size:
                    raise ValueError("Truncated archive entry")
    package = json.loads((destination / "package.json").read_text(encoding="utf-8"))
    if package.get("version") != version:
        raise ValueError("Source package version mismatch")
    for required in ("exports", "cocos", "cc.config.json", "LICENSE.md"):
        if not (destination / required).exists():
            raise ValueError(f"Required source input missing: {required}")
    records = []
    for root, directories, files in os.walk(destination):
        directories.sort()
        for name in sorted(files):
            file = Path(root) / name
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            records.append({"path": file.relative_to(destination).as_posix(), "sha256": digest})
    records.sort(key=lambda record: record["path"])
    tree_hash = hashlib.sha256(json.dumps(records, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    return {"packageVersion": package["version"], "sourceTreeHash": tree_hash,
            "fileCount": len(records), "expandedBytes": total, "license": "MIT",
            "files": records}


if __name__ == "__main__":
    try:
        print(json.dumps(extract(*sys.argv[1:]), ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
