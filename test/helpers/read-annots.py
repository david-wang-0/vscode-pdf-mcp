"""Integration-test helper: every annotation of a PDF as JSON, read with PyMuPDF.

    python3 -I test/helpers/read-annots.py some.pdf
prints {"repaired": bool, "annots": [{page, xref, subtype, author, contents, irt,
quads, color, nm}, ...]}; `quads` is the number of /QuadPoints quads (0 if none), `nm`
the /NM ("" if none).
"""

import json
import sys

import pymupdf

MARKUP = (pymupdf.PDF_ANNOT_HIGHLIGHT, pymupdf.PDF_ANNOT_UNDERLINE,
          pymupdf.PDF_ANNOT_SQUIGGLY, pymupdf.PDF_ANNOT_STRIKE_OUT)

doc = pymupdf.open(sys.argv[1])
out = []
for n, page in enumerate(doc, start=1):
    for a in page.annots():
        verts = a.vertices or []
        stroke = a.colors.get("stroke") or None
        out.append({
            "page": n,
            "xref": a.xref,
            "subtype": a.type[1],
            "author": a.info.get("title", ""),
            "contents": a.info.get("content", ""),
            "irt": a.irt_xref,
            "quads": len(verts) // 4 if a.type[0] in MARKUP else 0,
            "color": [round(c, 3) for c in stroke] if stroke else None,
            "nm": a.info.get("id", ""),
        })
print(json.dumps({"repaired": bool(doc.is_repaired), "annots": out}))
