"""Integration-test control: a writer that does NOT take the file lock.

    python3 -I test/helpers/unlocked-writer.py some.pdf PAGE N

Imports PyMuPDF, prints "ready", waits for a line on stdin (so it starts together with
the other writer), then adds N highlights on PAGE (author "nolock"), each opened fresh
and saved incrementally as the locked writers do, but without flock. Prints
{"ok": k, "failed": m}.
"""

import json
import sys

import pymupdf

path, page, n = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
print("ready", flush=True)
sys.stdin.readline()
ok = failed = 0
for k in range(n):
    try:
        doc = pymupdf.open(path)
        pg = doc[page - 1]
        y = 792 - 720 + (6 + k) * 14  # top-left coordinates of filler line k+1
        annot = pg.add_highlight_annot(pymupdf.Rect(72, y - 10, 300, y + 4))
        annot.set_info(title="nolock")
        annot.update()
        doc.saveIncr()
        doc.close()
        ok += 1
    except Exception:  # noqa: BLE001 - a racing write may see a half-written file
        failed += 1
print(json.dumps({"ok": ok, "failed": failed}))
