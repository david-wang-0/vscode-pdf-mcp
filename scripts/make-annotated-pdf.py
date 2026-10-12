"""Development helper: a 3-page PDF with a PyMuPDF underline, a Text note, an internal
link and an external link, written the way pdf-reader-writer-mcp writes (incremental).

    python3 -I scripts/make-annotated-pdf.py out.pdf      (needs pymupdf)
"""

import sys

import pymupdf

out = sys.argv[1]
doc = pymupdf.open()
for n in range(1, 4):
    page = doc.new_page()
    page.insert_text((72, 90), f"Page {n} of the test document", fontsize=18)
    page.insert_text((72, 130), "Reachability of timed automata is decidable via regions.", fontsize=11)
    page.insert_text((72, 146), "This sentence is hyphen-", fontsize=11)
    page.insert_text((72, 162), "ated across two lines, and see Section 3 for more.", fontsize=11)
    page.insert_text((72, 200), "External: https://example.org/", fontsize=11)
doc.save(out)
doc.close()

doc = pymupdf.open(out)
p1 = doc[0]
quads = p1.search_for("Reachability of timed automata")
annot = p1.add_underline_annot(quads)
annot.set_colors(stroke=(0.2, 0.4, 1.0))
annot.set_info(title="llm", content="An underline written by PyMuPDF.")
annot.update()
note = p1.add_text_annot((40, 126), "A margin note written by PyMuPDF.")
note.set_info(title="llm")
note.update()
r = p1.search_for("Section 3")[0]
p1.insert_link({"kind": pymupdf.LINK_GOTO, "from": r, "page": 2, "to": pymupdf.Point(72, 72)})
r = p1.search_for("https://example.org/")[0]
p1.insert_link({"kind": pymupdf.LINK_URI, "from": r, "uri": "https://example.org/"})
doc.saveIncr()
doc.close()
