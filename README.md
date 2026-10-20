# NRK Klippfinner

En gratis, statisk og mobilvennlig søkemotor for videoresearch. **Kan hostes på GitHub Pages uten server eller abonnement.** Søk i *materiale du har indeksert* og få undertekstutdrag, programnavn og presise tidskoder. Lagre favoritter og eksporter klippliste.

> **Omfang:** Prosjektet er ikke en fullstendig database over «alle NRKs undertekster». Verken alle programmer, et API for komplett undertekstsøk eller rettighetene til å publisere et slikt tekstarkiv er offentlig tilgjengelig uten videre. Verktøyet starter derfor med **0 ekte programmer**. Du kan importere VTT/SRT-filer direkte i nettleseren, eller legge til konkrete NRK-episoder med indekseringsskriptet. Indekser bare materiale du har lovlig tilgang til, og publiser ikke NRKs komplette tekstkorpus på GitHub Pages uten avtale med NRK.

## 🚀 Publiser på GitHub på omtrent fem trinn

1. Last ned og pakk ut prosjektet. Opprett et nytt GitHub-repository (f.eks. `nrk-klippfinner`) og last opp **alle filene**, inkludert `.github/workflows/pages.yml`, under grenen `main`.
2. Gå til **Settings → Pages → Build and deployment → Source** og velg **GitHub Actions**.
3. Åpne fanen **Actions**. Arbeidsflyten **Publiser Klippfinner (GitHub Pages)** starter normalt etter en push; ellers velg **Run workflow**.
4. Etter en vellykket publisering finner du adressen under **Settings → Pages**: typisk `https://BRUKERNAVN.github.io/nrk-klippfinner/`.
5. Gå til nettsiden, klikk **Importer undertekster**, legg inn et programnavn og velg en `.vtt` eller `.srt`-fil. Søk deretter. **Lokale importer lagres kun i den nettleseren**, ikke i GitHub-repositoriet og ikke på server.

Du kan også teste lokalt uten GitHub:

```bash
cd nrk-klippfinner
python3 -m http.server 8000
# Åpne http://localhost:8000
```

Åpning av `index.html` via `file://` støttes ikke: nettleseren må få filene fra en webserver, slik som GitHub Pages eller kommandoen over.

## Søk i et større, publisert utvalg (krever tillatelse til å publisere teksten)

Python-verktøyet bruker **bare standardbiblioteket** (Python 3.10+) og lager en statisk, søkbar indeks. Det kreves ingen database på webserveren. Eksempel med en egen VTT:

```bash
python3 tools/indexer.py add-file min-undertekst.vtt \
  --id EKSEMPEL-01 --title "Mitt intervju" \
  --url "https://tv.nrk.no/program/DVFJ65100124"

python3 tools/indexer.py stats
python3 tools/indexer.py export
python3 -m http.server 8000
```

Skriptet støtter også brukerinitiert henting av en **bestemt NRK TV-episode** fra offentlig tilgjengelige NRK-avspillingsdata, når dette er tillatt:

```bash
python3 tools/indexer.py add-nrk DVFJ65100124
# ELLER
python3 tools/indexer.py add-nrk 'https://tv.nrk.no/program/DVFJ65100124'
python3 tools/indexer.py export
```

Dette bruker det **ikke-garanterte** NRK-endepunktet `https://psapi.nrk.no/playback/manifest/program/PROGRAMID`. Fra manifestet forsøker skriptet å hente `.playable.subtitles[].webVtt`, og tittelen fra `/playback/metadata/program/PROGRAMID`. Avhengig av rettigheter, tilgjengelighet, geoblokkering og API-endringer kan henting feile. Skriptet går ikke rundt tilgangskontroll og henter ikke video.

Hvis du har en håndplukket liste over **episode-URL-er** og godkjenning til denne bruken, kan du legge én URL per linje i `mine-episoder.txt`:

```bash
python3 tools/indexer.py add-list mine-episoder.txt --limit 20 --delay 2
python3 tools/indexer.py export
```

Dette er ikke automatisk kataloghøsting. Maks antall er 20 per kjøring som standard, ventetid minst 1 sekund. Stopper ved visse tilgangsbegrensninger. Seriesider alene støttes ikke; hver oppføring må peke til en episode med en 12-tegns program-ID.

**Viktig:** Når du publiserer med `export`, blir `data/index/`, `data/chunks/` og `data/programs.json` **offentlig tilgjengelige**. Indeksen inneholder originalt undertekstinnhold. Ikke commit/publiser slike data uten at NRK og eventuelle øvrige rettighetshavere har tillatt det. Ved intern research kan du bruke lokal nettleserimport og la `data/` stå tom.

### Oppdater nettsiden med nye data

Etter `export` kopierer du eller committer endringene i `data/` til GitHub. GitHub Actions publiserer automatisk. Den lokale SQLite-filen lagres i `work/index.sqlite3`, er utelatt fra git og er **ikke** en del av webdeployen. Behold den lokalt dersom du vil legge til mer over tid. `export` bygger indeksen på nytt fra den lokale databasen.

### Slett program

```bash
python3 tools/indexer.py remove DVFJ65100124
python3 tools/indexer.py export
```

## Hva får du?

- Ord- og prefikssøk («tro» matcher også «troen»), flere ord i samme treff, valg for eksakt frase og filter på programtittel.
- Treffer i korte tekstblokker (omtrent 10 sekunder) med start- og sluttid, lenke til originalprogram og kopierbar kildeinformasjon.
- Stjernemerk/favoritter og CSV-eksport som kan brukes i din egen produksjonslogg.
- Lokal import av WebVTT (`.vtt`) og SubRip (`.srt`) med IndexedDB. De lokalt importerte filene kan søkes sammen med en publisert indeks.
- Innebygd demonstrasjon med **oppdiktede tekster** – disse er **ikke NRK-materiale**.
- En skalerbar, enkel statisk indeks: tokenfordelte posting-lister (`data/index/ab.json`) og dokumentblokker (`data/chunks/0.json`, `1.json`, osv.). Det er ingen sentral søketjeneste å drifte.
- Mobilvennlig design, ingen cookies/innlogging/analyseskript og ingen eksterne JavaScript-biblioteker.

### Begrensninger

- Søket er **ordbasert**, ikke semantisk AI-søk. Søker du «hjertesorg», er det ikke sikkert du får treff på «hun var knust». Det kan videreutvikles med semantiske embedding-indekser når rettigheter/datagrunnlag er avklart.
- Bare de **første 350** relevante indeksresultatene vises i ett søk (av hensyn til ressursbruk), og brede søk kan analysere bare et begrenset antall kandidater. Bruk lengre uttrykk eller programfilter for presisjon.
- Et ord som krysser grensen mellom to tekstblokker kan bli oversett; dette er ikke en komplett ordrett transkripsjonstjeneste.
- Link-knappen åpner programmet i NRK TV. Vi har ikke bekreftet en stabil NRK TV-syntaks for direkteavspilling på tidskoden, derfor vises tidskoden separat; spol manuelt til tidspunktet.
- Lokal lagring følger nettleseren/enheten. Tømmer du nettsteddata, forsvinner lokale importer og favoritter. Eksporter favoritter jevnlig.
- GitHub Pages sin statiske hosting er god for mindre og mellomstore indekser. Et søk i **alt** NRK-innhold ville trenge en klarert datakilde, indeksinfrastruktur og avtaler som ikke følger med her.

## Opphavsrett og klippbruk

**Dette er et researchverktøy, ikke en generell klipplisens.** At et program er tilgjengelig i NRK TV betyr ikke at du kan laste ned eller publisere utdraget i egne videoer. NRK har egen prosess for klarering av arkivklipp: https://info.nrk.no/tv-spons-og-salg-av-nrks-innhold/arkiv/. Det finnes spesielle lovbestemte rettigheter for offentlig debattinnhold: https://info.nrk.no/bruk-av-klipp-fra-nrks-debattprogrammer/ – vurder konkret bruk. NRKs tredjepartskatalog har egne vilkår og krever API-nøkkel: https://psapi.nrk.no/thirdpartycatalog/Documentation.

NRK er ikke involvert i dette prosjektet, og «NRK» i tittelen angir bare hvilken tjeneste verktøyet er ment å søke i.

## Filstruktur

```text
index.html                 Nettsiden
assets/styles.css          Visuelt design
assets/app.js              Brukergrensesnitt, lokal import, favoritter
assets/search.js           Søk i statiske indeksfiler og lokal data
data/manifest.json         Indeksstatistikk (tom ved start)
data/programs.json         Programinformasjon (tom ved start)
data/index/*.json          Ordbaserte indeksskår
 data/chunks/*.json        Undertekstutdrag med tidskoder
 tools/indexer.py          Importer og bygg statisk indeks
 tools/prepare_site.py     Publiser kun nettstedfiler (aldri lokal database)
 tests/test_indexer.py      Automatiske funksjonstester
 .github/workflows/pages.yml GitHub Pages-oppsett
```

**Lisens:** MIT for kode skrevet i dette prosjektet, ikke for NRKs undertekster, video eller metadata.
