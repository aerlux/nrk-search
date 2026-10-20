import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('idx', Path(__file__).resolve().parents[1] / 'tools' / 'indexer.py')
idx = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(idx)

SAMPLE = '''WEBVTT

00:00:01.200 --> 00:00:04.500 align:start position:0%
<v Taleren>Hva er <b>ekte</b>?</v>

00:00:04.600 --> 00:00:08.000
Det handler om tro &amp; håp.

00:00:12.000 --> 00:00:15.000
Et annet spørsmål.
'''

class IndexerTests(unittest.TestCase):
    def test_parse_webvtt(self):
        rows=idx.parse_subtitles(SAMPLE)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0], (1200, 4500, 'Hva er ekte?'))
        self.assertEqual(rows[1][2], 'Det handler om tro & håp.')

    def test_srt(self):
        data='1\n00:01:02,012 --> 00:01:05,700\nHei <i>verden</i>\n'
        self.assertEqual(idx.parse_subtitles(data)[0], (62012,65700,'Hei verden'))

    def test_programid(self):
        self.assertEqual(idx.program_id('https://tv.nrk.no/serie/der-ingen-skulle-tru-at-nokon-kunne-bu/sesong/23/episode/DVFJ65100124'), 'DVFJ65100124')
        with self.assertRaises(ValueError):idx.program_id('https://attacker.example/DVFJ65100124')

    def test_static_export_and_reimport(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            conn=idx.connect(root/'test.db')
            n=idx.import_cues(conn,'DVFJ65100124','Eksempel','https://tv.nrk.no/program/DVFJ65100124',SAMPLE)
            self.assertEqual(n[0],3)
            m=idx.build(conn,root/'data')
            self.assertEqual(m['programs'],1)
            self.assertGreater(m['segments'],0)
            self.assertTrue((root/'data/index/ek.json').exists())
            posts=json.loads((root/'data/index/ek.json').read_text())
            self.assertIn('ekte',posts)
            chunks=json.loads((root/'data/chunks/0.json').read_text())
            self.assertEqual(chunks[0][2],1200)
            idx.import_cues(conn,'DVFJ65100124','Endret','',SAMPLE)
            self.assertEqual(conn.execute('select count(*) from programs').fetchone()[0],1)
            self.assertEqual(conn.execute('select count(*) from segments').fetchone()[0],m['segments'])
            conn.close()

    def test_normalize(self):
        self.assertEqual(idx.fold('Ærlig, ÅREVIS og ØYEBLIKK'), 'aerlig, arevis og oyeblikk')
        self.assertIn('aerlig',idx.words('Ærlig'))

if __name__=='__main__': unittest.main()
