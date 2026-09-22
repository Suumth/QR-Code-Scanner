# QR Code Scanner

**Kostenlose, selbst gehostete QR-Gutscheinlösung für Veranstaltungen, Vereine und gemeinnützige Aktionen.**

[🇩🇪 Deutsch](#deutsch) · [🇬🇧 English](#english)

---

# Deutsch

## Was ist das?

Mit **QR Code Scanner** lassen sich digitale Gutscheine für Veranstaltungen erstellen, verteilen und **genau einmal einlösen**.

Typische Anwendungsfälle:

- Getränkegutscheine für Sponsoren
- Essensgutscheine
- Helfer- oder VIP-Gutscheine
- Tombola- oder Aktionsgutscheine
- Vereinsfeste, Stadtfeste und Benefizveranstaltungen

Die Lösung läuft vollständig im Browser. Für die Ausgabe oder Einlösung ist **keine App-Installation** erforderlich.

Sie wurde ursprünglich für einen Round-Table-Veranstaltungsworkflow entwickelt und anschließend als bereinigte Open-Source-Version veröffentlicht.

## Was kann die Lösung?

- mehrere Veranstaltungen verwalten
- mehrere Sponsoren je Veranstaltung anlegen
- beliebig benannte Gutscheinarten wie `1 Bier`, `1 Essen` oder `2 Getränke` anlegen
- beliebig viele eindeutige Gutscheine erzeugen
- jeden Gutschein als QR-Code und zusätzlichen manuellen `XXXX-XXXX`-Code bereitstellen
- QR-Codes als SVG-ZIP für Canva, PowerPoint, InDesign oder Drucklayouts exportieren
- einen privaten Sponsor-Link bereitstellen, über den Sponsoren ihre Gutscheine sehen können
- mehrere Helfer gleichzeitig auf verschiedenen Smartphones anmelden
- Gutscheine per Smartphone-Kamera oder manuellem Code prüfen
- Gutscheine erst nach ausdrücklicher Bestätigung einlösen
- bereits eingelöste Gutscheine zuverlässig erkennen
- CSV-Exporte für die Veranstaltung erzeugen

## So funktioniert es

```text
Admin
  │
  ├── Veranstaltung anlegen
  ├── Team-PIN festlegen
  ├── Sponsor anlegen
  ├── Gutscheinart anlegen
  └── Gutscheine erzeugen
          │
          ▼
Sponsor erhält privaten Link
          │
          ├── Gutschein anzeigen
          ├── QR-Code weitergeben / drucken
          └── manueller Code als Fallback
          │
          ▼
Gast zeigt Gutschein
          │
          ▼
Team scannt QR-Code
          │
          ├── gültig → ausdrücklich einlösen
          ├── bereits eingelöst → Hinweis
          └── ungültig → keine Einlösung
```

## Warum nicht einfach statische QR-Codes?

Ein normaler QR-Code kann beliebig oft fotografiert oder kopiert werden.

Hier besitzt jeder Gutschein eine eigene zufällige ID. Der Server speichert den Einlösestatus und aktualisiert ihn atomar. Selbst wenn zwei Helfer denselben Gutschein nahezu gleichzeitig scannen, kann **nur eine Einlösung erfolgreich sein**.

## Sicherheit

Die Anwendung wurde bewusst mit einem einfachen, aber belastbaren Sicherheitsmodell gebaut:

- Admin-Passwort nur als Cloudflare-Secret `ADMIN_PASSWORD`
- Team-PIN nicht im Klartext gespeichert
- zufällige Session-Tokens; in D1 werden nur deren Hashes gespeichert
- `Secure`, `HttpOnly` und `SameSite=Strict` Session-Cookies
- Scannen und Prüfen verändern noch keinen Zustand
- Einlösung nur für angemeldete Team-Mitglieder
- ausdrückliche Bestätigung vor jeder Einlösung
- atomare Einlösung in Cloudflare D1
- Netzwerkfehler werden niemals als erfolgreiche Einlösung dargestellt

## Was kostet der Betrieb?

Die Anwendung verwendet:

- **Cloudflare Workers**
- **Cloudflare D1**
- React + TypeScript + Vite

Es gibt **keine kostenpflichtige Laufzeitabhängigkeit**, keinen externen QR-Dienst und keinen Zahlungsanbieter.

Für kleinere Veranstaltungen kann der Betrieb innerhalb der jeweiligen kostenlosen Cloudflare-Limits bleiben. Die aktuell gültigen Limits sollten vor einer Veranstaltung direkt bei Cloudflare geprüft werden.

## Voraussetzungen

- Node.js 24 oder neuer
- npm
- kostenloses Cloudflare-Konto
- Wrangler CLI

## Lokal ausprobieren

```bash
git clone https://github.com/Suumth/QR-Code-Scanner.git
cd QR-Code-Scanner

npm ci
npx playwright install chromium

cp .dev.vars.example .dev.vars
```

In `.dev.vars` ein lokales Admin-Passwort eintragen:

```text
ADMIN_PASSWORD=dein-lokales-passwort
```

Anschließend:

```bash
npx wrangler d1 migrations apply DB --local
npm run dev
```

## Auf Cloudflare bereitstellen

### 1. Eigene D1-Datenbank erstellen

```bash
npx wrangler d1 create event-vouchers
```

Cloudflare gibt anschließend eine eigene `database_id` zurück.

Diese ID in `wrangler.jsonc` anstelle der vorhandenen Null-ID eintragen.

### 2. Admin-Passwort als Secret speichern

```bash
npx wrangler secret put ADMIN_PASSWORD
```

### 3. Datenbank vorbereiten und deployen

```bash
npx wrangler d1 migrations apply DB --remote
npm run build
npx wrangler deploy
```

Danach stellt Cloudflare eine HTTPS-Adresse für die Anwendung bereit.

> **Wichtig:** Niemals `.dev.vars`, Datenbank-Backups, echte Sponsor-Links, produktive Gutschein-QR-Codes oder Zugangsdaten committen.

## Qualitätssicherung

Das Repository enthält Unit-, Integrations- und Browser-E2E-Tests.

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run e2e
npm run e2e:signal
```

## Anpassung an den eigenen Verein oder die eigene Veranstaltung

Die öffentliche Version enthält bewusst **kein ursprüngliches RT22-/Round-Table-Logo** und keine produktiven Infrastrukturkennungen.

Damit kann das Projekt als Grundlage für eigene Veranstaltungen verwendet und mit eigenem Namen, Logo und Design versehen werden.

Die Benutzeroberfläche ist derzeit deutsch und die öffentliche Eventauswahl verwendet `Europe/Berlin` für Kalendertage.

## Lizenz

Der Code steht unter der **MIT-Lizenz**.

Du darfst ihn kostenlos verwenden, kopieren, verändern und weitergeben. Details stehen in [LICENSE](LICENSE).

---

# English

**Free, self-hosted QR voucher system for events.**

The app lets organizers create events, sponsors and voucher types, issue one-time vouchers, distribute them as QR codes or manual codes, and redeem them safely from multiple team devices.

Originally built for a Round Table event workflow and released here as a clean public snapshot without production credentials, private infrastructure identifiers or the original repository history.

## Features

- one-time QR vouchers with atomic redemption
- multiple events, sponsors and voucher types
- private sponsor links without sponsor accounts
- browser-based team login with event PIN
- concurrent redemption from multiple phones
- manual `XXXX-XXXX` code fallback when camera access is unavailable
- QR export as SVG ZIP plus CSV manifest
- event CSV export
- Cloudflare Workers + D1
- no paid runtime dependency required
- React + TypeScript + Vite
- unit, integration and Playwright E2E tests

## Security model

- Admin password is stored only as the Cloudflare secret `ADMIN_PASSWORD`.
- Team PINs are salted and derived before storage.
- Session bearer tokens are random; only hashes are stored in D1.
- Session cookies are `Secure`, `HttpOnly` and `SameSite=Strict`.
- Scanning/inspection is read-only.
- Redemption requires an authenticated team session and explicit confirmation.
- D1 performs a conditional redemption update so concurrent attempts can produce only one successful redemption.
- A lost/network-failed response is never displayed as a successful redemption.

## Requirements

- Node.js 24+
- npm
- a Cloudflare account
- Wrangler authenticated with `npx wrangler login`

## Local setup

```bash
git clone https://github.com/Suumth/QR-Code-Scanner.git
cd QR-Code-Scanner
npm ci
npx playwright install chromium
cp .dev.vars.example .dev.vars
```

Set a local admin password in `.dev.vars`:

```text
ADMIN_PASSWORD=choose-a-local-password
```

Apply the D1 migrations locally and start the app:

```bash
npx wrangler d1 migrations apply DB --local
npm run dev
```

## Deploy to Cloudflare

1. Create your own D1 database:

```bash
npx wrangler d1 create event-vouchers
```

2. Copy the returned database ID into `wrangler.jsonc`, replacing the all-zero placeholder.

3. Set the admin secret:

```bash
npx wrangler secret put ADMIN_PASSWORD
```

4. Apply migrations and deploy:

```bash
npx wrangler d1 migrations apply DB --remote
npm run build
npx wrangler deploy
```

Do not commit `.dev.vars`, database exports, production credentials, sponsor links or live voucher material.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run e2e
npm run e2e:signal
```

The current implementation uses German UI copy and `Europe/Berlin` calendar-day semantics for the public event list. These can be adapted for other deployments without changing the redemption model.

## License

Code in this repository is released under the MIT License. The original RT22/Round Table logo is intentionally not included in this public repository.

See [LICENSE](LICENSE).
