// ---------------------------------------------------------------------------
// Bahnauskunft - Telefonteil
//
// Liefert die Abfahrten der ueberwachten Linien fuer die naechsten zwei
// Stunden, beginnend eine halbe Stunde ab jetzt.
//
// Zwei Quellen, weil keine allein beides kann:
//
//   IRIS-Fahrplan  (iris.noncd.db.de, plan/<eva>/<jjmmtt>/<hh>)
//       Der Soll-Fahrplan, stundenweise abrufbar. Liefert mit l="RE70"
//       genau die Liniennummer, nach der gefiltert wird, und mit ppth den
//       Laufweg, aus dem das Ziel kommt. Beides steht in der
//       db-infoscreen-Antwort nicht so sauber drin.
//
//   db-infoscreen (dbf.finalrewind.org, mode=json&version=3)
//       Verspaetungen und Ausfaelle. Wird ueber Bahnhof, Linie und Sollzeit
//       auf den Fahrplan gelegt.
//
// Der IRIS-Fahrplan kennt keine Verspaetungen, db-infoscreen keine saubere
// Liniennummer - daher die Kombination. Sie traegt ausserdem beliebig weite
// Zeitfenster: db-infoscreen bricht bei 40 Eintraegen ab, tagsueber sind das
// keine zwei Stunden. Die Stundenplaene aendern sich innerhalb eines Tages
// nicht und werden zwischengespeichert - im Dauerbetrieb bleibt pro
// Aktualisierung nur der kleine db-infoscreen-Abruf uebrig.
// ---------------------------------------------------------------------------

// ------------------------------ Einstellungen ------------------------------

var IRIS_URL = "https://iris.noncd.db.de/iris-tts/timetable/";

// Eigene db-infoscreen-Instanz? Dann hier eintragen, z.B.
// "http://homeassistant.local:8092/"
var DBF_URL = "https://dbf.finalrewind.org/";

// Ueberwachte Linien, in beide Richtungen. Exakter Vergleich, kein
// Praefixtreffer - sonst wuerde "RE7" auch auf "RE70" passen.
var LINES = ["RE7", "RE70", "RE6", "RB60", "RB61", "RB71"];

// Stationsgruppen. Je nach Standort wird eine davon abgefragt.
// eva ist die IRIS-Nummer, name zugleich der db-infoscreen-Name.
//
// toward ist der Richtungsfilter: mindestens einer dieser Orte muss im
// Laufweg NACH dem Halt vorkommen. Die Liniennummer allein genuegt nicht,
// denn beide Fahrtrichtungen tragen dieselbe Nummer - in Elmshorn stuenden
// sonst auch die Zuege in der Liste, die aus Hamburg kommen und weiter nach
// Kiel oder Westerland fahren.
//
// Ab Hamburg braucht es keinen Filter: was dort abfaehrt, haelt in Elmshorn.
// Pinneberg gehoert bei Elmshorn dazu, weil dort bei Stoerungen gern Schluss
// ist - so ein Zug bringt einen immerhin ein Stueck weit.
//
// In Hamburg werden beide Bahnhoefe abgefragt. Wegen Bauarbeiten beginnt und
// endet dort zurzeit kein Zug am Hauptbahnhof, RE6, RE7 und RE70 fahren
// allesamt ab Altona - im Fahrplan taucht der Hbf deshalb momentan gar nicht
// auf. Das ist voruebergehend: sobald die Zuege wieder am Hbf beginnen,
// stehen sie ohne weiteres Zutun in der Liste.
var SET_ELMSHORN = {
	label: "Elmshorn",
	toward: ["Hamburg Hbf", "Hamburg-Altona", "Pinneberg"],
	stations: [
		{ eva: "8000092", name: "Elmshorn" }
	]
};

var SET_HAMBURG = {
	label: "Hamburg",
	toward: null,
	stations: [
		{ eva: "8002549", name: "Hamburg Hbf" },
		{ eva: "8002553", name: "Hamburg-Altona" }
	]
};

var REF_ELMSHORN = { lat: 53.7536, lon: 9.6533 };
var REF_HAMBURG  = { lat: 53.5528, lon: 10.0067 };

// Zeitfenster in Minuten ab jetzt: zwei Stunden, beginnend bei jetzt + 30.
var MIN_AHEAD = 30;
var MAX_AHEAD = 30 + 2 * 60;

// Obergrenze der Liste. Mit dem Richtungsfilter bleiben in Elmshorn sechs
// Abfahrten je Stunde Richtung Hamburg, also rund zwoelf im Zeitfenster;
// ab Hamburg sind es noch weniger.
//
// Die Grenze ist gemessen, nicht geraten: 40 Zeilen zeigt die Uhr
// einwandfrei, bei 80 bricht sie mit "xsPlatform.c fxAbort memory full"
// ab und startet neu. 40 laesst also gut das Dreifache des Erwartbaren zu
// und bleibt im geprueften Bereich.
var MAX_ROWS  = 40;

// Bahnhofsnamen bleiben ausgeschrieben ("Hamburg-Altona", nicht "Alt").
// Gekuerzt wird erst jenseits dieser Laenge.
var MAX_NAME  = 18;
var CHUNK     = 20;          // Zeilen pro AppMessage (Puffer ist 8200 Byte)

var HTTP_TIMEOUT = 20000;

// Einmal pro Abruf die Filterstufen ins Log
var DEBUG = true;

// Fallback, wenn kein Standort verfuegbar ist
var FALLBACK = REF_ELMSHORN;

// ------------------------------- Hilfsmittel -------------------------------

function dist2(lat, lon, ref) {
	// Aequidistante Naeherung, reicht fuer den Vergleich zweier Punkte
	var dLat = lat - ref.lat;
	var dLon = (lon - ref.lon) * 0.6;    // cos(53.6 Grad)
	return dLat * dLat + dLon * dLon;
}

function pad2(n) {
	return (n < 10 ? "0" : "") + n;
}

function unescapeXml(s) {
	return String(s)
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function attrOf(tag, name) {
	var m = tag.match(new RegExp(name + "=\"([^\"]*)\""));
	return m ? unescapeXml(m[1]) : "";
}

// Bahnhofsnamen werden ausgeschrieben angezeigt - "Hamburg-Altona" und
// "Kiel Hbf" bleiben also stehen. Nur der Klammerzusatz faellt weg
// ("Westerland(Sylt)" -> "Westerland"), und ganz lange Namen werden gekappt.
function shortName(s) {
	var out = String(s || "");
	out = out.replace(/\s*\([^)]*\)/g, "");
	out = out.replace(/\s+$/, "");
	if (out.length > MAX_NAME)
		out = out.slice(0, MAX_NAME - 1).replace(/\s+$/, "") + ".";
	return out;
}

// Doppelter Praefix aus zusammengesetzten Feldern:
// "RERE8" -> "RE8", "RBRB71" -> "RB71". "RE70" bleibt unangetastet.
function normLine(s) {
	return String(s || "").replace(/\s+/g, "").toUpperCase()
		.replace(/^([A-Z]+)\1/, "$1");
}

function isWatched(line) {
	return LINES.indexOf(line) >= 0;
}

// IRIS-Zeitstempel sind deutsche Wanduhrzeit: "2608272252" = 27.08.26, 22:52.
// Gerechnet wird durchgehend in diesem Format. Weil es von der groessten zur
// kleinsten Einheit laeuft und feste Breite hat, ist der Vergleich zweier
// Stempel zugleich der Zeitvergleich - auch ueber Mitternacht hinweg.
//
// Die eigene Wanduhrzeit kommt aus UTC plus Sommerzeitregel, nicht aus der
// Ortszeit des Geraets, und nie ueber new Date(jahr, monat, tag, ...).
// Zwei Gruende: pypkjs im Emulator legt diesen Konstruktor als UTC aus und
// liegt ausserdem dauerhaft auf CET ohne Sommerzeit, also ein halbes Jahr
// lang eine Stunde daneben. Und auf Reisen haette die App sonst ein
// verschobenes Fenster gezeigt. getUTC* ist in jeder Umgebung eindeutig.

// Letzter Sonntag eines Monats als UTC-Zeitpunkt 00:00 (Monat 0-basiert)
function lastSundayUtc(year, month) {
	var firstNext = Date.UTC(year, month + 1, 1);
	var wd = new Date(firstNext).getUTCDay();      // 0 = Sonntag
	return firstNext - (wd === 0 ? 7 : wd) * 86400000;
}

// EU-Sommerzeit: letzter Sonntag im Maerz 01:00 UTC bis
// letzter Sonntag im Oktober 01:00 UTC.
function berlinOffsetMs(ms) {
	var y = new Date(ms).getUTCFullYear();
	var start = lastSundayUtc(y, 2) + 3600000;
	var end   = lastSundayUtc(y, 9) + 3600000;
	return (ms >= start && ms < end) ? 7200000 : 3600000;
}

function stampOf(ms) {
	var d = new Date(ms + berlinOffsetMs(ms));
	return pad2(d.getUTCFullYear() % 100) + pad2(d.getUTCMonth() + 1) +
		pad2(d.getUTCDate()) + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes());
}

function isStamp(s) {
	return typeof s === "string" && /^\d{10}$/.test(s);
}

function hhmmOfStamp(pt) {
	return pt.slice(6, 8) + ":" + pt.slice(8, 10);
}

// ------------------------------ Datenabruf ---------------------------------

function fetchText(url, cb) {
	var xhr = new XMLHttpRequest();
	xhr.open("GET", url, true);
	xhr.timeout = HTTP_TIMEOUT;
	xhr.onload = function () {
		if (xhr.status >= 200 && xhr.status < 300)
			cb(null, xhr.responseText);
		else
			cb("HTTP " + xhr.status, "");
	};
	xhr.onerror   = function () { cb("Netzfehler", ""); };
	xhr.ontimeout = function () { cb("Timeout", ""); };
	xhr.send();
}

// --------------------------- IRIS: Soll-Fahrplan ---------------------------

// Passt der Laufweg nach dem Halt zur gewuenschten Richtung?
function matchesToward(onward, toward) {
	if (!toward || !toward.length)
		return true;

	var hay = String(onward).toLowerCase();
	for (var i = 0; i < toward.length; i++) {
		if (hay.indexOf(String(toward[i]).toLowerCase()) >= 0)
			return true;
	}
	return false;
}

// Ein <s>-Block je Halt. Gebraucht werden beide Kindelemente:
//
//   <ar ... ppth="Kiel Hbf|Neumünster|Wrist"/>   Laufweg VOR diesem Halt
//   <dp ... l="RE7" pt="2608271653" ppth="Hamburg-Altona"/>   und danach
//
// Aus dem <ar>-Laufweg kommt der Startbahnhof: der erste Eintrag. Fehlt das
// <ar> ganz, beginnt der Zug hier. Fehlt umgekehrt das <dp>, endet er hier
// und faellt von allein weg.
//
// Geteilt wird an "<s ", nicht ueber ein Paar aus Anfangs- und Endmarke:
// das kommt ohne mehrzeilige Suche aus und stoert sich nicht daran, ob der
// Block als <s .../> oder mit </s> geschrieben ist.
function parsePlan(xml, stationName, toward) {
	var out = [];
	var blocks = String(xml).split("<s ");

	for (var i = 1; i < blocks.length; i++) {
		var b = blocks[i];

		var dpm = b.match(/<dp\s[^>]*>/);
		if (!dpm)
			continue;
		var dp = dpm[0];

		var line = normLine(attrOf(dp, "l"));
		if (!isWatched(line))
			continue;

		var pt = attrOf(dp, "pt");
		if (!isStamp(pt))
			continue;

		var onward = attrOf(dp, "ppth");
		if (!matchesToward(onward, toward))
			continue;

		var origin = stationName;
		var arm = b.match(/<ar\s[^>]*>/);
		if (arm) {
			var before = attrOf(arm[0], "ppth");
			if (before)
				origin = before.split("|")[0];
		}

		var path = onward.split("|");
		out.push({
			line:   line,
			pt:     pt,
			dest:   shortName(path[path.length - 1]),
			origin: shortName(origin)
		});
	}
	return out;
}

// Stundenplaene aendern sich untertags nicht -> merken.
// Schluessel ist "<eva>|<jjmmtt>|<hh>".
var planCache = {};

function cacheKey(eva, slot) {
	return eva + "|" + slot.ymd + "|" + slot.hh;
}

// Die Stundentoepfe, die das Zeitfenster beruehren. Der Topf der aktuellen
// Stunde ist dabei, obwohl das Fenster erst in 30 Minuten beginnt - Zuege
// tauchen gelegentlich im Nachbartopf auf.
function hourSlots(nowMs) {
	var slots = [];
	var lastBucket = stampOf(nowMs + MAX_AHEAD * 60000).slice(0, 8);
	var t = nowMs;

	// Die Obergrenze ist nur eine Reissleine gegen eine Endlosschleife,
	// erreicht wird sie nie: das Fenster ist gut sechs Stunden breit.
	for (var i = 0; i < 12; i++) {
		var s = stampOf(t);
		slots.push({ ymd: s.slice(0, 6), hh: s.slice(6, 8) });
		if (s.slice(0, 8) >= lastBucket)
			break;
		t += 3600000;
	}
	return slots;
}

// Vergangene Stunden aus dem Zwischenspeicher werfen, damit er nicht waechst
function prunePlanCache(valid) {
	var keep = {}, k;
	for (var i = 0; i < valid.length; i++)
		keep[valid[i]] = 1;
	for (k in planCache) {
		if (!keep[k])
			delete planCache[k];
	}
}

// Ein Auftrag je Bahnhof und Stundentopf. Die Liste wird der Reihe nach
// abgearbeitet, nicht alle Abrufe auf einmal - das ist schonender fuer IRIS,
// und ab dem zweiten Durchlauf greift ohnehin der Zwischenspeicher.
function loadPlan(set, cb) {
	var slots = hourSlots(Date.now());
	var jobs  = [];
	var keys  = [];
	var s, i;

	for (s = 0; s < set.stations.length; s++) {
		for (i = 0; i < slots.length; i++) {
			var key = cacheKey(set.stations[s].eva, slots[i]);
			keys.push(key);
			jobs.push({ station: set.stations[s], slot: slots[i], key: key });
		}
	}
	prunePlanCache(keys);

	var all = [], fetched = 0, lastErr = null;

	// Der Abfahrtsbahnhof haengt am Auftrag, nicht am Fahrplaneintrag - der
	// Zwischenspeicher haelt deshalb nur den reinen Plan, das Etikett kommt
	// erst hier dazu. Es wird nur intern gebraucht: um die Echtzeitdaten des
	// richtigen Bahnhofs zuzuordnen und um Dubletten zu erkennen. Angezeigt
	// wird stattdessen der Startbahnhof aus dem Fahrplan.
	function withStation(list, name) {
		var out = [];
		for (var k = 0; k < list.length; k++) {
			out.push({
				line:   list[k].line,
				pt:     list[k].pt,
				dest:   list[k].dest,
				origin: list[k].origin,
				st:     name
			});
		}
		return out;
	}

	function step(n) {
		if (n >= jobs.length) {
			if (DEBUG)
				console.log("Plan: " + set.stations.length + " Bahnhoefe x " +
					slots.length + " Stunden, " + fetched + " neu geladen, " +
					all.length + " Abfahrten der Linien");
			cb(lastErr, all);
			return;
		}

		var job = jobs[n];

		if (planCache[job.key]) {
			all = all.concat(withStation(planCache[job.key], job.station.name));
			step(n + 1);
			return;
		}

		var url = IRIS_URL + "plan/" + job.station.eva + "/" +
			job.slot.ymd + "/" + job.slot.hh;

		fetchText(url, function (err, xml) {
			if (err) {
				lastErr = err;
			}
			else {
				var list = parsePlan(xml, job.station.name, set.toward);
				planCache[job.key] = list;
				all = all.concat(withStation(list, job.station.name));
				fetched++;
			}
			step(n + 1);
		});
	}

	step(0);
}

// ------------------------ db-infoscreen: Echtzeit --------------------------

// Ergebnis ist eine Tabelle "<Abfahrtsbahnhof>|<Linie>|<hh:mm>" -> { delay,
// cancelled }, ueber alle Bahnhoefe der Gruppe hinweg. Der Bahnhof gehoert
// in den Schluessel: derselbe Zug faehrt in Hamburg erst am Hbf und ein paar
// Minuten spaeter in Altona, das sind zwei verschiedene Eintraege.
function loadLive(set, cb) {
	var map = {}, open = set.stations.length, lastErr = null, total = 0;

	set.stations.forEach(function (station) {
		var url = DBF_URL + encodeURIComponent(station.name) +
			"?mode=json&version=3";

		fetchText(url, function (err, body) {
			if (err) {
				lastErr = err;
				done();
				return;
			}

			var data;
			try {
				data = JSON.parse(body);
			}
			catch (e) {
				lastErr = "JSON kaputt";
				done();
				return;
			}

			var deps = (data && data.departures) || [];

			for (var i = 0; i < deps.length; i++) {
				var d = deps[i];
				var line = normLine(d.line || d.train);
				var sd   = d.scheduledDeparture;
				if (!line || !sd)
					continue;

				var delay = 0;
				if (typeof d.delayDeparture === "number")
					delay = d.delayDeparture;
				else if (d.delayDeparture)
					delay = parseInt(d.delayDeparture, 10) || 0;

				map[station.name + "|" + line + "|" + sd] = {
					delay: delay,
					cancelled: !!d.isCancelled
				};
				total++;
			}

			if (DEBUG)
				console.log("Echtzeit: " + deps.length + " Eintraege von " +
					station.name);
			done();
		});
	});

	function done() {
		if (--open === 0)
			cb(lastErr, map);
	}
}

// ------------------------------ Aufbereitung -------------------------------

function buildRows(plan, live) {
	var now  = Date.now();
	var from = stampOf(now + MIN_AHEAD * 60000);
	var to   = stampOf(now + MAX_AHEAD * 60000);
	var out  = [];
	var seen = {};
	var dropped = { zeit: 0, doppelt: 0, ausfall: 0 };

	if (DEBUG)
		console.log("Fenster " + hhmmOfStamp(from) + " bis " + hhmmOfStamp(to));

	for (var i = 0; i < plan.length; i++) {
		var p = plan[i];

		if (p.pt < from || p.pt > to) {
			dropped.zeit++;
			continue;
		}

		var time = hhmmOfStamp(p.pt);

		// Fluegelzuege stehen zweimal im Plan - gleiche Linie, gleiche Zeit,
		// gleiches Ziel. Fuer den Fahrgast ist das ein Zug, also nur eine
		// Zeile; welcher der beiden Zugteile den Startbahnhof stellt, ist
		// dabei zufaellig (Richtung Hamburg etwa Kiel oder Flensburg, die
		// Teile werden unterwegs gekuppelt). Trennen sie sich stattdessen,
		// bleiben beide erhalten, weil dann das Ziel verschieden ist.
		//
		// Der Abfahrtsbahnhof gehoert in den Schluessel, sonst wuerde in
		// Hamburg der Halt am zweiten Bahnhof verschluckt.
		var key = p.st + "|" + p.line + "|" + time + "|" + p.dest;
		if (seen[key]) {
			dropped.doppelt++;
			continue;
		}
		seen[key] = 1;

		var rt = live[p.st + "|" + p.line + "|" + time];
		if (rt && rt.cancelled) {
			dropped.ausfall++;
			continue;
		}

		// Sortiert wird nach Sollzeit, nicht nach erwarteter Abfahrt: die
		// Liste soll beim Blaettern nicht unter dem Finger umspringen, wenn
		// sich eine Verspaetung aendert. Das "+N" steht ja daneben.
		out.push({
			sort: p.pt,
			text: p.line + "|" + time + "|" +
				(rt && rt.delay > 0 ? "+" + rt.delay : "") + "|" + p.dest +
				"|" + (p.origin || "")
		});
	}

	if (DEBUG)
		console.log("Aussortiert: " + dropped.zeit + " ausserhalb des Fensters, " +
			dropped.doppelt + " doppelt, " + dropped.ausfall + " ausgefallen");

	out.sort(function (a, b) {
		return a.sort < b.sort ? -1 : (a.sort > b.sort ? 1 : 0);
	});
	return out.slice(0, MAX_ROWS).map(function (e) { return e.text; });
}

// ------------------------------- Versand -----------------------------------

function sendSeq(msgs, i) {
	if (i >= msgs.length)
		return;
	Pebble.sendAppMessage(msgs[i],
		function () { sendSeq(msgs, i + 1); },
		function (e) {
			console.log("AppMessage " + i + " fehlgeschlagen: " + JSON.stringify(e));
			sendSeq(msgs, i + 1);
		});
}

function sendResult(stationLabel, lines, note) {
	var msgs = [];
	msgs.push({ STATION: stationLabel, STATUS: note || "" });

	var chunks = [];
	for (var i = 0; i < lines.length; i += CHUNK)
		chunks.push(lines.slice(i, i + CHUNK).join("\n"));

	msgs.push({ TOTAL: chunks.length });
	for (var j = 0; j < chunks.length; j++)
		msgs.push({ IDX: j, ROWS: chunks[j] });

	sendSeq(msgs, 0);
}

function sendError(text) {
	sendSeq([{ STATUS: text }, { TOTAL: 0 }], 0);
}

// -------------------------------- Ablauf -----------------------------------

// Ein Durchlauf kann sieben HTTP-Abrufe umfassen. Ohne die Sperre wuerde
// der 90-Sekunden-Takt einen noch laufenden Durchlauf ueberholen.
var busy = false;

function update(lat, lon) {
	if (busy)
		return;
	busy = true;

	var nearHamburg = dist2(lat, lon, REF_HAMBURG) < dist2(lat, lon, REF_ELMSHORN);
	var set = nearHamburg ? SET_HAMBURG : SET_ELMSHORN;

	console.log("Standort " + lat.toFixed(3) + "/" + lon.toFixed(3) + " -> " +
		set.stations.map(function (s) { return s.name; }).join(", "));

	loadPlan(set, function (planErr, plan) {
		// Ohne Echtzeitdaten laesst sich immer noch der Sollfahrplan zeigen
		loadLive(set, function (liveErr, live) {
			busy = false;

			var lines = buildRows(plan, live);
			console.log(plan.length + " Planabfahrten, " + lines.length +
				" im Fenster");

			if (!lines.length && planErr) {
				sendError("Fahrplan: " + planErr);
				return;
			}
			sendResult(set.label, lines, liveErr ? "ohne Echtzeit" : "");
		});
	});
}

function locateAndUpdate() {
	navigator.geolocation.getCurrentPosition(
		function (pos) { update(pos.coords.latitude, pos.coords.longitude); },
		function (err) {
			console.log("Standort fehlgeschlagen: " + err.message);
			update(FALLBACK.lat, FALLBACK.lon);
		},
		{ enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 }
	);
}

Pebble.addEventListener("ready", function () {
	console.log("Bahnauskunft PKJS bereit");
	locateAndUpdate();
	setInterval(locateAndUpdate, 90000);
});

Pebble.addEventListener("appmessage", function (e) {
	if (e && e.payload && e.payload.REQUEST)
		locateAndUpdate();
});
