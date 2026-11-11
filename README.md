```markdown
# GTFS Editor - Snap4City Integration
**Tesi di Laurea Triennale in Ingegneria Informatica**

*Candidato: Marco Carricato*

---

## Scope del Progetto
Questo repository contiene il codice sorgente di un Editor interattivo per percorsi e orari del Trasporto Pubblico Locale basato sullo standard **GTFS (General Transit Feed Specification)**.
L'applicativo è ingegnerizzato come Custom Widget (Micro-Frontend) integrato nella dashboard IoT/GIS **Snap4City**, operando secondo un paradigma **ETL (Extract, Transform, Load) agnostico**:
- **Extract:** Acquisizione e armonizzazione di feed eterogenei (GeoJSON per i nodi spaziali, stringhe WKT per le polilinee e binding semantici SPARQL/RDF dall'ontologia KM4City).
- **Transform (Core Algoritmico):** Map-matching topologico, calcolo progressivo delle distanze curvilinee lungo la traccia stradale (`shape_dist_traveled`), risoluzione automatica delle asimmetrie orarie tramite interpolazione cinematica multi-regime (funzione di *Data Healing* su feed parziali o corrotti).
- **Load (Dual Export Engine):** Esportazione flessibile del dato modificato sia in formato Document (per ingestion rapida su Smart City API tramite modale grafico) sia in formato relazionale normalizzato 3NF (Strict-GTFS via download diretto), pienamente interoperabile con validatori e motori di routing terzi (OpenTripPlanner, Google Transit).

Il sistema include inoltre la base dati per la successiva generazione algoritmica delle **matrici di coincidenza oraria** tra linee di trasporto urbano ed extraurbano.

## Architettura e Struttura Repository
Il repository adotta una netta separazione delle competenze (*Separation of Concerns*):
- `/src`: Codice sorgente modulare del Custom Widget (`index.html`, `style.css`, `app.js`).
- `/data`: Dati mock relazionali di riferimento (schemi GTFS pre e post-modifica con tracciamento metrico e temporale), backup del codice legacy.
- `/docs`: Documentazione tecnica, analisi architetturale delle API di ingestion, formulazioni matematiche della tesi.
- `/dist`: Artefatto di distribuzione compilato generato dalla build pipeline (`build_widget.html`).

Il widget comunica con il componente cartografico nativo attraverso un **Event-Driven Bus** asincrono su scope parent.

## Scelte Architetturali e Soluzione di Problemi (Troubleshooting)
Durante lo sviluppo e l'integrazione tra i micro-frontend di piattaforma, sono emerse tre problematiche critiche superate a livello client-side:
1. **Decoupling Bug (Coordinate fermate):** Il widget nativo della mappa non trasmetteva le nuove coordinate WGS84 al rilascio (*drop*) del marker.
2. **Environment Cloning Bug (Routing URL nullo):** A seguito della duplicazione della dashboard, la perdita di parametri d'ambiente (`orgParams`) causava la generazione di chiamate di instradamento verso un endpoint non valido (`null?vehicle=car...`), bloccando il ricalcolo stradale.
3. **Runtime Auto-Discovery (Zero-Config):** L'hardcoding degli identificativi del widget mappa causava la rottura dei collegamenti ad ogni clonazione della dashboard. È stata ingegnerizzata la funzione `detectMapWidgetId()` che scansiona dinamicamente il DOM del documento parent alla ricerca del selettore `[id*="_widgetMap"]`, rendendo l'editor completamente portabile e indipendente dall'ID dell'ambiente ospite.

Per garantire la piena autonomia dell'Editor senza alterare file di sistema del server, è stato ingegnerizzato un **Network Interceptor & Proxy Pattern**:
- Sovrascrive temporaneamente l'interfaccia `window.fetch()` nativa.
- Intercetta le chiamate dirette a `null?` e le riscrive dinamicamente instradandole verso il servizio GraphHopper attivo (`https://www.snap4city.org/whatif-router/route`).
- Estrae passivamente i *waypoints* dall'URL della richiesta tramite espressioni regolari e sincronizza in tempo reale le coordinate di `editStops` nella memoria RAM con precisione standardizzata a 6 cifre decimali (~11 cm).

## Sviluppo e Build Pipeline (Tooling)
Per garantire la manutenibilità, il codice sorgente è sviluppato in modo modulare (`/src` diviso in HTML, CSS e JS). Per il rilascio sulla piattaforma Snap4City, è stato ingegnerizzato uno script di build in **Node.js** (`build.js`). Eseguendo il comando `npm run build`, il sistema estrae il DOM, inietta le dipendenze esterne (jQuery, Turf.js) e unifica gli stili e gli script, generando automaticamente un **Single-File Component** (`dist/build_widget.html`) ottimizzato e pronto per l'ambiente operativo.

### Setup Locale
```bash
# 1. Clona il repository
git clone https://github.com/marcocarri/gtfs-editor-tesi-marcocarricato.git

# 2. Entra nella directory
cd gtfs-editor-tesi-marcocarricato

# 3. Ripristina dipendenze e definizioni di tipo
npm install

# 4. Compila il bundle di produzione
npm run build
```

## Modellazione Topologica e Geomatica
Per conformare i dati allo standard GTFS, ogni fermata deve registrare la distanza progressiva metrica dall'origine (`shape_dist_traveled`):
- **Parsing Vettoriale:** La geometria del tracciato restituita dal router in formato WKT (`LINESTRING`) viene parsata ed elaborata in una struttura GeoJSON `LineString` compatibile.
- **Proiezione Ortogonale (Turf.js):** Tramite la libreria geospaziale Turf.js (`turf.nearestPointOnLine`), ciascun nodo di fermata viene proiettato ortogonalmente sul segmento stradale più vicino.
- **Metriche Progressive:** L'algoritmo calcola la distanza curvilinea cumulativa lungo il tracciato, converte l'output chilometrico in metri e lo associa al record in `stop_times`, garantendo la rigida monotonia spaziale richiesta dalle specifiche GTFS.

## Sintesi Oraria e Cinematica Multi-Regime
A fronte dell'incompletezza informativa dei feed real-time (presenza di buchi temporali arbitrari), è stato ingegnerizzato un motore di interpolazione spazio-temporale deterministico basato su cinematica dei trasporti:
- **Risoluzione Bidirezionale dei Gap (Pattern Arbitrari):**
  * *Total Null Guard:* Fallback deterministico a $t_0 = \text{"08:00"}$ in assenza totale di orari nel feed.
  * *Retro-propagazione (Head Gaps):* Calcolo a ritroso $t_k = t_{k+1} - \Delta t$ dal primo caposaldo noto verso l'origine, sanando le fermate iniziali prive di orario.
  * *Finestre Chiuse (Internal Gaps):* Interpolazione lineare convessa proporzionale alla distanza $\Delta s$ tra caposaldi temporali vincolati, prevenendo collisioni temporali e garantendo $t_i \le t_{i+1}$.
  * *Finestre Aperte (Tail Gaps) & Cascata:* Propagazione in avanti lungo la tratta terminale o al trascinamento dei marker.
- **Cinematica a 4 Regimi (Conformità Art. 142 CdS):**
  Classificazione dinamica della velocità in funzione della spaziatura d'arco:
  1. *Urbano Denso* ($\Delta s < 300\text{ m}$): $v_{\text{comm}} \approx 13\text{ km/h}$, $w = 0.80$, cap $50\text{ km/h}$.
  2. *Urbano Standard* ($300\text{ m} \le \Delta s < 1200\text{ m}$): $v_{\text{comm}} \approx 16\text{ km/h}$, $w = 1.00 \dots 1.15$, cap $50\text{ km/h}$.
  3. *Extraurbano Statale* ($1200\text{ m} \le \Delta s < 4000\text{ m}$): $v_{\text{comm}} \approx 40\text{ km/h}$, $w = 2.50$, cap $80\text{ km/h}$.
  4. *Autostradale Express* ($\Delta s \ge 4000\text{ m}$): $v_{\text{comm}} \approx 72\text{ km/h}$, $w = 4.50$, cap $100\text{ km/h}$ (validato su tratta A1 Barberino-Firenze).
- **Integrazione OpenStreetMap (Overpass API):** Rilevamento vettoriale delle corsie preferenziali (`lanes:bus`, `highway=busway`) con calcolo della lunghezza metrica effettiva tramite Turf.js e applicazione di un bonus di scorrevolezza proporzionale alla percentuale di copertura dell'arco.
- **Dwell Time:** Integrazione di una penalità di arresto e incarrozzamento costante ($T_{\text{dwell}} = 15\text{ s}$) per palina.

## Esportazione Relazionale Standardizzata GTFS
A valle delle modifiche cartografiche ed orarie, l'Editor offre un doppio canale di persistenza:
1. **View JSON (KM4City Patch):** Generazione del payload gerarchico ad oggetti con pattern *Copy-on-Write* per ingestion diretta nel Knowledge Graph di Snap4City.
2. **Export Standard (Strict-GTFS Relational):** Download diretto asincrono via Web API `Blob` di un dataset normalizzato 3NF (`agency`, `routes`, `trips`, `stops`, `stop_times`, `shapes`) conforme alle specifiche ufficiali GTFS:
  - Orari formattati in standard esteso `HH:MM:SS`.
  - Coordinate WGS84 standardizzate a 6 decimali.
  - Piena integrità referenziale tra chiavi primarie e chiavi esterne (`trip_id`, `route_id`, `stop_id`, `shape_id`).

## Roadmap Sviluppo (GitFlow)
- [x] **Fase 1**: Refactoring esportazione dati (Strict GTFS / KM4City Ingestion Payload).
- [x] **Fase 2**: Map-matching e ricalcolo distanze spaziali (`shape_dist_traveled`).
- [x] **Fase 3**: Algoritmo stima velocità e interpolazione orari (Monotonia Temporale).
- [x] **Fase 4**: Esportazione relazionale standardizzata GTFS.
- [ ] **Fase 5**: Modulo di calcolo della matrice di coincidenza temporale.
- [ ] **Fase 6**: Salvataggio e trasmissione dati al backend.
```