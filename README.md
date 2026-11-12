# Hyrdon CRM – lokal version 0.1

En enkel CRM för Hyrdon (leasing), Premium Motors (bilförsäljning) och American Motors.
Den här versionen körs **bara lokalt** med **syntetisk demodata**. Inga integrationer är anslutna:
Microsoft 365, Telenor, Blocket, HubSpot och webbformulär är inte anslutna, och appen skickar inga mejl och ringer inga samtal.

## Starta

Kräver **Node.js 22.13 eller senare**. Inga npm-paket behöver installeras, och appen har inga beroenden.

```bash
cd hyrdon-crm
npm start
```

Öppna http://localhost:3000. Första starten skapar databasen `data/crm.sqlite` och fyller den med demodata.
Data finns kvar mellan omstarter.

Valfria inställningar: `PORT=4000 npm start`, `CRM_DB=/sökväg/crm.sqlite npm start`.
Vill du testa på telefon i samma nätverk startar du med `HOST=0.0.0.0 npm start` och öppnar `http://<datorns-ip>:3000`.

## Demokonton

Lösenord för alla: **demo1234**. Inloggningssidan listar kontona, och ett klick fyller i dem.

| Roll | Namn | E-post |
|---|---|---|
| Direktör / Admin | Karin Ek | karin@demo.local |
| Säljare | Johan Berg | johan@demo.local |
| Säljare | Sara Lind | sara@demo.local |
| Säljare | Ahmed Haddad | ahmed@demo.local |
| Säljare | Emma Nyström | emma@demo.local |
| Säljare | Oskar Holm | oskar@demo.local |
| Säljare | Lina Sjöberg | lina@demo.local |
| (inaktiverad) | Mikael Ström | mikael@demo.local – kan inte logga in, men har kvar historik och en öppen lead som behöver tilldelas om |

## Återställ demodata

* I appen: **Admin → Demodata**. Skriv `ÅTERSTÄLL` och bekräfta.
* Eller i terminalen, med servern stoppad eller igång: `npm run reset-demo`

Båda ersätter **all** lokal data, även användare du har skapat. Datum i demodatan räknas från dagens datum, så "försenat" och "idag" stämmer.

## Saker att prova

* **Dubblettvarning:** skapa en ny lead med telefon `070-123 45 67` eller `0046701234567`. Anna Svensson finns redan som `+46 70 123 45 67`.
* **Återkommande kunder:** Anna Svensson, Per Andersson (tre leads i tre bolag) och Lars Holmqvist.
* **Internationellt nummer:** Nils Hansen (`+47 …`) matchar inte svenska nummer.
* **Ta lead samtidigt:** logga in som två säljare i två webbläsare. Båda klickar "Ta lead" på samma lead. Den som kommer sist ser vem som tog den.
* **Vunnen → Levererad:** flytta en vunnen lead till Levererad. Antalet vunna i Översikt ändras inte.

## Tester

```bash
npm test          # API, behörigheter, samtidighet, rapporter, persistens (22 tester)
npm run test:ui   # webbläsartest av huvudflöden på mobil + dra-och-släpp på desktop (kräver Playwright)
```

## Struktur

```
server.js            startpunkt
src/db.js            SQLite-schema (node:sqlite), transaktioner
src/leads.js         leads, kunder, aktiviteter, behörigheter, atomisk "Ta lead"
src/admin.js         användare och pipelines (endast admin)
src/reports.js       översikt/rapporter (Europe/Stockholm)
src/seed.js          syntetisk demodata
src/server.js        HTTP-API + statiska filer
shared/              telefon-normalisering, tidszon, konstanter (delas av server och webbläsare)
public/              gränssnitt (vanilla JS, inget byggsteg)
test/                tester
```

Koden och datamodellen är på engelska. Gränssnittet är på svenska.
