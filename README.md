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

## Roadmap Sviluppo (GitFlow)
- [ ] **Fase 1**: Refactoring esportazione dati (Strict GTFS / KM4City Ingestion Payload).
- [ ] **Fase 2**: Map-matching e ricalcolo distanze spaziali (`shape_dist_traveled`).
- [ ] **Fase 3**: Algoritmo stima velocità e interpolazione orari (Monotonia Temporale).
- [ ] **Fase 4**: Modulo salvataggio / trasmissione dati al Backend.
- [ ] **Fase 5**: Modulo di calcolo della matrice di coincidenza temporale.