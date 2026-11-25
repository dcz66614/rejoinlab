#!/usr/bin/env python3
"""P031 RejoinLab: faithful .md -> .docx conversion (verbatim, no rewording).

P031 difference vs P030: the .md files use "# " markdown heading markers
(e.g. "## 6. ...", "# P031 RejoinLab..."). convert() strips a leading run of
"# " from a line before style detection; verify() compares against the
same stripped lines, so the docx text equals the md text minus heading
markers only. All other content is verbatim.

Rules:
- Content is verbatim: concatenating all .docx paragraph texts (in order)
  must equal the concatenation of all non-empty .md lines (in order).
- Numbered section lines become Heading 1/2/3 by depth. For long section
  lines (>40 chars), the heading is the section number + title up to the
  first "。" or "：" within the first 30 chars; the remainder becomes a
  Normal body paragraph. Short numbered lines are headings in full.
- The file's first line and the document title lines become Title / Heading 1.
- Lines starting with "Tnnn：" or "Rnn：" keep verbatim text; only the
  "Tnnn：" / "Rnn：" prefix run is bolded for navigation.
"""
import re
from docx import Document

H1 = re.compile(r'^\d{1,2}\.\s+\S')
H2 = re.compile(r'^\d{1,2}\.\d{1,2}\s+\S')
H3 = re.compile(r'^\d{1,2}\.\d{1,2}\.\d{1,2}\s+\S')
PREFIX = re.compile(r'^(T\d{3}|R\d{2})：')


def split_heading(line):
    """Return (heading_text, body_text_or_None) for a numbered section line."""
    if len(line) <= 40:
        return line, None
    for delim in ('。', '：'):
        idx = line.find(delim)
        if 0 < idx <= 30:
            return line[:idx + 1], line[idx + 1:]
    return line, None


def norm(line):
    # Strip markdown heading markers ("# ", "## ", "### ") for docx rendering.
    m = re.match(r'^(#{1,3})\s+(.*)$', line)
    return m.group(2) if m else line


def convert(md_path, docx_path):
    lines = [norm(l.rstrip()) for l in open(md_path, encoding='utf-8')]
    lines = [l for l in lines if l.strip()]
    doc = Document()
    first = True
    for line in lines:
        if first:
            p = doc.add_paragraph(style='Title')
            p.add_run(line)
            first = False
            continue
        if line in ('P031 RejoinLab（续流证）项目书',
                    'P031 RejoinLab（续流证）实施计划'):
            p = doc.add_paragraph(style='Heading 1')
            p.add_run(line)
            continue
        style = None
        if H3.match(line):
            style = 'Heading 3'
        elif H2.match(line):
            style = 'Heading 2'
        elif H1.match(line):
            style = 'Heading 1'
        if style:
            head, body = split_heading(line)
            p = doc.add_paragraph(style=style)
            p.add_run(head)
            if body:
                doc.add_paragraph().add_run(body)
            continue
        p = doc.add_paragraph()
        m = PREFIX.match(line)
        if m:
            p.add_run(m.group(0)).bold = True
            p.add_run(line[m.end():])
        else:
            p.add_run(line)
    doc.save(docx_path)
    return lines


def verify(md_lines, docx_path):
    doc = Document(docx_path)
    paras = [p.text for p in doc.paragraphs if p.text.strip()]
    full_md = ''.join(md_lines)
    full_docx = ''.join(paras)
    headings = [(p.style.name, p.text) for p in doc.paragraphs
                if p.style.name.startswith('Heading')]
    return paras, full_md == full_docx, headings


if __name__ == '__main__':
    jobs = [
        ('/home/hatch/workspace/p031-rejoinlab/01_project_book/PROJECT_BOOK.md',
         '/home/hatch/workspace/p031-rejoinlab/01_project_book/PROJECT_BOOK.docx'),
        ('/home/hatch/workspace/p031-rejoinlab/02_implementation_plan/IMPLEMENTATION_PLAN.md',
         '/home/hatch/workspace/p031-rejoinlab/02_implementation_plan/IMPLEMENTATION_PLAN.docx'),
    ]
    for md, dx in jobs:
        md_lines = convert(md, dx)
        paras, exact, headings = verify(md_lines, dx)
        print(f'{dx}')
        print(f'  md non-empty lines: {len(md_lines)}; docx paragraphs: {len(paras)}')
        print(f'  full-text exact match (concatenated): {exact}')
        print(f'  headings: {len(headings)}')
        for s, t in headings:
            print(f'    [{s}] {t[:60]}')
