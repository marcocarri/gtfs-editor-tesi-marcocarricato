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
Durante lo sviluppo, è emersa una problematica di integrazione (*decoupling bug*) nel widget nativo della mappa Snap4City, il quale non trasmetteva in output le coordinate aggiornate a seguito del rilascio (*drop*) del marker.
Per garantire l'autonomia dell'Editor senza alterare il codice di piattaforma, è stato implementato un **Network Interceptor Pattern**: il widget sovrascrive temporaneamente il metodo `fetch()` nativo per intercettare passivamente le chiamate al server di routing (OSRM/GraphHopper), estraendo i *waypoints* aggiornati direttamente dall'URL di rete e sincronizzandoli con lo stato in memoria (RAM) dell'applicazione.

## Sviluppo e Build Pipeline (Tooling)
Per garantire la manutenibilità, il codice sorgente è sviluppato in modo modulare (`/src` diviso in HTML, CSS e JS). Per il rilascio sulla piattaforma Snap4City, è stato ingegnerizzato uno script di build in **Node.js** (`build.js`). Eseguendo il comando `npm run build`, il sistema estrae il DOM, inietta le dipendenze (es. jQuery) e unifica gli stili e gli script, generando automaticamente un **Single-File Component** (`dist/build_widget.html`) ottimizzato e pronto per l'ambiente operativo.

## Roadmap Sviluppo (GitFlow)
- [x] **Fase 1**: Refactoring esportazione dati (Strict GTFS / KM4City Ingestion Payload).
- [ ] **Fase 2**: Map-matching e ricalcolo distanze spaziali (`shape_dist_traveled`).
- [ ] **Fase 3**: Algoritmo stima velocità e interpolazione orari (Monotonia Temporale).
- [ ] **Fase 4**: Modulo salvataggio / trasmissione dati al Backend.
- [ ] **Fase 5**: Modulo di calcolo della matrice di coincidenza temporale.