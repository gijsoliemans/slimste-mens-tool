# Quizmastertool — 12 hints, 3 antwoorden

Webtool om puzzels te maken in het formaat van de puzzelronde uit De Slimste Mens,
en die live te spelen met een rader op een eigen apparaat.

Twaalf hints verwijzen naar drie antwoorden, vier hints per antwoord. De rader ziet
de hints door elkaar en weet niet welke hint bij welk antwoord hoort.

## Starten

```bash
node server/index.js
```

De server draait standaard op poort 4321 en print bij de eerste start een
gegenereerd hostwachtwoord in de terminal. Bewaar dat; je kunt het later wijzigen
onder Instellingen. Een eigen wachtwoord meegeven kan ook:

```bash
SM_HOST_PASSWORD=mijnwachtwoord PORT=8080 node server/index.js
```

- Quizmaster: `http://localhost:4321/`
- Rader: de code of link die de tool per sessie toont, bijvoorbeeld `http://192.168.1.20:4321/p/J7HZAD`

Voor spelen in dezelfde kamer werkt het netwerkadres dat bij het starten geprint
wordt. Er zijn geen npm-dependencies, dus `npm install` is niet nodig en de tool
werkt volledig zonder internet.

Omgevingsvariabelen: `PORT`, `SM_BIND`, `SM_HOST_PASSWORD`, `SM_DATA_DIR`.

## Hoe de geheimhouding is opgelost

Dit is de eis waar de architectuur op is gekozen. Een puur client-side app kan
het niet: zodra beide weergaven dezelfde data laden, staan de antwoorden op het
apparaat van de rader. Daarom is dit een echte server met een strikte scheiding.

- **De hints komen pas bij de start.** Zolang de quizmaster de klok niet gestart
  heeft, zitten de hintteksten niet in de payload naar de speler. Die ziet een
  wachtscherm met twaalf lege vakjes, en kan dus niet vast meelezen of de hints
  fotograferen voordat de tijd loopt. Een reset verbergt ze weer.
- **De server bepaalt wat de speler krijgt.** `playerView()` in
  [server/game.js](server/game.js) bouwt de spelerpayload van nul op uit de
  hintteksten, de tegelstatus en de klok. Er is geen "verwijder de geheime
  velden"-stap die je kunt vergeten; wat er niet expliciet in gezet wordt, komt
  er niet in.
- **Tegel-ids zijn per sessie willekeurig** (8 random bytes) en zeggen niets over
  de groep. Het veld `group` is `null` zolang een antwoord niet onthuld is.
- **Aparte identiteiten.** De host-sessie-id is 24 random bytes, de spelerscode is
  6 tekens. Kennis van de spelerscode geeft geen toegang tot iets van de host:
  host-endpoints matchen alleen op de host-id én vereisen een geldig cookie.
- **Host-authenticatie** op alles wat een volledige puzzel kan teruggeven:
  `/api/puzzles*`, `/api/sessions*`, `/api/export`, `/api/import`, `/api/settings`.
  Het cookie is HttpOnly en bevat een HMAC-token; het wachtwoord staat als
  scrypt-hash in `data/config.json`.
- **Gescheiden frontendbestanden.** `play.html` / `play.js` / `play.css` bevatten
  geen puzzelkennis en laden de host-bundel niet. Er is niets te vinden in de
  HTML, in een JavaScript-bundel, in localStorage, in een class-naam, in een
  data-attribuut of in een verborgen element.

Getest in een echte browser vanaf de spelerpagina: DOM, alle attributen,
localStorage, sessionStorage, cookies, alle geladen bestanden en de API-payload
bevatten geen enkel antwoord, alternatief of toelichting. Vanaf een apparaat
zonder host-cookie geven alle host-endpoints 401 terug.

Eén ding om te weten: de scheiding zit in het cookie, niet in de URL. Geef de
rader dus geen apparaat waarop jij als quizmaster bent ingelogd.

## Synchronisatie

De server is de enige bron van waarheid voor de klok en de spelstatus. Clients
interpoleren de klok lokaal voor een vloeiende weergave, maar corrigeren bij
iedere serverboodschap.

Updates gaan over Server-Sent Events (`/api/play/stream`, `/api/sessions/:id/stream`),
met polling als terugvaloptie zodra er zes seconden geen bericht binnenkwam.
Een herlaad of korte netwerkonderbreking wordt opgevangen: bij terugkeer stuurt
de server direct de volledige status, dus de client zit meteen weer synchroon.

Gemeten: een goedgekeurd antwoord staat binnen ~5 ms op het spelerscherm, en de
klok van host en speler wijkt onderling niet meer dan een tik af.

Valt de host weg, dan blijft de sessie in het geheugen bestaan; hij komt terug via
de sessiebalk op het overzicht. Valt de speler weg, dan ziet de host het
kijkersaantal dalen en kan hij pauzeren.

## Keuzes bij de randgevallen

| Situatie | Gedrag |
| --- | --- |
| Twee mensen openen dezelfde spelerslink | Beiden zien exact hetzelfde, inclusief dezelfde tegelvolgorde. De status hangt aan de sessie, niet aan de verbinding. |
| Host klikt het verkeerde antwoord goed | Ongedaan maken zet het antwoord terug op onbekend, haalt de tijdbonus weg en laat de tegels bij de speler weer omhoog komen. De klok wordt niet teruggedraaid: verstreken tijd blijft verstreken. Was de ronde door die klik afgelopen, dan komt hij terug als *gepauzeerd*, zodat de host zelf bepaalt wanneer de klok weer loopt. |
| De tijd loopt af terwijl de host op goed drukt | **De klok van de server beslist.** Een scoreactie telt alleen als de server hem ontvangt terwijl er nog tijd over is. Is de tijd bij binnenkomst al op, dan wordt de actie geweigerd en krijgt de host de melding dat het niet meer telt. Het antwoord kan daarna nog wel onthuld worden. |
| Host start een tweede sessie van dezelfde puzzel | Mag. Beide sessies lopen naast elkaar met een eigen code en een eigen klok. |
| Puzzel wordt bewerkt tijdens een actieve sessie | De sessie draait door op een diepe kopie die bij het starten is gemaakt. De bewerking geldt pas voor de volgende sessie. |
| Server wordt herstart tijdens een sessie | Puzzels overleven dat (ze staan op schijf), lopende sessies niet. Start in dat geval een nieuwe sessie. |

## Puzzels beheren

- Drie antwoordblokken met elk vier hints eronder, zodat de koppeling zichtbaar
  blijft tijdens het maken.
- Hints zijn tussen antwoorden te **verslepen**; op mobiel doen de ◀ ▶-knoppen
  hetzelfde.
- **Opslaan** dwingt af: precies 3 antwoorden, precies 4 hints per antwoord, geen
  lege teksten. Klopt dat niet, dan weigert de server het. **Opslaan als concept**
  bewaart een halve puzzel wel, maar zo'n concept is niet te starten. Concepten
  staan als zodanig in de lijst.
- Waarschuwingen, die niets blokkeren: dubbele hints binnen een puzzel, en een
  hint die letterlijk gelijk is aan een antwoord.
- Zoeken op titel, hint of antwoord, filteren op tag en op status, dupliceren,
  verwijderen, en import/export als JSON voor back-ups en delen.
- **Voorbeeld speler** toont de twaalf hints zoals de rader ze straks ziet.

## Tijdens het spel

De hostweergave toont de drie antwoorden met hun vier hints, de alternatieven die
ook goed gerekend mogen worden, en de toelichting om na afloop voor te lezen.
Per antwoord zit er een knop *Goed* en een knop *Onthul*.

Sneltoetsen: `spatie` start of pauzeert, `1` `2` `3` keuren dat antwoord goed,
`x` is fout, `⌘/ctrl+z` maakt ongedaan.

Instelbaar per sessie, met opslaanbare standaardwaarden: totale tijd (standaard
60 s), tijdbonus per goed antwoord, straftijd per fout antwoord, en of de hints
geschud worden. Bij schudden wordt de volgorde één keer per sessie bepaald en
daarna vastgezet, zodat er tijdens het spel niets verspringt.

De spelerweergave is opgemaakt in de kleurstijl van de tv-ronde: rode
achtergrond, donkere panelen met een lichtstrip eronder, grote witte letters, en
een raster van drie breed en vier hoog. Op een telefoon in portretstand wordt dat
twee breed. Zodra een antwoord gevonden of onthuld is, kleurt de strip onder zijn
vier tegels mee, zodat de groepering in één oogopslag te zien is. Bij open tegels
staat die kleur er niet, en zit hij ook niet in de payload.

De hostweergave is bewust donker en neutraal gebleven: dat is een bedieningspaneel,
geen decor.

Zolang je de klok niet gestart hebt, ziet de rader een wachtscherm en nog geen
hints. De statusregel onder de klok herinnert je daaraan.

Na afloop onthult één knop alle resterende antwoorden inclusief de groepering:
de tegels krijgen dan pas de kleur van hun antwoord.

Met **Volgende puzzel** start je de volgende ronde terwijl de speler dezelfde
link houdt.

## Opslag

Alles staat in `data/`:

- `puzzles.json` — puzzels, tags en standaardinstellingen, atomair weggeschreven
- `config.json` — hostwachtwoord (scrypt-hash) en het HMAC-secret, `chmod 600`

Spelsessies staan alleen in het geheugen; die zijn per avond en hoeven een
herstart niet te overleven.

## Waar deze tool voor bedoeld is

Voor een avond in de huiskamer of over een videocall, op je eigen netwerk. De
server luistert standaard op `0.0.0.0`, zodat de telefoon van de rader erbij kan;
beperk dat met `SM_BIND=127.0.0.1` als je alleen op je eigen machine speelt.

Zet hem niet zonder meer open op het internet. Er is geen HTTPS ingebouwd, dus
het hostwachtwoord zou over een onversleutelde verbinding gaan, en de
`Secure`-vlag op het cookie wordt alleen gezet als er al HTTPS voor staat. Moet
het toch over het net, zet er dan een reverse proxy met TLS voor.

De spelerscode is zes tekens uit een alfabet van 32. Wie hem raadt ziet de hints
van een lopende sessie, nooit de antwoorden of de groepering. Voor de host geldt
dat niet: die zit achter een wachtwoord met een scrypt-hash, en een mislukte
poging kost 400 ms, wat gokken onaantrekkelijk maakt.

## Buiten scope in deze versie

Afbeeldingen of geluid als hint, een speler die antwoorden typt, meerdere spelers
met een buzzer, puntentelling over meerdere rondes, een publieksscherm, en
automatisch puzzels genereren.
