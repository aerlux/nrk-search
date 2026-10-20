#!/usr/bin/env python3
"""Build a searchable static NRK subtitle research index from authorized material.
Python stdlib only. Does not obtain an NRK catalog or crawl automatically.
"""
from __future__ import annotations
import argparse
import collections
import datetime as dt
import html
import json
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / 'work' / 'index.sqlite3'
DEFAULT_OUT = ROOT / 'data'
ID_RE = re.compile(r'^[A-Za-z]{4}\d{8}$')
TS_RE = re.compile(r'(?P<start>\d{1,3}:\d{2}:\d{2}[.,]\d{1,3}|\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(?P<end>\d{1,3}:\d{2}:\d{2}[.,]\d{1,3}|\d{2}:\d{2}[.,]\d{1,3})')
TAG_RE = re.compile(r'<[^>]+>')
WORD_RE = re.compile(r'[a-z0-9]+')
BLOCK_SIZE = 240
UA = 'NRK-Klippfinner/0.1 (user-initiated research; contact your NRK content representative)'


def fold(value: str) -> str:
    value = value.casefold().replace('æ', 'ae').replace('ø', 'o').replace('å', 'a')
    return ''.join(c for c in unicodedata.normalize('NFKD', value) if not unicodedata.combining(c))


def words(value: str) -> set[str]:
    return set(WORD_RE.findall(fold(value)))


def ms(value: str) -> int:
    parts = value.replace(',', '.').split(':')
    if len(parts) == 2:
        hours, minutes, seconds = 0, int(parts[0]), float(parts[1])
    else:
        hours, minutes, seconds = int(parts[0]), int(parts[1]), float(parts[2])
    return round((hours * 3600 + minutes * 60 + seconds) * 1000)


def parse_subtitles(content: str) -> list[tuple[int, int, str]]:
    """Parse common WebVTT/SRT cues; strip inline markup and metadata."""
    content = content.lstrip('\ufeff').replace('\r\n', '\n').replace('\r', '\n')
    result = []
    seen = set()
    for block in re.split(r'\n\s*\n', content):
        lines = block.strip().split('\n')
        if not lines or lines[0].startswith(('NOTE', 'STYLE', 'REGION', 'WEBVTT')) and not any('-->' in x for x in lines):
            continue
        ix = next((i for i, x in enumerate(lines) if '-->' in x), -1)
        if ix < 0:
            continue
        m = TS_RE.search(lines[ix])
        if not m:
            continue
        start, end = ms(m.group('start')), ms(m.group('end'))
        if start < 0 or end <= start:
            continue
        raw = '\n'.join(lines[ix + 1:])
        raw = re.sub(r'\{\\[^}]+\}', '', raw)  # SRT styling
        clean = html.unescape(TAG_RE.sub('', raw))
        clean = re.sub(r'\s+', ' ', clean).strip(' -\t')
        if not clean:
            continue
        key = (start, end, clean)
        if key not in seen:
            result.append(key)
            seen.add(key)
    return sorted(result, key=lambda x: (x[0], x[1]))


def windows(cues: list[tuple[int, int, str]]) -> list[tuple[int, int, str]]:
    """Create readable ~10s search snippets; keep exact source cue range."""
    if not cues:
        return []
    result = []
    start = end = None
    buf = []
    for s, e, text in cues:
        if buf and (e - start > 11000 or len(' '.join(buf)) + len(text) > 240 or s - end > 4500):
            result.append((start, end, ' '.join(buf)))
            start = end = None
            buf = []
        if start is None:
            start = s
        end = max(end or e, e)
        if not buf or buf[-1] != text:
            buf.append(text)
    if buf:
        result.append((start, end, ' '.join(buf)))
    return result


def connect(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute('PRAGMA foreign_keys=ON')
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS programs (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'import', updated TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS segments (
          id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT NOT NULL,
          start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL,
          FOREIGN KEY(program_id) REFERENCES programs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_segments_program ON segments(program_id);
    ''')
    return conn


def import_cues(conn, pid: str, title: str, url: str, content: str, source='file'):
    cues = parse_subtitles(content)
    chunks = windows(cues)
    if not chunks:
        raise ValueError('Fant ingen gyldige undertekstlinjer i VTT/SRT.')
    with conn:
        conn.execute('INSERT OR REPLACE INTO programs (id,title,url,source,updated) VALUES (?,?,?,?,?)',
                     (pid, title.strip() or pid, url, source, dt.datetime.now(dt.timezone.utc).isoformat()))
        conn.execute('DELETE FROM segments WHERE program_id=?', (pid,))
        conn.executemany('INSERT INTO segments(program_id,start_ms,end_ms,text) VALUES (?,?,?,?)',
                         ((pid, s, e, t) for s, e, t in chunks))
    return len(cues), len(chunks)


def fetch(url, max_bytes=12_000_000):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json, text/vtt, */*'})
    with urllib.request.urlopen(req, timeout=18) as r:
        body = r.read(max_bytes + 1)
        if len(body) > max_bytes:
            raise ValueError('Svar større enn satt grense')
        return body.decode('utf-8-sig', errors='replace')


def title_from_metadata(data, pid):
    def dig(obj, *keys):
        for k in keys:
            obj = obj.get(k, {}) if isinstance(obj, dict) else {}
        return obj if isinstance(obj, str) else ''
    candidates = [dig(data, 'preplay', 'titles', 'title'), dig(data, 'preplay', 'titles', 'subtitle'),
                  dig(data, 'titles', 'title'), dig(data, 'title')]
    return next((v for v in candidates if v.strip()), pid)


def import_nrk(conn, pid: str, title=''):
    if not ID_RE.fullmatch(pid):
        raise ValueError(f'Ugyldig NRK-program-ID: {pid}')
    base = 'https://psapi.nrk.no/playback/'
    manifest = json.loads(fetch(base + 'manifest/program/' + pid))
    subs = (manifest.get('playable') or {}).get('subtitles') or []
    subs = [s for s in subs if s.get('webVtt') and s.get('type') == 'ttv'] + [s for s in subs if s.get('webVtt') and s.get('type') != 'ttv']
    if not subs:
        raise ValueError('Ingen WebVTT-undertekst tilgjengelig i manifestet.')
    suburl = subs[0]['webVtt']
    p = urllib.parse.urlparse(suburl)
    if p.scheme != 'https' or not p.hostname or p.username or p.password:
        raise ValueError('Uventet URL for undertekster (krever HTTPS).')
    # Only domains controlled by NRK and the known delivery CDN can be fetched.
    host = p.hostname.lower()
    if not (host == 'nrk.no' or host.endswith('.nrk.no') or host.endswith('.nrkcdn.no') or host.endswith('.akamaized.net')):
        raise ValueError(f'Ukjent undertekstvert: {host} – last i stedet ned filen manuelt.')
    if not title:
        try:
            title = title_from_metadata(json.loads(fetch(base + 'metadata/program/' + pid)), pid)
        except (ValueError, urllib.error.URLError, KeyError):
            title = pid
    return import_cues(conn, pid, title, 'https://tv.nrk.no/program/' + pid, fetch(suburl), 'nrk')


def program_id(value):
    value = value.strip()
    if ID_RE.fullmatch(value):
        return value.upper()
    p = urllib.parse.urlparse(value)
    if p.scheme not in {'https', 'http'} or (p.hostname or '').lower() not in {'tv.nrk.no', 'tv.nrksuper.no'}:
        raise ValueError('Bruk program-ID eller NRK TV-URL med program-ID.')
    match = re.search(r'(?<![A-Za-z0-9])([A-Za-z]{4}\d{8})(?![A-Za-z0-9])', p.path)
    if not match:
        raise ValueError('Fant ingen 12-tegns program-ID i lenken (bruk lenke til episode, ikke serie).')
    return match.group(1).upper()


def build(conn, dest: Path):
    """Generate deterministic two-character-token-sharded posting lists."""
    dest.mkdir(parents=True, exist_ok=True)
    indexdir, chunkdir = dest / 'index', dest / 'chunks'
    indexdir.mkdir(exist_ok=True)
    chunkdir.mkdir(exist_ok=True)
    for folder in (indexdir, chunkdir):
        for old in folder.glob('*.json'):
            old.unlink()
    programs = [dict(id=a, title=b, url=c) for a, b, c in conn.execute('SELECT id,title,url FROM programs ORDER BY id')]
    program_nums = {p['id']: i for i, p in enumerate(programs)}
    postings = collections.defaultdict(lambda: collections.defaultdict(list))
    batch = []
    count = 0
    for pid, s, e, txt in conn.execute('SELECT program_id,start_ms,end_ms,text FROM segments ORDER BY program_id,start_ms,id'):
        doc = count
        batch.append([doc, program_nums[pid], s, e, txt])
        for token in words(txt):
            if len(token) >= 2:
                postings[token[:2]][token].append(doc)
        count += 1
        if len(batch) == BLOCK_SIZE:
            (chunkdir / f'{doc // BLOCK_SIZE}.json').write_text(json.dumps(batch, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            batch = []
    if batch:
        (chunkdir / f'{(count - 1) // BLOCK_SIZE}.json').write_text(json.dumps(batch, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    for prefix, terms in postings.items():
        (indexdir / f'{prefix}.json').write_text(json.dumps(terms, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    (dest / 'programs.json').write_text(json.dumps(programs, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    manifest = {'version': 1, 'programs': len(programs), 'segments': count, 'blockSize': BLOCK_SIZE,
                'generated': dt.datetime.now(dt.timezone.utc).isoformat(), 'prefixShards': len(postings)}
    (dest / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return manifest


def main(argv=None):
    p = argparse.ArgumentParser(description='NRK Klippfinner – indekser undertekster med tillatt tilgang.')
    p.add_argument('--db', type=Path, default=DEFAULT_DB, help='SQLite database, aldri publisert automatisk')
    sub = p.add_subparsers(dest='cmd', required=True)
    a = sub.add_parser('add-file', help='Legg til egne VTT/SRT-undertekster')
    a.add_argument('file', type=Path)
    a.add_argument('--id', required=True, help='NRK episode-ID (eller egen unik ID)')
    a.add_argument('--title', required=True)
    a.add_argument('--url', default='', help='Original NRK-lenke')
    b = sub.add_parser('add-nrk', help='Hent tekst for konkret NRK-episode – ikke bulk crawl')
    b.add_argument('program', help='Episode-ID eller NRK TV-URL')
    b.add_argument('--title', default='')
    l = sub.add_parser('add-list', help='Ta inn en håndplukket liste av NRK-episode-URL-er')
    l.add_argument('file', type=Path)
    l.add_argument('--limit', type=int, default=20)
    l.add_argument('--delay', type=float, default=2.0)
    e = sub.add_parser('export', help='Lag statisk søkeindeks for GitHub Pages')
    e.add_argument('--output', type=Path, default=DEFAULT_OUT)
    sub.add_parser('stats', help='Se hvor mye som er indeksert')
    d = sub.add_parser('remove', help='Slett et indeksert program')
    d.add_argument('id')
    args = p.parse_args(argv)
    if args.cmd == 'add-list' and (args.delay < 1 or args.limit < 1):
        p.error('Krever --delay >= 1 og --limit >= 1 (skånsom bruk).')
    conn = connect(args.db)
    try:
        if args.cmd == 'add-file':
            if not args.file.is_file():
                raise ValueError(f'Filen finnes ikke: {args.file}')
            count = import_cues(conn, args.id, args.title, args.url or (f'https://tv.nrk.no/program/{args.id}' if ID_RE.fullmatch(args.id) else ''), args.file.read_text(encoding='utf-8-sig'))
            print(f'Lagt til {args.id}: {count[0]} undertekstlinjer / {count[1]} søkeblokker')
        elif args.cmd == 'add-nrk':
            pid = program_id(args.program)
            count = import_nrk(conn, pid, args.title)
            print(f'Lagt til {pid}: {count[0]} undertekstlinjer / {count[1]} søkeblokker')
        elif args.cmd == 'add-list':
            urls = [s.strip() for s in args.file.read_text(encoding='utf-8').splitlines() if s.strip() and not s.lstrip().startswith('#')]
            if len(urls) > args.limit:
                print(f'Bruker de {args.limit} første av {len(urls)} URL-er (endring med --limit).')
            done, failed = 0, 0
            for n, item in enumerate(urls[:args.limit]):
                if n:
                    time.sleep(args.delay)
                try:
                    pid = program_id(item)
                    line_count, _ = import_nrk(conn, pid)
                    done += 1
                    print(f'OK  {pid}: {line_count} linjer')
                except (ValueError, KeyError, urllib.error.URLError, TimeoutError) as ex:
                    failed += 1
                    print(f'FEIL {item}: {ex}', file=sys.stderr)
                    if isinstance(ex, urllib.error.HTTPError) and ex.code in (429, 403):
                        print('Stopper av hensyn til tilgangsbegrensninger.', file=sys.stderr)
                        break
            print(f'Fullført: {done} ok, {failed} feil.')
        elif args.cmd == 'export':
            print('Eksport:', json.dumps(build(conn, args.output), ensure_ascii=False))
        elif args.cmd == 'stats':
            print(f'Programmer: {conn.execute("SELECT count(*) FROM programs").fetchone()[0]}')
            print(f'Søkeblokker: {conn.execute("SELECT count(*) FROM segments").fetchone()[0]}')
            for pid, title, n in conn.execute('SELECT p.id, p.title, count(s.id) FROM programs p LEFT JOIN segments s ON p.id=s.program_id GROUP BY p.id ORDER BY p.id'):
                print(f'  {pid:12} {n:5}  {title}')
        elif args.cmd == 'remove':
            with conn:
                conn.execute('DELETE FROM programs WHERE id=?', (args.id,))
            print('Fjernet hvis funnet:', args.id)
    except (ValueError, urllib.error.URLError, sqlite3.Error) as ex:
        print(f'Feil: {ex}', file=sys.stderr)
        return 1
    finally:
        conn.close()
    return 0

if __name__ == '__main__':
    sys.exit(main())
