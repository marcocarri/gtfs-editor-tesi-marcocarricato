# GTFS Editor - Snap4City Integration
**Tesi di Laurea Triennale in Ingegneria Informatica**

*Candidato: Marco Carricato*

---

## Scope del Progetto
Questo repository contiene il codice sorgente di un Editor di percorsi e orari del trasporto pubblico basato su standard **GTFS**.
L'applicativo è ingegnerizzato come Custom Widget (Micro-Frontend) per l'ecosistema IoT/GIS **Snap4City**, interagendo tramite chiamate REST con l'ontologia KM4City e con moduli di routing spaziale. L'obiettivo è permettere l'editing grafico di tracciati, il ricalcolo topologico delle distanze e l'interpolazione temporale per garantire l'integrità del dato GTFS; oltre al calcolo e alla creazione delle tabelle di coincidenza dei dati interessati.

## Architettura e Struttura Repository
Il progetto è strutturato per isolare la logica applicativa dalla documentazione accademica:
- `/src`: Codice sorgente del Custom Widget (HTML, CSS, Vanilla JS).
- `/data`: Dati mock, backup del codice legacy e strutture JSON attese.
- `/docs`: Materiale testuale della tesi, appunti architetturali e diagrammi.

Il modulo comunica con la mappa nativa di Snap4City tramite un **Event-Driven Bus**.

## Scelte Architetturali e Soluzione di Problemi (Troubleshooting)
Durante lo sviluppo e l'integrazione tra i widget di piattaforma, sono emerse due problematiche critiche superate a livello client-side:
1. **Decoupling Bug (Coordinate fermate):** Il widget nativo della mappa non trasmetteva le nuove coordinate WGS84 al rilascio (*drop*) del marker.
2. **Environment Cloning Bug (Routing URL nullo):** A seguito della duplicazione della dashboard, la perdita di parametri d'ambiente (`orgParams`) causava la generazione di chiamate di instradamento verso un endpoint non valido (`null?vehicle=car...`), bloccando il ricalcolo stradale.

Per garantire la piena autonomia e portabilità del Custom Widget senza alterare file di sistema del server, è stato ingegnerizzato un **Network Interceptor & Proxy Pattern**:
- Sovrascrive temporaneamente l'interfaccia `window.fetch()` nativa.
- Intercetta le chiamate dirette a `null?` e le riscrive dinamicamente instradandole verso il servizio GraphHopper attivo (`https://www.snap4city.org/whatif-router/route`).
- Estrae passivamente i *waypoints* dall'URL della richiesta tramite espressioni regolari e sincronizza in tempo reale le coordinate di `editStops` nella memoria RAM.

## Sviluppo e Build Pipeline (Tooling)
Per garantire la manutenibilità, il codice sorgente è sviluppato in modo modulare (`/src` diviso in HTML, CSS e JS). Per il rilascio sulla piattaforma Snap4City, è stato ingegnerizzato uno script di build in **Node.js** (`build.js`). Eseguendo il comando `npm run build`, il sistema estrae il DOM, inietta le dipendenze esterne (jQuery, Turf.js) e unifica gli stili e gli script, generando automaticamente un **Single-File Component** (`dist/build_widget.html`) ottimizzato e pronto per l'ambiente operativo.

## Modellazione Topologica e Geomatica
Per conformare i dati allo standard GTFS, ogni fermata deve registrare la distanza progressiva metrica dall'origine (`shape_dist_traveled`):
- **Parsing Vettoriale:** La geometria del tracciato restituita dal router in formato WKT (`LINESTRING`) viene parsata ed elaborata in una struttura GeoJSON `LineString` compatibile.
- **Proiezione Ortogonale (Turf.js):** Tramite la libreria geospaziale Turf.js (`turf.nearestPointOnLine`), ciascun nodo di fermata viene proiettato ortogonalmente sul segmento stradale più vicino.
- **Metriche Progressive:** L'algoritmo calcola la distanza curvilinea cumulativa lungo il tracciato, converte l'output chilometrico in metri e lo associa al record in `stop_times`, garantendo la rigida monotonia spaziale richiesta dalle specifiche GTFS.

## Roadmap Sviluppo (GitFlow)
- [x] **Fase 1**: Refactoring esportazione dati (Strict GTFS / KM4City Ingestion Payload).
- [x] **Fase 2**: Map-matching e ricalcolo distanze spaziali (`shape_dist_traveled`).
- [ ] **Fase 3**: Algoritmo stima velocità e interpolazione orari (Monotonia Temporale).
- [ ] **Fase 4**: Modulo salvataggio / trasmissione dati al Backend.
- [ ] **Fase 5**: Modulo di calcolo della matrice di coincidenza temporale.