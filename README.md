# Materialkalkulation – Web-App

Kalkulation für handgemachte Produkte: Einkäufe erfassen, Preise auf eine Einheit herunterrechnen,
Stücklisten je Produktvariante, Herstellkosten und Preisempfehlung. Rechenlogik wie die LibreOffice-Tabelle.

- Läuft im Browser auf Laptop und Android (als App installierbar, offline nutzbar).
- Daten: eine JSON-Datei im Google Drive der Nutzerin (`Materialkalkulation/materialkalkulation.json`),
  Fotos im Unterordner `Fotos`. Zugriff nur mit der Berechtigung `drive.file`.
- Ohne Google-Konto nutzbar im Modus „nur auf diesem Gerät“ (Daten im Browser).
- Import der LibreOffice-Tabelle (.ods) unter **Mehr → Tabelle importieren**.

## Einrichtung
Siehe `Einrichtung_App.pdf`. Kurz: Dateien auf GitHub Pages hochladen, in der Google Cloud Console
ein Projekt mit Google Drive API und OAuth-Client (Webanwendung) anlegen, Client-ID in `config.js` eintragen.

## Dateien
| Datei | Zweck |
|---|---|
| `index.html`, `styles.css`, `app.js` | die App |
| `config.js` | Google-Client-ID und Name von Ordner/Datei in Drive |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installation als App und Offline-Betrieb |
| `lib/xlsx.full.min.js` | SheetJS 0.18.5 (Apache-2.0) für Import/Export von Tabellen |
