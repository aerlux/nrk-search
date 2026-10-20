#!/usr/bin/env python3
"""Publish ONLY static assets. In particular, never upload the local SQLite database."""
from pathlib import Path
import shutil
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'_site'
if OUT.exists():shutil.rmtree(OUT)
OUT.mkdir()
shutil.copy2(ROOT/'index.html',OUT/'index.html')
for folder in ('assets','data'):
    shutil.copytree(ROOT/folder,OUT/folder)
(OUT/'.nojekyll').write_text('')
print('Generated safe static site:',OUT)
