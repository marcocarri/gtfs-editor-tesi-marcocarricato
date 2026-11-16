/* global turf, $, parent, document, window, fetch, URLSearchParams, Blob, navigator, JSZip */

(async function () {
    const container = document.getElementById('busmap-container');
    const palette = ['#007bff', '#dc3545', '#28a745', '#fd7e14', '#6f42c1', '#20c997', '#e83e8c', '#17a2b8', '#ffc107', '#343a40'];

    let allAgencies = [];
    let oldCoordinates = [];
    let currentlyShowedPinsUri = []; // individual stop serviceUri values
    let currentlyShowedPathsUri = []; // route URIs for drawn paths
    let allLinesData = []; // [{lineObj, agencyUri, stopName, lineColor, routes}] — populated after stop click
    let drawEpoch = 0; // incremented on each stop click to cancel stale background draws
    let editMode = false; // true when "Modifica tratta" edit mode is active
    let editRouteUri = null; // routeUri of the tratta being edited
    let editRouteColor = null; // color of the tratta being edited
    let routeUpdateTimer = null; // debounce timer for trattaRouteUpdated events
    let editLineName = null; // lineName (e.g. "17") of the tratta being edited, for timetable filtering
    let stopOriginalTimes = []; // fetched timetable times per stop (HH:MM), fixed reference
    let stopCurrentTimes = []; // current times per stop (HH:MM), updated when user edits
    let activeEditStopIndex = -1; // index of the stop currently highlighted for editing
    let editStops = []; // stop objects {id,name,serviceUri,lat,lng} kept in sync with marker drags
    let editCurrentWkt = null; // latest route WKT (updated on trattaRouteUpdated)
    let pendingTimeUpdateCallback = null; // set by commit(); called by time update modal buttons
    let navAbortController = null; // aborted at the start of each navigation action to cancel stale fetches
    let isLoading = false; // true while any async nav operation is in-flight
    // ----------------------------------
    // - CUSTOM MODULES: THESIS - START -
    // ----------------------------------
    let editAgencyUri = null;
    let editAgencyName = null;
    let editRouteLongName = null;
    let editRouteLabel = null;
    // ----------------------------------
    // - CUSTOM MODULES: THESIS -  END  -
    // ----------------------------------


    // 'idle' | 'stop_selected' | 'line_selected' | 'tratta_selected'
    let appState = 'idle';
    parent.busMapAppState = 'idle';

    const uid = '2782f15834f2f95b436a0ea32e832dde0a8947a11563c4a373a37a74cbc00d49';
    const pinUid = 'cecf82b6bbd96a94c5f3fb76f30895a9f563ddb0e32188964fd94ffc37483656';
    const commonParams = `requestFrom=user&geometry=true&format=json&lang=it`;
    const categories = 'BusStop;Train_station;Tram_stops;Ferry_stop';
    const apiBase = 'https://www.disit.org/superservicemap/api/v1/';

    // ----------------------------------
    // - CUSTOM MODULES: THESIS - START -
    // ----------------------------------
    // automatically inspects S4C dashboard to find the unique ID of the map widget
    const detectMapWidgetId = () => {
        // default fallback ID, manually updated for every new dashboard
        const fallbackId = 'w_Map_5296_widgetMap47844';
        try {
            const mapEl = parent.document.querySelector('[id^="w_Map_"][id*="_widgetMap"]') ||
                parent.document.querySelector('[id*="_widgetMap"]');
            if (mapEl && mapEl.id) {
                console.log('[MAP-DISCOVERY] Widget mappa agganciato da DOM ->', mapEl.id);
                return mapEl.id;
            }
            if (parent.map && parent.map.mapName) {
                console.log('[MAP-DISCOVERY] Widget mappa agganciato da parent.map ->', parent.map.mapName);
                return parent.map.mapName;
            }
        } catch (err) {
            console.warn('[MAP-DISCOVERY] Scansione fallita, utilizzo ID fallback ->', fallbackId, err);
        }
        console.warn('[MAP-DISCOVERY] Mappa non trovata, utilizzo ID fallback ->', fallbackId);
        return fallbackId;
    };

    // global destination constant for all jQuery calls to the Event Bus
    const MAP_WIDGET_TARGET = detectMapWidgetId();
    // ----------------------------------
    // - CUSTOM MODULES: THESIS -  END  -
    // ----------------------------------

    // --- FUNCTION DEFINITIONS ---

    const tc = (v) => Math.trunc(v * 1e5) / 1e5; // truncate to 5 decimal places

    const getLineColor = (index) => palette[index % palette.length];

    // ----------------------------------
    // - CUSTOM MODULES: THESIS - START -
    // ----------------------------------
    // intercepts routing calls from map and extracts the updated waypoints without dependencies from the S4C platform
    const targetWindow = parent.window || window;
    const nativeFetch = targetWindow.fetch;
    const SNAP4CITY_ROUTING_URL = 'https://www.snap4city.org/whatif-router/route';
    targetWindow.fetch = function(...args) {
        let url = args[0];
        // correct the URL on the map widget call
        if (typeof url === 'string' && (url.startsWith('null?') || url.includes('/null?'))) {
            url = url.replace(/.*null\?/, SNAP4CITY_ROUTING_URL + '?');
            args[0] = url;
            console.log('[ROUTING-PROXY] URL corretto e reindirizzato a whatif-router ->', url);
        }
        // passive background extraction of the correct coordinates
        setTimeout(() => {
            if (typeof url === 'string' && url.includes('waypoints=')) {
                try {
                    const match = url.match(/waypoints=([^&]+)/);
                    if (match && match[1]) {
                        const rawPairs = decodeURIComponent(match[1]).split(';');
                        rawPairs.forEach((pair, idx) => {
                            const [lngStr, latStr] = pair.split(',');
                            const lng = parseFloat(parseFloat(lngStr).toFixed(6));
                            const lat = parseFloat(parseFloat(latStr).toFixed(6));
                            if (!isNaN(lat) && !isNaN(lng) && editStops[idx]) {
                                editStops[idx].lat = lat;
                                editStops[idx].lng = lng;
                            }
                        });
                        console.log('[ROUTING-PROXY] Coordinate fermate sincronizzate dai waypoints');
                    }
                } catch (err) {
                    console.warn('[ROUTING-PROXY] Errore nel parsing delle coordinate dei waypoints:', err);
                }
            }
        }, 0);
        // return the native fetch intact with the correct URL to the map widget
        return nativeFetch.apply(this, args);
    };

    // prevents a fatal 'ReferenceError' triggered by the S4C platform when the editor is loaded in a clone that lacks
    // URL parameters. Ensures that map listeners do not interrupt the execution chain
    try {
        if (typeof parent.dashboardParams === 'undefined') {
            parent.dashboardParams = {};
        }
    } catch (err) {
        console.warn('[HOST-ENV] Accesso negato a dashboardParams (scope protetto):', err);
    }

    // modular calculation of the progressive distances of the stops along the WKT route
    const computeStopsDistances = (wktString, stopsArray) => {
        const globalTurf = turf || turf;
        if (!wktString || !stopsArray || stopsArray.length === 0 || typeof globalTurf === 'undefined'){
            console.warn(`[TOPOLOGY] Calcolo distanze annullato: geometria WKT o libreria Turf.js non disponibile`);
            return;
        }
        try {
            const coordsString = wktString.replace('LINESTRING', '').replace('(', '').replace(')', '').trim();
            const coordsArray = coordsString.split(',').map(pair => {
                const [lng, lat] = pair.trim().split(' ').map(Number);
                return [lng, lat];
            });
            const routeLineString = globalTurf.lineString(coordsArray);
            stopsArray.forEach((stop) => {
                const stopPoint = globalTurf.point([stop.lng, stop.lat]);
                const snapped = globalTurf.nearestPointOnLine(routeLineString, stopPoint);
                stop.shape_dist_traveled = parseFloat((snapped.properties.location * 1000).toFixed(2));
            });
            console.log(`[TOPOLOGY] Calcolo distanze completato (${stopsArray.length} fermate analizzate)`);
        } catch (err) {
            console.warn('[TOPOLOGY] Errore nel calcolo delle distanze con Turf.js:', err);
        }
    };

    // benchmark const values
    const DEFAULT_URBAN_SPEED_MPS = 4.44;       // 16km/h --> 4.4m/s
    const DWELL_TIME_SECONDS = 15;              // standard dwell time at the bus stop
    // physical constraints on the commercial speed of public transport
    const SPEED_LIMIT_MIN_MPS = 0.83;           // ~3 km/h (minimum congestion threshold)
    const SPEED_LIMIT_URBAN_MAX_MPS = 13.88;    // ~50 km/h (urban legal limit)
    const SPEED_LIMIT_EXTRA_MAX_MPS = 22.22;    // ~80 km/h (extra-urban legal limit)
    const SPEED_LIMIT_HIGHWAY_MAX_MPS = 27.78;  // ~100 km/h (highway legal limit)
    // metric thresholds for spacing between stops (meters)
    const REGIME_URBAN_DENSE_THRESHOLD = 300;
    const REGIME_EXTRAURBAN_THRESHOLD = 1200;
    const REGIME_HIGHWAY_THRESHOLD = 4000;

    // converts a time string into an integer number of seconds
    const timeStringToSeconds = (timeStr) => {
        if (!timeStr) return null;
        const parts = timeStr.split(':').map(Number);
        if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return null;
    };
    // converts an integer number of seconds into a time string
    const secondsToTimeString = (totalSecs) => {
        if (totalSecs === null || isNaN(totalSecs)) return null;
        const hours = Math.floor(totalSecs / 3600);
        const minutes = Math.floor((totalSecs % 3600) / 60);
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    };

    // local cache to avoid flooding Overpass API
    let osmRouteCache = {
        routeUri: null,
        busLaneMeters: 0,
        roadWeights: []
    };

    // calculates the geographic bounding box for a set of stops
    const computeBoundingBox = (stops) => {
        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
        stops.forEach(s => {
            if (s.lat < minLat) minLat = s.lat;
            if (s.lat > maxLat) maxLat = s.lat;
            if (s.lng < minLng) minLng = s.lng;
            if (s.lng > maxLng) maxLng = s.lng;
        });
        // margin of tolerance (~200m)
        return `${minLat - 0.002},${minLng - 0.002},${maxLat + 0.002},${maxLng + 0.002}`;
    };

    // queries the OpenStreetMap Overpass API to detect priority lanes
    const fetchOsmTransitData = async (stops, routeUri) => {
        const globalTurf = turf || turf;
        if (osmRouteCache.routeUri === routeUri) return osmRouteCache;
        const bbox = computeBoundingBox(stops);
        // look for roads with dedicated bus lanes within the area covered by the route
        const overpassQuery = `[out:json][timeout:10];(way["lanes:bus"](${bbox});way["highway"="busway"](${bbox}););out geom;`;
        const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;
        let totalBusLaneMeters = 0;
        try {
            const response = await fetch(overpassUrl);
            const data = await response.json();
            if (data && data.elements && data.elements.length > 0 && typeof globalTurf !== 'undefined') {
                data.elements.forEach(element => {
                    if (element.geometry && element.geometry.length > 1) {
                        // converts the OSM coordinates in GeoJSON format for Turf.js to get the bus lanes length
                        const coords = element.geometry.map(pt => [pt.lon, pt.lat]);
                        const line = globalTurf.lineString(coords);
                        totalBusLaneMeters += globalTurf.length(line, { units: 'meters' });
                    }
                });
            }
            console.log(`[OSM-TRANSIT] Corsie preferenziali rilevate -> ${totalBusLaneMeters > 0 ? Math.round(totalBusLaneMeters) + ' metri' : 'Nessuna'}`);
            osmRouteCache = {
                routeUri: routeUri,
                busLaneMeters: totalBusLaneMeters
            };
        } catch (err) {
            console.warn('[OSM-TRANSIT] Overpass API non disponibile, attivo modello di fallback:', err);
            osmRouteCache = { routeUri: routeUri, busLaneMeters: 0 };
        }
        return osmRouteCache;
    };

    // calculate the speed weight for a segment between stop k-1 and stop k
    const getSegmentSpeedWeight = (prevStop, currStop, busLaneMeters) => {
        let weight = 1.0; // baseline (urban standard)
        // heuristic weighting based on node spacing: if stops are very close together, we are in an area that entails slower movement speeds
        const segmentDist = Math.max(0, (currStop.shape_dist_traveled || 0) - (prevStop.shape_dist_traveled || 0));
        if (busLaneMeters > 0 && segmentDist > 0) { // dedicated bus lanes bonus, weighted by the impact of the lane on the segment (+25% * [0;1])
            const coverageRatio = Math.min(1.0, busLaneMeters / segmentDist);
            weight += (0.25 * coverageRatio);
        }
        if (segmentDist > 0 && segmentDist < REGIME_URBAN_DENSE_THRESHOLD) {
            weight *= 0.80; // urban dense
        } else if (segmentDist >= REGIME_HIGHWAY_THRESHOLD) {
            weight *= 4.50; // highway
        } else if (segmentDist >= REGIME_EXTRAURBAN_THRESHOLD) {
            weight *= 2.50; // extra-urban
        } else if (segmentDist > 700) {
            weight *= 1.15; // urban NOT dense
        }
        return weight;
    };

    // calculate the effective speed of a segment by applying OSM weights and regulatory clamping.
    const calculateEffectiveSpeed = (stopA, stopB, busLaneMeters, segmentMeters) => {
        // heterogeneous segment weighting (OSM-based)
        const weight = getSegmentSpeedWeight(stopA, stopB, busLaneMeters);
        let effectiveSpeed = DEFAULT_URBAN_SPEED_MPS * weight;
        // dynamic speed ceiling selection
        let currentSpeedCeiling = SPEED_LIMIT_URBAN_MAX_MPS;
        if (segmentMeters >= REGIME_HIGHWAY_THRESHOLD) {
            currentSpeedCeiling = SPEED_LIMIT_HIGHWAY_MAX_MPS;
        } else if (segmentMeters >= REGIME_EXTRAURBAN_THRESHOLD) {
            currentSpeedCeiling = SPEED_LIMIT_EXTRA_MAX_MPS;
        }
        // plausibility filter (dynamic clamping): prevents speed dropping below walking pace or exceeding regime legal limits
        if (effectiveSpeed < SPEED_LIMIT_MIN_MPS) effectiveSpeed = SPEED_LIMIT_MIN_MPS;
        if (effectiveSpeed > currentSpeedCeiling) effectiveSpeed = currentSpeedCeiling;
        return { effectiveSpeed, weight };
    };

    // interpolates proportionally the time stamps in a trip using the cumulative distances calculated using Turf.js
    const interpolateTimetable = (stops, currentTimes, startIndex = 0, osmData = null) => {
        if (!stops || stops.length === 0) return;
        const busLaneMeters = osmData ? (osmData.busLaneMeters || 0) : 0;
        const isValidTime = (t) => t !== null && t !== undefined && t !== '-' && t !== '';
        // set departure default fallback if not a single stop has an assigned time (null guard)
        const hasAnyValidTime = currentTimes.some(isValidTime);
        if (!hasAnyValidTime) {
            currentTimes[0] = "08:00"; // deterministic default fallback
            console.warn('[TIMETABLE] Nessun orario valido trovato: capolinea impostato a ', currentTimes[0]);
        }
        // retro propagation to resolve leading nulls (head gaps)
        if (startIndex === 0) {
            const firstKnownIdx = currentTimes.findIndex(isValidTime);
            if (firstKnownIdx > 0) {
                console.log(`[TIMETABLE] Risoluzione buchi iniziali a ritroso (fermate 1 - ${firstKnownIdx})`);
                for (let k = firstKnownIdx - 1; k >= 0; k--) {
                    const prevDist = stops[k].shape_dist_traveled || 0;
                    const nextDist = stops[k + 1].shape_dist_traveled || prevDist;
                    const segmentMeters = Math.max(0, nextDist - prevDist);
                    const { effectiveSpeed } = calculateEffectiveSpeed(stops[k], stops[k + 1], busLaneMeters, segmentMeters);
                    const runningSecs = Math.round(segmentMeters / effectiveSpeed);
                    const nextSecs = timeStringToSeconds(currentTimes[k + 1]);
                    const currSecs = Math.max(0, nextSecs - runningSecs - DWELL_TIME_SECONDS);
                    currentTimes[k] = secondsToTimeString(currSecs);
                    console.log(`[TIMETABLE] Fermata ${k + 1} retro-calcolata -> ${currentTimes[k]} (+${segmentMeters}m)`);
                }
            }
        }
        // two-pointer scanner to cover arbitrary patterns (internal & tail gaps)
        if (startIndex === 0) {
            let i = 0;
            while (i < stops.length - 1) {
                if (isValidTime(currentTimes[i + 1])) {
                    i++;
                    continue;
                }
                let nextKnownIdx = -1;
                for (let j = i + 1; j < stops.length; j++) {
                    if (isValidTime(currentTimes[j])) {
                        nextKnownIdx = j;
                        break;
                    }
                }
                if (nextKnownIdx !== -1) { // closed window case
                    const sA = stops[i].shape_dist_traveled || 0;
                    const sB = stops[nextKnownIdx].shape_dist_traveled || sA;
                    const tA = timeStringToSeconds(currentTimes[i]);
                    const tB = timeStringToSeconds(currentTimes[nextKnownIdx]);
                    const deltaDist = Math.max(0, sB - sA);
                    const deltaTime = Math.max(0, tB - tA);
                    for (let k = i + 1; k < nextKnownIdx; k++) {
                        const sK = stops[k].shape_dist_traveled || sA;
                        const ratio = deltaDist > 0 ? (sK - sA) / deltaDist : 0;
                        const tK = Math.round(tA + ratio * deltaTime);
                        currentTimes[k] = secondsToTimeString(tK);
                        console.log(`[TIMETABLE] Fermata ${k + 1} interpolata tra ${i + 1} e ${nextKnownIdx + 1} -> ${currentTimes[k]}`);
                    }
                    i = nextKnownIdx;
                } else { // open window case
                    for (let k = i + 1; k < stops.length; k++) {
                        const prevDist = stops[k - 1].shape_dist_traveled || 0;
                        const currDist = stops[k].shape_dist_traveled || prevDist;
                        const segmentMeters = Math.max(0, currDist - prevDist);
                        const prevSecs = timeStringToSeconds(currentTimes[k - 1]);
                        const { effectiveSpeed } = calculateEffectiveSpeed(stops[k - 1], stops[k], busLaneMeters, segmentMeters);
                        const runningSecs = Math.round(segmentMeters / effectiveSpeed);
                        const currSecs = prevSecs + runningSecs + DWELL_TIME_SECONDS;
                        currentTimes[k] = secondsToTimeString(currSecs);
                        console.log(`[TIMETABLE] Fermata ${k + 1} calcolata a fine tratta -> ${currentTimes[k]} (+${segmentMeters}m)`);
                    }
                    break;
                }
            }
        } else { // cascade interpolation for modified stops
            for (let k = startIndex; k < stops.length; k++) {
                const prevDist = stops[k - 1].shape_dist_traveled || 0;
                const currDist = stops[k].shape_dist_traveled || prevDist;
                const segmentMeters = Math.max(0, currDist - prevDist);
                const prevSecs = timeStringToSeconds(currentTimes[k - 1]);
                if (prevSecs === null) continue;
                const { effectiveSpeed } = calculateEffectiveSpeed(stops[k - 1], stops[k], busLaneMeters, segmentMeters);
                const runningSecs = Math.round(segmentMeters / effectiveSpeed);
                const currSecs = prevSecs + runningSecs + DWELL_TIME_SECONDS;
                currentTimes[k] = secondsToTimeString(currSecs);
                console.log(`[TIMETABLE] Fermata ${k + 1} aggiornata a cascata -> ${currentTimes[k]} (+${segmentMeters}m)`);
            }
        }
    };

    // save & export GTFS-not-normalized json document
    const buildExportJson = () => {
        // generate unique id by using timestamp
        const timestamp = new Date().getTime();
        const clonedTripId = `${editRouteUri}_TRIP_${timestamp}`;
        const clonedShapeId = `${editRouteUri}_SHAPE_${timestamp}`;
        // map new stops and stops_times
        const gtfsStopTimes = editStops.map((s, i) => {
            const nameEl = container.querySelector(`#editStopName-${i}`);
            const currentName = nameEl ? (nameEl.textContent || nameEl.value || s.name) : s.name;
            const sequence = i + 1;
            const id = s.serviceUri ? s.serviceUri : "TEMP_STOP_" + sequence;
            const scheduledTime = stopCurrentTimes[i] || null;
            return {
                stop_sequence: sequence,
                stop_id: id,
                stop_name: currentName,
                stop_lat: s.lat,
                stop_lon: s.lng,
                arrival_time: scheduledTime,
                departure_time: scheduledTime,
                shape_dist_traveled: s.shape_dist_traveled !== undefined ? s.shape_dist_traveled : null
            };
        });
        console.log(`[EXPORT] Payload GTFS normalizzato generato -> ${gtfsStopTimes.length} fermate serializzate (Corsa: ${clonedTripId})`);
        // payload assembly
        return {
            entityType: "PublicTransportRoutePatch",
            metadata: {
                modifiedAt: new Date().toISOString(),
                requiresCopyOnWrite: true,
                exportedBy: "GTFS_Editor_Tesi"
            },
            route: {
                route_id: editRouteUri,
                route_short_name: editLineName,
                route_color: editRouteColor
            },
            trip: {
                trip_id: clonedTripId
            },
            shape: {
                shape_id: clonedShapeId,
                wkt_geometry: editCurrentWkt || null
            },
            stop_times: gtfsStopTimes
        };
    };

    // sanitizes KM4City URIs or raw strings into RDF-safe GTFS identifiers
    const sanitizeGtfsId = (rawId, fallback = 'UNKNOWN') => {
        if (!rawId) return fallback;
        const str = String(rawId);
        const tail = str.includes('/') ? str.substring(str.lastIndexOf('/') + 1) : str;
        const clean = tail.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        return clean || fallback;
    };

    // parses a WKT LINESTRING into an array of [lon, lat] WGS84 coordinates
    const parseWktLineString = (wktString) => {
        if (!wktString || typeof wktString !== 'string') return [];
        const match = wktString.match(/LINESTRING\s*\(\s*([^)]+)\s*\)/i);
        if (!match || !match[1]) return [];
        return match[1].split(',').map(pair => {
            const parts = pair.trim().split(/\s+/).map(Number);
            if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                return [parseFloat(parts[0].toFixed(6)), parseFloat(parts[1].toFixed(6))];
            }
            return null;
        }).filter(Boolean);
    };

    // serializes an array of objects into an RFC 4180 compliant CSV string
    const toCsv = (rows, columns) => {
        const escapeCell = (val) => {
            if (val === null || val === undefined) return '';
            const str = String(val);
            if (/[",\n\r]/.test(str)) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };
        const header = columns.join(',');
        const body = rows.map(row => columns.map(col => escapeCell(row[col])).join(','));
        return [header, ...body].join('\n');
    };

    // save & export GTFS-normalized 3NF relational dataset
    const buildStandardizedPayload = () => {
        const timestamp = new Date().getTime();
        const todayYmd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const serviceId = 'SRV_DEFAULT';
        const agencyId = sanitizeGtfsId(editAgencyUri, 'AGENCY_1');
        const agencyObj = allAgencies.find(a => a.agency === editAgencyUri);
        const agencyName = editAgencyName || agencyObj?.name || 'Snap4City TPL Agency';
        const routeId = sanitizeGtfsId(editRouteUri, `ROUTE_${timestamp}`);
        const tripId = `${routeId}_TRIP_${timestamp}`;
        const shapeId = `${routeId}_SHAPE_${timestamp}`;
        const cleanColor = editRouteColor ? editRouteColor.replace('#', '').toUpperCase() : '007BFF';
        // deduplicate stops by sanitized stop_id to preserve GTFS primary key uniqueness
        const stopsMap = new Map();
        const stopTimesRows = [];
        editStops.forEach((s, i) => {
            const nameEl = container.querySelector(`#editStopName-${i}`);
            const currentName = nameEl ? (nameEl.textContent || nameEl.value || s.name) : s.name;
            const stopId = sanitizeGtfsId(s.serviceUri, `TEMP_STOP_${i + 1}`);
            if (!stopsMap.has(stopId)) {
                stopsMap.set(stopId, {
                    stop_id: stopId,
                    stop_code: stopId,
                    stop_name: currentName || `Fermata ${i + 1}`,
                    stop_lat: s.lat,
                    stop_lon: s.lng
                });
            }
            const rawTime = stopCurrentTimes[i] || '08:00';
            const formattedTime = rawTime.length === 5 ? `${rawTime}:00` : rawTime;
            stopTimesRows.push({
                trip_id: tripId,
                arrival_time: formattedTime,
                departure_time: formattedTime,
                stop_id: stopId,
                stop_sequence: i + 1,
                shape_dist_traveled: s.shape_dist_traveled !== undefined ? s.shape_dist_traveled : ''
            });
        });
        // explode WKT LINESTRING into tabular GTFS shapes rows with cumulative meters
        let shapeCoords = parseWktLineString(editCurrentWkt);
        if (shapeCoords.length < 2) {
            shapeCoords = editStops.map(s => [s.lng, s.lat]);
        }
        let cumDistMeters = 0;
        const shapesRows = shapeCoords.map(([lon, lat], idx) => {
            if (idx > 0 && typeof turf !== 'undefined') {
                try {
                    const prev = turf.point(shapeCoords[idx - 1]);
                    const curr = turf.point([lon, lat]);
                    cumDistMeters += turf.distance(prev, curr, { units: 'meters' });
                } catch (err) {
                    console.warn('[EXPORT] Errore calcolo distanza vertice shape:', err);
                }
            }
            return {
                shape_id: shapeId,
                shape_pt_lat: lat,
                shape_pt_lon: lon,
                shape_pt_sequence: idx + 1,
                shape_dist_traveled: parseFloat(cumDistMeters.toFixed(2))
            };
        });
        const payload = {
            agency: [{
                agency_id: agencyId,
                agency_name: agencyName,
                agency_url: 'https://www.snap4city.org',
                agency_timezone: 'Europe/Rome',
                agency_lang: 'it'
            }],
            calendar_dates: [{
                service_id: serviceId,
                date: todayYmd,
                exception_type: 1
            }],
            routes: [{
                route_id: routeId,
                agency_id: agencyId,
                route_short_name: editLineName || routeId,
                route_long_name: editRouteLongName || editRouteLabel || editLineName || 'Linea TPL',
                route_type: 3,
                route_color: cleanColor,
                route_text_color: 'FFFFFF'
            }],
            trips: [{
                route_id: routeId,
                service_id: serviceId,
                trip_id: tripId,
                trip_headsign: editRouteLabel || editRouteLongName || editLineName || 'Capolinea',
                trip_short_name: editLineName || '',
                direction_id: 0,
                shape_id: shapeId
            }],
            stops: Array.from(stopsMap.values()),
            stop_times: stopTimesRows,
            shapes: shapesRows
        };
        console.log(`[EXPORT] Payload relazionale GTFS generato -> ${payload.stops.length} fermate, ${payload.shapes.length} vertici shape, corsa: ${tripId}`);
        return payload;
    };
    // ----------------------------------
    // - CUSTOM MODULES: THESIS -  END  -
    // ----------------------------------

    // Abort any in-flight nav fetch, create a fresh controller and return its signal
    const startNav = () => {
        if (navAbortController) navAbortController.abort();
        navAbortController = new AbortController();
        return navAbortController.signal;
    };

    const showEditError = (msg) => {
        const el = container.querySelector('#editError');
        if (msg) {
            el.textContent = msg;
            el.style.display = 'block';
        } else {
            el.textContent = '';
            el.style.display = 'none';
        }
    };

    const setLoading = (v) => {
        isLoading = v;
        container.querySelector('#loadingOverlay').style.display = v ? 'flex' : 'none';
    };

    const setAppState = (state) => {
        appState = state;
        parent.busMapAppState = state;
        console.log('[busmap] setAppState:', state, '| parent.busMapAppState:', parent.busMapAppState);
        container.querySelector('#btnResetMap').style.display = state === 'idle' ? 'none' : 'inline-block';
    };

    const resetApp = () => {
        if (editMode) exitEditMode();
        if (navAbortController) navAbortController.abort();

        isLoading = false;
        container.querySelector('#loadingOverlay').style.display = 'none';
        drawEpoch++;
        removeTrattaPaths();

        const staleUris = [...currentlyShowedPinsUri];
        removeBusStopPins();

        setTimeout(() => {
            for (const u of staleUris) {
                parent.$('body').trigger({
                    type: 'removeSelectorPin',
                    target: MAP_WIDGET_TARGET,
                    passedData: {
                        query: `${apiBase}?serviceUri=${encodeURIComponent(u)}&requestFrom=user&format=json&uid=${pinUid}&lang=it`,
                        desc: u,
                        display: ''
                    }
                });
            }
        }, 1500);

        trattaStops = [];
        trattaPinsShown = false;

        if (oldCoordinates && oldCoordinates.length > 0) {
            parent.$('body').trigger({
                type: 'removeGeoInfoPin',
                target: MAP_WIDGET_TARGET,
                passedData: [{ eventType: 'GeoInfoPin', id: 'mapPoint', lat: oldCoordinates[1], lng: oldCoordinates[0], textHtml: '' }]
            });
            oldCoordinates = [];
        }

        allLinesData = [];
        container.querySelector('#linesList').innerHTML = '';
        container.querySelector('#tratteList').innerHTML = '';
        container.querySelector('#fermateList').innerHTML = '';

        for (const id of ['#agencyInfo', '#linesInfo', '#tratteInfo', '#fermateInfo']) {
            const el = container.querySelector(id);
            el.innerHTML = '';
            el.style.display = 'none';
        }

        // Rebuild agency buttons
        const agenciesList = container.querySelector('#agenciesList');
        agenciesList.innerHTML = '';
        allAgencies.forEach(agency => {
            const button = document.createElement('button');
            button.textContent = agency.name;
            button.onclick = () => handleAgencyClick(agency);
            agenciesList.appendChild(button);
        });

        // Reset modifica tratta button to disabled
        editRouteUri = null;
        editRouteColor = null;
        const btnMod = container.querySelector('#btnModificaTratta');
        btnMod.disabled = true;
        btnMod.innerHTML = 'Modifica tratta';
        btnMod.style.cssText = 'width:auto !important; padding:6px 14px !important; background-color:#6c757d !important; color:white !important; border:none !important; border-radius:4px !important; cursor:not-allowed !important; font-weight:500 !important; white-space:nowrap !important; opacity:0.6 !important; font-size:0.85rem !important;';

        setAppState('idle');
    };

    const switchTab = (tabId) => {
        container.querySelectorAll('.tab').forEach(t => {
            t.style.backgroundColor = '#f8f9fa';
            t.style.borderBottom = 'none';
            t.style.fontWeight = '500';
            t.style.color = '#666';
            t.style.bottom = '0';
        });

        container.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');

        const activeTab = container.querySelector('#' + tabId);
        if (activeTab) {
            activeTab.style.backgroundColor = '#ffffff';
            activeTab.style.borderBottom = '1px solid #fff';
            activeTab.style.fontWeight = '600';
            activeTab.style.color = '#007bff';
            activeTab.style.position = 'relative';
            activeTab.style.bottom = '-1px';
        }

        const content = container.querySelector('#' + tabId + 'Content');
        if (content) content.style.display = 'block';
    };

    const removeTrattaPaths = () => {
        for (let i = currentlyShowedPathsUri.length - 1; i >= 0; i--) {
            const uri = currentlyShowedPathsUri[i];
            parent.$('body').trigger({
                type: 'removeBusRoute',
                target: MAP_WIDGET_TARGET,
                passedData: { desc: uri }
            });
            currentlyShowedPathsUri.splice(i, 1);
        }
    };

    const drawRoutePath = (routeUri, wktGeometry, color) => {
        if (!wktGeometry) return;
        parent.$('body').trigger({
            type: 'drawBusRoute',
            target: MAP_WIDGET_TARGET,
            passedData: { desc: routeUri, wktGeometry, color }
        });
        currentlyShowedPathsUri.push(routeUri);
    };

    const enableEditButton = (routeUri, color) => {
        editRouteUri = routeUri;
        editRouteColor = color;
        const btn = container.querySelector('#btnModificaTratta');
        btn.innerHTML = "Modifica tratta";
        btn.disabled = false;
        btn.style.backgroundColor = '#007bff';
        btn.style.cursor = 'pointer';
        btn.style.opacity = '1';
    };

    const handleTrattaClick = async (routeUri, wktGeometry, color, lineName = null, routeLabel = '') => {
        if (isLoading || appState !== 'line_selected') return;
        if (editMode) exitEditMode();

        const signal = startNav();
        drawEpoch++;
        const myEpoch = drawEpoch;

        removeTrattaPaths();
        drawRoutePath(routeUri, wktGeometry, color);

        editLineName = lineName;
        editCurrentWkt = wktGeometry || null;
        enableEditButton(routeUri, color);

        const tratteInfoDiv = container.querySelector('#tratteInfo');
        tratteInfoDiv.innerHTML += (routeLabel ? `<br><strong>Tratta:</strong> ${routeLabel}` : '');
        container.querySelector('#tratteList').innerHTML = '';

        const fermateInfoDiv = container.querySelector('#fermateInfo');
        fermateInfoDiv.innerHTML = '<div>' +
            (lineName ? `<strong>Linea:</strong> ${lineName}` : '') +
            (lineName && routeLabel ? '<br>' : '') +
            (routeLabel ? `<strong>Tratta:</strong> ${routeLabel}` : '') +
            '</div>';
        fermateInfoDiv.style.display = (lineName || routeLabel) ? 'flex' : 'none';

        setAppState('tratta_selected');
        switchTab('tabFermate');
        setLoading(true);

        try {
            await addRouteStopPins([{ route: routeUri }], myEpoch, signal);
        } finally {
            setLoading(false);
        }
    };

    const enterEditMode = async () => {
        editMode = true;
        drawEpoch++;
        showEditError(null);
        removeBusStopPins();

        const params = new URLSearchParams({ route: editRouteUri, requestFrom: 'user', uid: uid });
        let stops = [];

        try {
            const stopData = await (await fetch(`${apiBase}tpl/bus-stops/?${params}`)).json();
            const features = stopData?.BusStops?.features || [];
            stops = features.map((f, i) => ({
                id: i,
                name: f.properties?.name || 'Fermata',
                serviceUri: f.properties?.serviceUri || null,
                lat: f.geometry.coordinates[1],
                lng: f.geometry.coordinates[0]
            }));
        } catch (e) {
            console.error(e);
        }

        editStops = stops.map(s => ({ ...s }));

        if (editCurrentWkt) {
            computeStopsDistances(editCurrentWkt, editStops);
        }

        const editList = container.querySelector('#editStopsList');
        editList.innerHTML = '';
        stopOriginalTimes = [];
        stopCurrentTimes = [];
        activeEditStopIndex = -1;

        stops.forEach((s, i) => {
            const li = document.createElement('li');
            li.id = `editStop-${i}`;
            li.style.cssText = 'padding: 4px 0 !important; font-size: 0.9rem !important; color: #333 !important; display: flex !important; justify-content: space-between !important; align-items: center !important; gap: 8px !important;';

            const nameWrapper = document.createElement('span');
            nameWrapper.style.cssText = 'display: inline-flex !important; align-items: center !important; gap: 2px !important; flex: 1 !important; min-width: 0 !important; overflow: hidden !important;';

            const numSpan = document.createElement('span');
            numSpan.textContent = `${i + 1}. `;
            numSpan.style.cssText = 'white-space: nowrap !important; flex-shrink: 0 !important;';

            const nameSpan = document.createElement('span');
            nameSpan.id = `editStopName-${i}`;
            nameSpan.textContent = s.name;

            nameWrapper.appendChild(numSpan);
            nameWrapper.appendChild(nameSpan);

            const timeSpan = document.createElement('span');
            timeSpan.id = `editStopTime-${i}`;
            timeSpan.style.cssText = 'font-size: 0.8rem !important; white-space: nowrap !important; color: #aaa !important;';
            timeSpan.textContent = (s.serviceUri && editLineName) ? '…' : '';

            li.appendChild(nameWrapper);
            li.appendChild(timeSpan);
            editList.appendChild(li);
        });

        container.querySelector('#radiusRow').style.display = 'none';
        container.querySelector('#tabs').style.display = 'none';
        container.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
        container.querySelector('#editPanel').style.display = 'block';

        const btn = container.querySelector('#btnModificaTratta');
        btn.innerHTML = "Esci da modifica tratta";
        btn.style.cssText = 'width:auto !important; padding:8px 14px !important; background-color:#ffc107 !important; color:#333 !important; border:none !important; border-radius:4px !important; cursor:pointer !important; font-weight:600 !important; white-space:nowrap !important; opacity:1 !important;';
        btn.style.display = 'block';

        parent.$('body').trigger({
            type: 'startEditTratta',
            target: MAP_WIDGET_TARGET,
            passedData: { stops: stops.map(s => ({ lat: s.lat, lng: s.lng })), color: editRouteColor }
        });

        if (editLineName && stops.length > 0) {
            let tripUri = null;
            let minTime = '00:00:00';
            let timeErrors = 0;
            let timesLoaded = 0;

            for (let i = 0; i < stops.length; i++) {
                if (!editMode) return;
                const s = stops[i];
                if (!s.serviceUri) continue;
                const timeSpan = container.querySelector(`#editStopTime-${i}`);
                if (!timeSpan) continue;

                try {
                    const tParams = new URLSearchParams({ serviceUri: s.serviceUri, requestFrom: 'user', format: 'json', uid: uid, lang: 'it' });
                    const data = await (await fetch(`${apiBase}?${tParams}`)).json();
                    if (!editMode) return;

                    const bindings = data?.timetable?.results?.bindings || [];

                    let match = tripUri ? bindings.find(b => b.trip?.value === tripUri) : null;

                    if (!match) {
                        match = bindings.find(b =>
                            b.lineName?.value === editLineName &&
                            (b.departureTime?.value || b.arrivalTime?.value || '00:00:00') >= minTime
                        );
                    }

                    const time = match?.departureTime?.value || match?.arrivalTime?.value || null;
                    if (time) {
                        const displayTime = time.substring(0, 5);
                        timeSpan.textContent = displayTime;
                        timeSpan.style.cssText = `font-size: 0.8rem !important; white-space: nowrap !important; font-weight: 600 !important; color: ${editRouteColor} !important;`;
                        stopOriginalTimes[i] = displayTime;
                        stopCurrentTimes[i] = displayTime;
                        timesLoaded++;
                        minTime = time;
                        if (!tripUri && match?.trip?.value) tripUri = match.trip.value;
                    } else {
                        timeSpan.textContent = '-';
                        stopOriginalTimes[i] = null;
                        stopCurrentTimes[i] = null;
                    }
                } catch (e) {
                    timeErrors++;
                    if (timeSpan) timeSpan.textContent = '-';
                }
            }

            fetchOsmTransitData(editStops, editRouteUri).then(osmData => {
                interpolateTimetable(editStops, stopCurrentTimes, 0, osmData);
                editStops.forEach((s, idx) => {
                    const timeSpan = container.querySelector(`#editStopTime-${idx}`);
                    if (timeSpan && stopCurrentTimes[idx]) {
                        timeSpan.textContent = stopCurrentTimes[idx];
                        timeSpan.style.cssText = `font-size: 0.8rem !important; white-space: nowrap !important; font-weight: 600 !important; color: ${editRouteColor} !important;`;
                    }
                });
            });

            if (timeErrors > 0) {
                showEditError(`Impossibile caricare gli orari per ${timeErrors} fermat${timeErrors === 1 ? 'a' : 'e'}`);
            } else if (timesLoaded === 0) {
                showEditError('Nessun orario disponibile per questa tratta');
            }
        } else if (!editLineName) {
            showEditError('Nome linea non disponibile — impossibile caricare gli orari');
        }
    };

    const exitEditMode = () => {
        editMode = false;
        stopOriginalTimes = [];
        stopCurrentTimes = [];
        activeEditStopIndex = -1;
        editStops = [];
        editCurrentWkt = null;
        pendingTimeUpdateCallback = null;
        container.querySelector('#timeUpdateModal').style.display = 'none';

        parent.$('body').trigger({ type: 'stopEditTratta', target: MAP_WIDGET_TARGET, passedData: {} });

        container.querySelector('#radiusRow').style.display = 'flex';
        container.querySelector('#tabs').style.display = 'flex';
        container.querySelector('#editPanel').style.display = 'none';
        switchTab('tabFermate');

        trattaPinsShown = false;
        const showBtn = container.querySelector('#btnShowStopPins');
        if (showBtn) showBtn.textContent = 'Show stops on the map';

        const btn = container.querySelector('#btnModificaTratta');
        btn.innerHTML = "Modifica tratta";
        btn.style.cssText = 'width:auto !important; padding:8px 14px !important; background-color:#007bff !important; color:white !important; border:none !important; border-radius:4px !important; cursor:pointer !important; font-weight:500 !important; white-space:nowrap !important; opacity:1 !important;';
    };

    const toMinutes = (t) => {
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
    };

    const toTime = (mins) => {
        const h = Math.floor(Math.max(0, mins) / 60) % 24;
        const m = Math.max(0, mins) % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    };

    const activateStopEdit = (idx) => {
        if (activeEditStopIndex === idx) return;

        if (activeEditStopIndex >= 0) {
            const prevLi = container.querySelector(`#editStop-${activeEditStopIndex}`);
            if (prevLi) prevLi.style.removeProperty('background-color');
        }

        activeEditStopIndex = idx;

        const li = container.querySelector(`#editStop-${idx}`);
        if (!li) return;
        li.style.setProperty('background-color', '#fff3cd', 'important');
        li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

        const nameEl = container.querySelector(`#editStopName-${idx}`);
        if (nameEl && nameEl.tagName !== 'INPUT') {
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.id = `editStopName-${idx}`;
            nameInput.value = nameEl.textContent;
            nameInput.style.cssText = 'font-size: 0.9rem !important; border: 1px solid #ccc !important; border-radius: 3px !important; padding: 2px 6px !important; flex: 1 !important; min-width: 0 !important; width: 0 !important; color: #333 !important; background: white !important;';
            nameEl.replaceWith(nameInput);
        }

        const span = container.querySelector(`#editStopTime-${idx}`);
        if (!span || span.tagName === 'INPUT') return;

        const originalTime = stopOriginalTimes[idx];
        const baseTime = stopCurrentTimes[idx] || originalTime;

        const input = document.createElement('input');
        input.type = 'time';
        input.id = `editStopTime-${idx}`;
        input.value = baseTime || '';
        input.style.cssText = 'font-size: 0.8rem !important; border: 1px solid #ccc !important; border-radius: 3px !important; padding: 2px 6px !important; width: 100px !important; color: #333 !important; background: white !important;';

        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = '✓';
        confirmBtn.title = 'Conferma orario';
        confirmBtn.disabled = true;
        confirmBtn.style.cssText = 'font-size: 0.75rem !important; padding: 1px 5px !important; background: #28a745 !important; color: white !important; border: none !important; border-radius: 3px !important; cursor: pointer !important; opacity: 0.4 !important; line-height: 1.4 !important;';

        const validate = () => {
            if (!input.value) {
                input.style.setProperty('border-color', '#ccc', 'important');
                input.style.removeProperty('outline');
                confirmBtn.disabled = true;
                confirmBtn.style.setProperty('opacity', '0.4', 'important');
                return false;
            }
            if (originalTime && input.value < originalTime) {
                input.style.setProperty('border-color', '#dc3545', 'important');
                input.style.setProperty('outline', '2px solid #dc3545', 'important');
                confirmBtn.disabled = true;
                confirmBtn.style.setProperty('opacity', '0.4', 'important');
                return false;
            }
            input.style.setProperty('border-color', '#28a745', 'important');
            input.style.removeProperty('outline');
            confirmBtn.disabled = false;
            confirmBtn.style.setProperty('opacity', '1', 'important');
            return true;
        };

        input.addEventListener('input', validate);

        const commit = () => {
            if (!validate()) return;

            pendingTimeUpdateCallback = (applyToFollowing) => {
                const delta = baseTime ? toMinutes(input.value) - toMinutes(baseTime) : 0;
                stopCurrentTimes[idx] = input.value;

                if (applyToFollowing && delta !== 0) {
                    for (let j = idx + 1; j < stopCurrentTimes.length; j++) {
                        if (stopCurrentTimes[j] == null) continue;
                        const newTime = toTime(toMinutes(stopCurrentTimes[j]) + delta);
                        stopCurrentTimes[j] = newTime;
                        const el = container.querySelector(`#editStopTime-${j}`);
                        if (el) {
                            if (el.tagName === 'INPUT') el.value = newTime;
                            else el.textContent = newTime;
                        }
                    }
                }

                const nameInput = container.querySelector(`#editStopName-${idx}`);
                if (nameInput && nameInput.tagName === 'INPUT') {
                    const confirmedName = document.createElement('span');
                    confirmedName.id = `editStopName-${idx}`;
                    confirmedName.textContent = nameInput.value;
                    nameInput.replaceWith(confirmedName);
                }

                const confirmedSpan = document.createElement('span');
                confirmedSpan.id = `editStopTime-${idx}`;
                confirmedSpan.textContent = input.value;
                confirmedSpan.style.cssText = `font-size: 0.8rem !important; white-space: nowrap !important; font-weight: 700 !important; color: ${editRouteColor} !important;`;
                wrapper.replaceWith(confirmedSpan);

                activeEditStopIndex = -1;
            };

            container.querySelector('#timeUpdateModal').style.display = 'flex';
        };

        confirmBtn.addEventListener('click', commit);

        const wrapper = document.createElement('span');
        wrapper.style.cssText = 'display: inline-flex !important; align-items: center !important; gap: 3px !important;';
        wrapper.appendChild(input);
        wrapper.appendChild(confirmBtn);
        span.replaceWith(wrapper);
        input.focus();
    };

    let trattaStops = [];
    let trattaPinsShown = false;

    const addRouteStopPins = async (routes, epoch, signal) => {
        removeBusStopPins();
        trattaStops = [];
        const fermateList = container.querySelector('#fermateList');
        fermateList.innerHTML = '';
        const isTratta = appState === 'tratta_selected';
        const seenUris = new Set();

        for (const r of routes) {
            if (epoch !== drawEpoch) return;
            const params = new URLSearchParams({ route: r.route, requestFrom: 'user', uid: uid });
            try {
                const stopData = await (await fetch(`${apiBase}tpl/bus-stops/?${params}`, { signal })).json();
                const features = stopData?.BusStops?.features || [];

                for (const f of features) {
                    if (epoch !== drawEpoch) return;
                    const uri = f.properties?.serviceUri;
                    if (!uri || seenUris.has(uri)) continue;

                    seenUris.add(uri);
                    const name = f.properties?.name || 'Fermata';

                    if (isTratta) {
                        trattaStops.push({ uri, name });
                        const li = document.createElement('div');
                        li.style.cssText = 'padding: 6px 0 !important; border-bottom: 1px solid #eee !important; font-size: 13px !important; color: #333 !important;';
                        li.textContent = name;
                        fermateList.appendChild(li);
                    } else {
                        const btn = document.createElement('button');
                        btn.textContent = name;
                        btn.onclick = () => clickOnBusStopOnGui(uri);
                        fermateList.appendChild(btn);
                    }
                }
            } catch (e) {
                if (e.name !== 'AbortError') console.error('Error fetching stops for route', r.route, e);
                return;
            }
        }

        if (isTratta && trattaStops.length > 0) {
            trattaPinsShown = false;
            const showBtn = document.createElement('button');
            showBtn.id = 'btnShowStopPins';
            showBtn.textContent = 'Show stops on the map';
            showBtn.style.cssText = 'margin-top: 6px !important; padding: 6px 14px !important; background-color: #007bff !important; color: white !important; border: none !important; border-radius: 4px !important; cursor: pointer !important; font-weight: 500 !important; align-self: flex-start !important;';

            showBtn.onclick = () => {
                if (trattaPinsShown) {
                    const uris = [...currentlyShowedPinsUri];
                    removeBusStopPins();
                    setTimeout(() => {
                        for (const u of uris) {
                            parent.$('body').trigger({
                                type: 'removeSelectorPin',
                                target: MAP_WIDGET_TARGET,
                                passedData: {
                                    query: `${apiBase}?serviceUri=${encodeURIComponent(u)}&requestFrom=user&format=json&uid=${pinUid}&lang=it`,
                                    desc: u,
                                    display: ''
                                }
                            });
                        }
                    }, 1500);
                    trattaPinsShown = false;
                    showBtn.textContent = 'Show stops on the map';
                } else {
                    const btnMod = container.querySelector('#btnModificaTratta');
                    const btnReset = container.querySelector('#btnResetMap');

                    btnMod.disabled = true;
                    btnMod.style.opacity = '0.6';
                    btnMod.style.cursor = 'not-allowed';

                    showBtn.disabled = true;
                    showBtn.style.opacity = '0.6';
                    showBtn.style.cursor = 'not-allowed';

                    btnReset.disabled = true;
                    btnReset.style.opacity = '0.6';
                    btnReset.style.cursor = 'not-allowed';

                    let pending = trattaStops.length;
                    const onPinLoaded = () => {
                        pending--;
                        if (pending <= 0) {
                            btnMod.disabled = false;
                            btnMod.style.opacity = '1';
                            btnMod.style.cursor = 'pointer';

                            showBtn.disabled = false;
                            showBtn.style.opacity = '1';
                            showBtn.style.cursor = 'pointer';

                            btnReset.disabled = false;
                            btnReset.style.opacity = '1';
                            btnReset.style.cursor = 'pointer';
                        }
                    };

                    for (const s of trattaStops) {
                        currentlyShowedPinsUri.push(s.uri);
                        parent.$('body').trigger({
                            type: 'addSelectorPin',
                            target: MAP_WIDGET_TARGET,
                            passedData: {
                                query: `${apiBase}?serviceUri=${encodeURIComponent(s.uri)}&requestFrom=user&format=json&uid=${pinUid}&lang=it`,
                                targets: '',
                                eventGenerator: $(container),
                                color1: '#ffdb4d',
                                color2: '#fff5cc',
                                queryType: 'Default',
                                desc: s.uri,
                                display: 'pins',
                                pinattr: 'square',
                                pincolor: '#959595',
                                noExecute: true,
                                onLoaded: onPinLoaded
                            }
                        });
                    }
                    trattaPinsShown = true;
                    showBtn.textContent = 'Hide stops from the map';
                }
            };
            container.querySelector('#fermateInfo').appendChild(showBtn);
        }
    };

    const fetchRoutesForLine = async (lineData, signal) => {
        if (lineData.routes !== null) return lineData.routes;

        const params = new URLSearchParams({
            line: lineData.lineObj.busLine,
            agency: lineData.agencyUri,
            busStopName: lineData.stopName,
            requestFrom: 'user',
            geometry: 'true',
            uid: uid
        });

        const json = await (await fetch(`${apiBase}tpl/bus-routes/?${params}`, { signal })).json();
        const raw = Array.isArray(json) ? json : (Array.isArray(json?.BusRoutes) ? json.BusRoutes : []);

        lineData.routes = raw.map(r => ({
            route: r.route,
            wktGeometry: r.wktGeometry,
            routeLabel: r.routeName || (r.firstBusStop && r.lastBusStop ? `${r.firstBusStop} → ${r.lastBusStop}` : 'Tratta')
        }));

        return lineData.routes;
    };

    const drawAllLinesInBackground = async (epoch, signal) => {
        for (const lineData of allLinesData) {
            if (epoch !== drawEpoch) return;
            try {
                const routes = await fetchRoutesForLine(lineData, signal);
                for (const r of routes) {
                    if (epoch !== drawEpoch) return;
                    drawRoutePath(r.route, r.wktGeometry, lineData.lineColor);
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            } catch (e) {
                if (e.name !== 'AbortError') console.error('Error drawing line', lineData.lineObj.busLine, e);
            }
        }
    };

    const handleLineClick = async (lineIndex) => {
        if (isLoading || appState !== 'stop_selected') return;

        const signal = startNav();
        drawEpoch++;
        const myEpoch = drawEpoch;

        removeTrattaPaths();
        const lineData = allLinesData[lineIndex];
        if (!lineData) return;

        const linesInfoDiv = container.querySelector('#linesInfo');
        linesInfoDiv.innerHTML = `<strong>Linea:</strong> ${lineData.lineObj.busLine}<br>${lineData.lineObj.lineDesc}`;
        linesInfoDiv.style.display = 'block';
        container.querySelector('#linesList').innerHTML = '';

        setLoading(true);
        try {
            const routes = await fetchRoutesForLine(lineData, signal);
            if (myEpoch !== drawEpoch) return;
            for (const r of routes) drawRoutePath(r.route, r.wktGeometry, lineData.lineColor);

            const list = container.querySelector('#tratteList');
            list.innerHTML = '';

            const tratteInfoDiv = container.querySelector('#tratteInfo');
            tratteInfoDiv.innerHTML = `<strong>Linea:</strong> ${lineData.lineObj.busLine}<br>${lineData.lineObj.lineDesc}`;
            tratteInfoDiv.style.display = 'block';

            if (routes.length === 0) {
                list.textContent = 'No routes found.';
                switchTab('tabTratte');
                return;
            }

            routes.forEach(r => {
                const btn = document.createElement('button');
                const dot = document.createElement('div');
                dot.className = 'color-dot';
                dot.style.backgroundColor = lineData.lineColor;
                btn.appendChild(dot);
                btn.appendChild(document.createTextNode(r.routeLabel));
                btn.onclick = () => handleTrattaClick(r.route, r.wktGeometry, lineData.lineColor, lineData.lineObj.busLine, r.routeLabel);
                list.appendChild(btn);
            });

            setAppState('line_selected');
            switchTab('tabTratte');
            await addRouteStopPins(routes, myEpoch, signal);
        } catch (e) {
            if (e.name !== 'AbortError') console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const handleAgencyLineClick = async (lineObj, agencyUri, lineColor) => {
        if (isLoading || appState !== 'idle') return;

        const signal = startNav();
        drawEpoch++;
        const myEpoch = drawEpoch;

        removeTrattaPaths();
        removeBusStopPins();

        const linesInfoDiv = container.querySelector('#linesInfo');
        linesInfoDiv.innerHTML = `<strong>Linea:</strong> ${lineObj.busLine}`;
        linesInfoDiv.style.display = 'block';
        container.querySelector('#linesList').innerHTML = '';

        setLoading(true);
        const params = new URLSearchParams({ line: lineObj.busLine, agency: agencyUri, requestFrom: 'user', geometry: 'true', uid: uid });

        try {
            const json = await (await fetch(`${apiBase}tpl/bus-routes/?${params}`, { signal })).json();
            if (myEpoch !== drawEpoch) return;

            const routes = Array.isArray(json) ? json : (Array.isArray(json?.BusRoutes) ? json.BusRoutes : []);
            const list = container.querySelector('#tratteList');
            list.innerHTML = '';

            const tratteInfoDiv = container.querySelector('#tratteInfo');
            tratteInfoDiv.innerHTML = `<strong>Linea:</strong> ${lineObj.busLine}`;
            tratteInfoDiv.style.display = 'block';

            if (routes.length === 0) {
                list.textContent = 'No routes found.';
                switchTab('tabTratte');
                return;
            }

            const routeObjects = [];
            for (const r of routes) {
                if (myEpoch !== drawEpoch) return;
                const btn = document.createElement('button');
                const dot = document.createElement('div');
                dot.className = 'color-dot';
                dot.style.backgroundColor = lineColor;
                btn.appendChild(dot);

                const label = r.routeName || (r.firstBusStop && r.lastBusStop ? `${r.firstBusStop} → ${r.lastBusStop}` : 'Tratta');
                btn.appendChild(document.createTextNode(label));
                btn.onclick = () => handleTrattaClick(r.route, r.wktGeometry, lineColor, lineObj.busLine, label);
                list.appendChild(btn);

                drawRoutePath(r.route, r.wktGeometry, lineColor);
                routeObjects.push({ route: r.route });
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            if (myEpoch !== drawEpoch) return;
            setAppState('line_selected');
            switchTab('tabTratte');
            await addRouteStopPins(routeObjects, myEpoch, signal);
        } catch (e) {
            if (e.name !== 'AbortError') console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const removeBusStopPins = (clickedUri = '') => {
        for (let i = currentlyShowedPinsUri.length - 1; i >= 0; i--) {
            const uri = currentlyShowedPinsUri[i];
            if (clickedUri === '' || uri !== clickedUri) {
                parent.$('body').trigger({
                    type: 'removeSelectorPin',
                    target: MAP_WIDGET_TARGET,
                    passedData: {
                        query: `${apiBase}?serviceUri=${encodeURIComponent(uri)}&requestFrom=user&format=json&uid=${pinUid}&lang=it`,
                        desc: uri,
                        display: ''
                    }
                });
                currentlyShowedPinsUri.splice(i, 1);
            }
        }
    };

    const populateLinesTab = (result) => {
        const list = container.querySelector('#linesList');
        list.innerHTML = '';
        allLinesData = [];

        if (!result?.busLines?.results?.bindings) {
            list.textContent = 'No lines found for this stop.';
            return;
        }

        const agencyUri = result.BusStop?.features?.[0]?.properties?.agencyUri || '';
        const agencyName = result.BusStop?.features?.[0]?.properties?.agency || '';
        const stopName  = result.BusStop?.features?.[0]?.properties?.name || '';

        const agencyInfoDiv = container.querySelector('#agencyInfo');
        if (agencyName || stopName) {
            agencyInfoDiv.innerHTML = (stopName ? `<strong>Fermata:</strong> ${stopName}` : '') +
                (stopName && agencyName ? '<br>' : '') +
                (agencyName ? `<strong>Agenzia:</strong> ${agencyName}` : '');
            agencyInfoDiv.style.display = 'block';
            container.querySelector('#agenciesList').innerHTML = '';
        } else {
            agencyInfoDiv.style.display = 'none';
        }

        const linesInfoDiv = container.querySelector('#linesInfo');
        if (stopName) {
            linesInfoDiv.innerHTML = `<strong>Fermata:</strong> ${stopName}`;
            linesInfoDiv.style.display = 'block';
        } else {
            linesInfoDiv.style.display = 'none';
        }

        const linesMap = {};
        result.busLines.results.bindings.forEach(b => {
            const val = b.busLine?.value;
            if (val && !linesMap[val]) {
                linesMap[val] = { busLine: val, lineDesc: b.lineDesc?.value || '', lineUri: b.lineUri?.value || '' };
            }
        });

        const lines = Object.values(linesMap);
        if (lines.length === 0) {
            list.textContent = 'No lines found.';
            return;
        }

        lines.forEach((line, i) => {
            const lineColor = getLineColor(i);
            allLinesData.push({ lineObj: line, agencyUri, stopName, lineColor, routes: null });

            const button = document.createElement('button');
            const dot = document.createElement('div');
            dot.className = 'color-dot';
            dot.style.backgroundColor = lineColor;

            button.appendChild(dot);
            button.appendChild(document.createTextNode(`${line.busLine} - ${line.lineDesc}`));
            button.onclick = () => handleLineClick(i);
            list.appendChild(button);
        });
    };

    const fetchBusLinesFromStop = async (uri, signal) => {
        const params = new URLSearchParams({ serviceUri: uri, requestFrom: 'user', format: 'json', uid: uid, lang: 'it' });
        return await (await fetch(`${apiBase}?${params.toString()}`, { signal })).json();
    };

    const fetchBusStops = async (coordinates, signal) => {
        const radius = (parseFloat(container.querySelector('#searchBarRadius').value) || 200) / 1000;
        const params = new URLSearchParams({
            selection: `${coordinates[1]};${coordinates[0]}`,
            requestFrom: 'user',
            categories: categories,
            maxResults: '100',
            maxDists: String(radius),
            format: 'json',
            uid: pinUid,
            lang: 'it',
            geometry: 'true'
        });
        return await (await fetch(`${apiBase}?${params.toString()}`, { signal })).json();
    };

    const addBusStopPins = (result) => {
        const features = result?.BusStops?.features || [];
        features.forEach(f => {
            const uri = f.properties.serviceUri;
            if (!uri) return;
            currentlyShowedPinsUri.push(uri);
            parent.$('body').trigger({
                type: 'addSelectorPin',
                target: MAP_WIDGET_TARGET,
                passedData: {
                    query: `${apiBase}?serviceUri=${encodeURIComponent(uri)}&requestFrom=user&format=json&uid=${pinUid}&lang=it`,
                    targets: '',
                    eventGenerator: $(container),
                    color1: '#ffdb4d',
                    color2: '#fff5cc',
                    queryType: 'Default',
                    desc: uri,
                    display: 'pins',
                    pinattr: 'square',
                    pincolor: '#959595'
                }
            });
        });
    };

    const populateFermateTab = (result) => {
        const list = container.querySelector('#fermateList');
        list.innerHTML = '';
        const features = [...(result?.BusStops?.features || []), ...(result?.Services?.features || [])];

        if (features.length === 0) {
            list.textContent = 'No stops found in the area.';
            return;
        }

        features.forEach(f => {
            const uri = f.properties.serviceUri;
            const name = f.properties.name || 'Fermata';
            const btn = document.createElement('button');
            btn.textContent = name;
            btn.onclick = () => clickOnBusStopOnGui(uri);
            list.appendChild(btn);
        });
    };

    const clickOnBusStopOnGui = async (uri) => {
        if (isLoading || appState !== 'idle') return;

        const signal = startNav();
        drawEpoch++;
        const myEpoch = drawEpoch;

        removeTrattaPaths();

        if (oldCoordinates && oldCoordinates.length > 0) {
            parent.$('body').trigger({
                type: 'removeGeoInfoPin',
                target: MAP_WIDGET_TARGET,
                passedData: [{ eventType: 'GeoInfoPin', id: 'mapPoint', lat: oldCoordinates[1], lng: oldCoordinates[0], textHtml: '' }]
            });
            oldCoordinates = [];
        }

        const staleUris = [...currentlyShowedPinsUri];
        removeBusStopPins();

        setTimeout(() => {
            for (const u of staleUris) {
                parent.$('body').trigger({
                    type: 'removeSelectorPin',
                    target: MAP_WIDGET_TARGET,
                    passedData: {
                        query: `${apiBase}?serviceUri=${encodeURIComponent(u)}&requestFrom=user&format=json&uid=${pinUid}&lang=it`,
                        desc: u,
                        display: ''
                    }
                });
            }
        }, 1500);

        setLoading(true);
        try {
            const res = await fetchBusLinesFromStop(uri, signal);
            if (myEpoch !== drawEpoch) return;
            populateLinesTab(res);
            setAppState('stop_selected');
            switchTab('tabLines');
        } catch (e) {
            if (e.name !== 'AbortError') console.error(e);
        } finally {
            setLoading(false);
        }
        void drawAllLinesInBackground(myEpoch, signal);
    };

    const addLocationPin = (coords) => {
        const pin = [{ "eventType": "GeoInfoPin", "id": "mapPoint", "lat": coords[1], "lng": coords[0], "textHtml": "Ricerca qui" }];
        if (oldCoordinates && oldCoordinates.length > 0) {
            parent.$('body').trigger({
                type: 'removeGeoInfoPin',
                target: MAP_WIDGET_TARGET,
                passedData: [{ "eventType": "GeoInfoPin", "id": "mapPoint", "lat": oldCoordinates[1], "lng": oldCoordinates[0], "textHtml": "" }]
            });
        }
        oldCoordinates = coords;
        parent.$('body').trigger({ type: 'addGeoInfoPin', target: MAP_WIDGET_TARGET, passedData: pin });
    };

    // --- INITIALIZATION ---
    container.querySelectorAll('.tab').forEach(t => t.onclick = () => switchTab(t.id));

    container.querySelector('#btnModificaTratta').onclick = () => {
        if (editMode) exitEditMode();
        else if (editRouteUri) enterEditMode();
    };

    container.querySelector('#btnResetMap').onclick = () => resetApp();

    parent.document.addEventListener("receiveBusStopDetails", async (e) => {
        if (editMode || isLoading || appState !== 'idle') return;
        const signal = startNav();
        drawEpoch++;
        const myEpoch = drawEpoch;
        let coords = [tc(e.detail.passedData.longitude), tc(e.detail.passedData.latitude)];

        removeTrattaPaths();
        removeBusStopPins();
        addLocationPin(coords);
        setLoading(true);

        try {
            const result = await fetchBusStops(coords, signal);
            if (myEpoch !== drawEpoch) return;
            populateFermateTab(result);
            addBusStopPins(result);
            switchTab('tabFermate');
        } catch (err) {
            if (err.name !== 'AbortError') console.error(err);
        } finally {
            setLoading(false);
        }
    });

    parent.document.addEventListener("clickOnBusStop", async (e) => {
        if (editMode || isLoading || appState !== 'idle') return;
        await clickOnBusStopOnGui(e.detail.passedData.serviceUri);
    });

    parent.document.addEventListener("clickOnBusRoute", (e) => {
        if (editMode || isLoading || appState !== 'stop_selected') return;
        const routeUri = e.detail.routeUri;
        const lineIndex = allLinesData.findIndex(ld => ld.routes && ld.routes.some(r => r.route === routeUri));
        if (lineIndex !== -1) handleLineClick(lineIndex);
    });

    parent.document.addEventListener('trattaRouteError', (e) => {
        if (!editMode) return;
        showEditError(e.detail?.message || 'Errore di routing: il server non risponde');
    });

    parent.document.addEventListener('editStopMoved', (e) => {
        if (!editMode) return;
        console.log(`[MAP-EVENT] Inizio spostamento fermata #${e.detail.stopIndex + 1}`);
        activateStopEdit(e.detail.stopIndex);
    });

    parent.document.addEventListener('editStopDropped', (e) => {
        if (!editMode) return;
        const { stopIndex, lat, lng } = e.detail;
        if (editStops[stopIndex]) {
            editStops[stopIndex].lat = lat;
            editStops[stopIndex].lng = lng;
        }
    });

    const openSaveModal = () => {
        const json = JSON.stringify(buildExportJson(), null, 2);
        const modal = container.querySelector('#saveModal');
        container.querySelector('#saveJsonOutput').textContent = json;
        modal.style.display = 'flex';
    };

    // ----------------------------------
    // - CUSTOM MODULES: THESIS - START -
    // ----------------------------------
    const handleDirectExport = async () => {
        const standardData = buildStandardizedPayload();
        const dateTag = new Date().toISOString().slice(0, 10);
        const lineTag = sanitizeGtfsId(editLineName, 'export');
        if (typeof JSZip !== 'undefined') {
            try {
                const zip = new JSZip();
                zip.file('agency.txt', toCsv(standardData.agency, ['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang']));
                zip.file('calendar_dates.txt', toCsv(standardData.calendar_dates, ['service_id', 'date', 'exception_type']));
                zip.file('routes.txt', toCsv(standardData.routes, ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color', 'route_text_color']));
                zip.file('trips.txt', toCsv(standardData.trips, ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'trip_short_name', 'direction_id', 'shape_id']));
                zip.file('stops.txt', toCsv(standardData.stops, ['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon']));
                zip.file('stop_times.txt', toCsv(standardData.stop_times, ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'shape_dist_traveled']));
                zip.file('shapes.txt', toCsv(standardData.shapes, ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence', 'shape_dist_traveled']));
                const zipBlob = await zip.generateAsync({ type: 'blob' });
                const url = URL.createObjectURL(zipBlob);
                const a = document.createElement('a');
                a.href = url;
                const fileName = `gtfs_${lineTag}_${dateTag}.zip`;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                console.log(`[EXPORT] Archivio GTFS .zip scaricato -> ${fileName}`);
                return;
            } catch (err) {
                console.warn('[EXPORT] Errore generazione ZIP, attivo fallback JSON:', err);
            }
        } else {
            console.warn('[EXPORT] JSZip non disponibile, attivo fallback JSON');
        }
        const jsonText = JSON.stringify(standardData, null, 2);
        const blob = new Blob([jsonText], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `gtfs_relazionale_${lineTag}_${dateTag}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    container.querySelector('#btnDirectExport').addEventListener('click', handleDirectExport);
    // ----------------------------------
    // - CUSTOM MODULES: THESIS -  END  -
    // ----------------------------------

    container.querySelector('#btnSaveEdit').addEventListener('click', openSaveModal);
    container.querySelector('#btnEsciModifica').addEventListener('click', exitEditMode);

    container.querySelector('#btnCloseModal').addEventListener('click', () => {
        container.querySelector('#saveModal').style.display = 'none';
    });

    container.querySelector('#btnCopyJson').addEventListener('click', () => {
        const text = container.querySelector('#saveJsonOutput').textContent;
        navigator.clipboard.writeText(text).then(() => {
            const btn = container.querySelector('#btnCopyJson');
            const orig = btn.textContent;
            btn.textContent = 'Copiato!';
            setTimeout(() => { btn.textContent = orig; }, 1500);
        });
    });

    container.querySelector('#btnTimeUpdateOnly').addEventListener('click', () => {
        container.querySelector('#timeUpdateModal').style.display = 'none';
        if (pendingTimeUpdateCallback) {
            pendingTimeUpdateCallback(false);
            pendingTimeUpdateCallback = null;
        }
    });

    container.querySelector('#btnTimeUpdateAll').addEventListener('click', () => {
        container.querySelector('#timeUpdateModal').style.display = 'none';
        if (pendingTimeUpdateCallback) {
            pendingTimeUpdateCallback(true);
            pendingTimeUpdateCallback = null;
        }
    });

    container.querySelector('#btnDownloadJson').addEventListener('click', () => {
        const text = container.querySelector('#saveJsonOutput').textContent;
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tratta_${editLineName || 'export'}_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    const agenciesRes = await (async () => {
        try {
            return await (await fetch(apiBase + 'tpl/agencies/')).json();
        } catch (e) {
            return [];
        }
    })();

    allAgencies = agenciesRes?.Agencies || [];
    const agenciesList = container.querySelector('#agenciesList');

    allAgencies.forEach(agency => {
        const button = document.createElement('button');
        button.textContent = agency.name;
        button.onclick = () => handleAgencyClick(agency);
        agenciesList.appendChild(button);
    });

    const handleAgencyClick = async (agency) => {
        if (isLoading || appState !== 'idle') return;
        const signal = startNav();
        setLoading(true);

        const agencyInfoDiv = container.querySelector('#agencyInfo');
        agencyInfoDiv.innerHTML = `<strong>Agenzia:</strong> ${agency.name}`;
        agencyInfoDiv.style.display = 'block';
        container.querySelector('#agenciesList').innerHTML = '';

        try {
            const data = await (await fetch(`${apiBase}tpl/bus-lines/?agency=${agency.agency}`, { signal })).json();
            const linesList = container.querySelector('#linesList');
            linesList.innerHTML = '';

            if (!data.BusLines) {
                linesList.textContent = 'No lines found.';
                return;
            }

            let lineIndex = 0;
            data.BusLines.forEach(line => {
                const lineColor = getLineColor(lineIndex++);
                const button = document.createElement('button');
                const dot = document.createElement('div');
                dot.className = 'color-dot';
                dot.style.backgroundColor = lineColor;

                button.appendChild(dot);
                button.appendChild(document.createTextNode(`Line ${line.shortName} - ${line.longName}`));
                button.onclick = () => handleAgencyLineClick({ busLine: line.shortName }, agency.agency, lineColor);
                linesList.appendChild(button);
            });
            switchTab('tabLines');
        } catch (e) {
            if (e.name !== 'AbortError') console.error(e);
        } finally {
            setLoading(false);
        }
    };

    // ----------------------------------
    // - CUSTOM MODULES: THESIS - START -
    // ----------------------------------
    parent.document.addEventListener('trattaRouteUpdated', (e) => {
        if (!editMode) return;
        showEditError(null);
        editCurrentWkt = e.detail.wkt;
        computeStopsDistances(editCurrentWkt, editStops);
        const fromIndex = activeEditStopIndex > 0 ? activeEditStopIndex : 0;
        interpolateTimetable(editStops, stopCurrentTimes, fromIndex, osmRouteCache);

        editStops.forEach((s, idx) => {
            const el = container.querySelector(`#editStopTime-${idx}`);
            if (el && stopCurrentTimes[idx]) {
                if (el.tagName === 'INPUT') {
                    el.value = stopCurrentTimes[idx];
                } else {
                    el.textContent = stopCurrentTimes[idx];
                    el.style.cssText = `font-size: 0.8rem !important; white-space: nowrap !important; font-weight: 600 !important; color: ${editRouteColor} !important;`;
                }
            }
        });

        clearTimeout(routeUpdateTimer);
        routeUpdateTimer = setTimeout(() => {
            removeTrattaPaths();
            drawRoutePath(editRouteUri, e.detail.wkt, editRouteColor);
        }, 150);
    });
    // ----------------------------------
    // - CUSTOM MODULES: THESIS -  END  -
    // ----------------------------------

})();