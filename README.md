# Top 100 der deutschen Wikipedia

Dieses Projekt ist eine kleine statische Web-App, die für einen ausgewählten **Monat** oder **Tag** die **100 meistaufgerufenen Artikel der deutschsprachigen Wikipedia** anzeigt.

Dafür nutzt die Anwendung die **Wikimedia Pageviews API** und lädt anschließend schrittweise die **Einleitung** der einzelnen Artikel nach, damit die Tabelle mehr Informationen bietet als nur eine einfache Titelliste.

## Was das Projekt macht

- zeigt die **Top 100 der deutschsprachigen Wikipedia** nach Anzahl der Aufrufe an
- erlaubt den Wechsel zwischen **Tages-** und **Monatsansicht**
- bietet eine **Vor-/Zurück-Navigation** für Datumswerte
- zeigt **Rang**, **Titel**, **Aufrufe** und eine kurze **Einleitung** zum Artikel
- ergänzt einfache **Statistikwerte zur Einleitung** und speichert geladene Texte im `localStorage`

## So funktioniert es

- `index.html` definiert das Seitenlayout und die Datentabelle
- `styles.css` enthält das responsive Styling der Oberfläche
- `script.js` ruft die Wikimedia-APIs ab, aktualisiert die Tabelle und steuert die Datumsnavigation

## Projekt lokal starten

Da es sich um eine reine HTML/CSS/JavaScript-Anwendung handelt, gibt es keinen Build-Schritt.

Lokal starten können Sie das Projekt zum Beispiel mit einem einfachen statischen Server:

```bash
python3 -m http.server 8000
```

Anschließend öffnen Sie `http://localhost:8000` im Browser.

## Verwendete Technik

- HTML
- CSS
- Vanilla JavaScript
- Wikimedia Pageviews API
- MediaWiki API
