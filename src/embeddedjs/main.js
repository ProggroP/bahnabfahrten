// ---------------------------------------------------------------------------
// Bahnauskunft - Abfahrten der Linien RE6/RE7/RE70/RB60/RB61/RB71
// Alloy / Moddable, nur Emery (200x228) und Gabbro (260x260 rund)
//
// Der Watch-Code macht nur Anzeige + Bedienung. Netzwerk, Standortwahl,
// Linienfilter und Zeitfenster passieren in src/pkjs/index.js auf dem Telefon.
//
// Jeder Eintrag ist dreizeilig:
//
//   RE7  16:53  +5
//   ab Kiel Hbf
//   nach Hamburg-Altona
//
// Der Startbahnhof steht dabei, weil man an ihm Stoerungen erkennt - faengt
// ein Zug woanders an als sonst, sieht man es sofort. Die Namen werden
// ausgeschrieben; passt eine Zeile nicht in die Breite, faellt sie auf die
// kleinere Schrift zurueck.
// ---------------------------------------------------------------------------

import Poco from "commodetto/Poco";
import Button from "pebble/button";
import Message from "pebble/message";
import Touch from "embedded:sensor/Touch/pebble";

// ---------------------------- Layout-Konstanten ----------------------------

const W = screen.width;
const H = screen.height;
const IS_ROUND = (W === H);              // Round 2 hat identische width und height

const PAD       = IS_ROUND ? 16 : 6;
const HEAD_H    = IS_ROUND ? 44 : 32;
// Drei Textzeilen je Eintrag, in grosser Schrift. Damit passen auf den
// runden Gabbro zwei Verbindungen aufs Bild, auf den Emery gut zwei.
const ROW_H     = IS_ROUND ? 104 : 84;
const COL_GAP   = 8;
const LINE_GAP  = 3;                     // zwischen den drei Textzeilen
const LIST_Y    = HEAD_H;
const LIST_H    = H - HEAD_H;

// Feste Spalte fuer die Uhrzeit, damit die Zeiten untereinander stehen.
// Nur fuer rechteckige Displays, auf dem runden Gabbro wird zentriert.
const LABEL_W_BIG   = 68;
const LABEL_W_SMALL = 58;

// Eine Tastenbetaetigung schiebt eine Zeile weiter, ein Tipper eine Seite.
const SCROLL_STEP = ROW_H;
const PAGE_STEP   = Math.max(ROW_H, LIST_H - ROW_H);

// Ein Tipper ist eine Beruehrung, die sich um weniger als so viele Punkte
// bewegt hat. Alles darueber ist ein Zieh-Vorgang.
const TAP_SLOP = 8;

// Auto-Refresh und Rate-Limit (dbf erlaubt 1 Anfrage pro Station und Minute)
const AUTO_REFRESH_MS  = 90000;
const MIN_GAP_MS       = 55000;          // automatisch
const MIN_GAP_FORCE_MS = 8000;           // per Select-Taste oder Kopf-Tipper
const BOOT_RETRY_MS    = 10000;          // bis die erste Antwort da ist

// -------------------------------- Farben -----------------------------------

const render = new Poco(screen);

const C_BG      = render.makeColor(255, 255, 255);
const C_FG      = render.makeColor(0, 0, 0);
const C_HEAD_BG = render.makeColor(0, 0, 0);
const C_HEAD_FG = render.makeColor(255, 255, 255);
const C_DELAY   = render.makeColor(255, 0, 0);
const C_DEST    = render.makeColor(90, 90, 90);
const C_RULE    = render.makeColor(170, 170, 170);

// -------------------------------- Fonts ------------------------------------
//
// Erlaubt ist nur, was in der Tabelle gFonts der Firmware steht (xsHost.c):
// Gothic-Regular und Gothic-Bold in 9, 14, 18, 24, 28 und 36, dazu
// Bitham-Black 30, Bitham-Bold 42, Bitham-Light 42, Roboto-Condensed 21 und
// DroidSerif-Bold 28. Leco, Roboto-Bold 49 und die Bitham-Medium-Schnitte
// fallen weg - das sind Ziffern- oder Teilzeichensaetze und koennen kein
// "Hamburg-Altona".
//
// Groesser als Gothic-Bold 36 waere Bitham-Bold 42; das passt auf dem Gabbro
// durchaus ("RE7 08:53" braucht dort etwa 230 Punkte). Es bleibt trotzdem bei
// 36: mit 42 rutschen die beiden Namenszeilen so weit nach unten, dass die
// untere regelmaessig gekuerzt wird.
//
// Ein Name oder eine Groesse ausserhalb der Tabelle laesst new render.Font
// werfen; die App zeichnet dann nie und man sieht nur ein weisses Bild.

const F_HEAD = new render.Font("Gothic-Bold", IS_ROUND ? 18 : 14);

// Leitern von gross nach klein. Gezeichnet wird die groesste Schrift, die in
// der Breite noch passt - am runden Rand also automatisch eine kleinere.
const F_TRAIN = IS_ROUND
	? [new render.Font("Gothic-Bold", 36), new render.Font("Gothic-Bold", 28),
	   new render.Font("Gothic-Bold", 24)]
	: [new render.Font("Gothic-Bold", 28), new render.Font("Gothic-Bold", 24),
	   new render.Font("Gothic-Bold", 18)];

const F_SUB = IS_ROUND
	? [new render.Font("Gothic-Bold", 24), new render.Font("Gothic-Bold", 18),
	   new render.Font("Gothic-Bold", 14)]
	: [new render.Font("Gothic-Bold", 18), new render.Font("Gothic-Bold", 14)];

// Die Verspaetung steht neben der Uhrzeit und darf kleiner sein
const F_DELAY = IS_ROUND
	? new render.Font("Gothic-Bold", 24)
	: new render.Font("Gothic-Bold", 18);

// -------------------------------- Zustand ----------------------------------

// Der empfangene Text bleibt als ein einziges Stueck liegen; gemerkt werden
// nur die Anfangspositionen der Zeilen. Ein eigener String je Zeile sprengt
// den XS-Heap der Uhr: bei 80 Zeilen bricht die App mit "fxAbort memory
// full" ab, und Elmshorn hat tagsueber rund 66 Abfahrten in sechs Stunden.
// Ein Zahlenfeld ist viel billiger, und das teure split() ueber die ganze
// Liste faellt ganz weg. Zerlegt wird nur, was gerade zu sehen ist.
let blob      = "";          // "RE7|22:06|+5|Kiel|Alt\nRE6|..."
let offs      = [];          // Startposition jeder Zeile in blob
let station   = "";
let status    = "Start ...";
let scrollY   = 0;
let maxScroll = 0;
let pending   = null;        // Chunk-Puffer waehrend des Empfangs
let lastReq   = 0;
let gotAnswer = false;       // irgendeine Antwort vom Telefon erhalten

// ------------------------------- Zeichnen ----------------------------------

function rowCount() {
	return offs.length;
}

// Schneidet Zeile i aus dem Textblock. Wird nur fuer die sichtbaren Zeilen
// gerufen, also vier- bis fuenfmal je Bild.
function rowAt(i) {
	const start = offs[i];
	const end = blob.indexOf("\n", start);
	return end < 0 ? blob.substring(start) : blob.substring(start, end);
}

function textW(str, font) {
	return render.getTextWidth(str, font);
}

function drawCentered(str, font, color, y) {
	render.drawText(str, font, color, (W - textW(str, font)) >> 1, y);
}

// Nutzbare Breite in Hoehe einer Textzeile. Auf dem runden Gabbro verengt
// sich die Flaeche nach oben und unten erheblich: auf halber Hoehe sind es
// 260 Punkte, 15 Punkte ueber dem unteren Rand nur noch gut 100. Eine Zeile,
// die in der Mitte bequem passt, wurde am Rand sonst abgeschnitten -
// "nach Hamburg-Altona" stand dort als "-h Hamburg-Alt" auf dem Schirm.
//
// Bezug ist die Mitte der Zeile. Die Ecken der Randbuchstaben ragen damit
// rechnerisch minimal ueber die Sehne hinaus, was man nicht sieht; nimmt man
// stattdessen die Unterkante, faellt die Schrift unnoetig frueh eine Stufe
// kleiner aus.
function usableWidth(y, h) {
	if (!IS_ROUND)
		return W - 2 * PAD;

	const r = W / 2;
	const dy = Math.abs(y + (h >> 1) - r);
	if (dy >= r)
		return 0;
	return 2 * Math.sqrt(r * r - dy * dy) - 10;
}

// Letzte Rettung, wenn auch die kleine Schrift nicht reicht: proportional
// kuerzen. Ein einziges Messen statt einer Schleife - das laeuft je Bild
// dreimal und soll nicht bremsen.
function fitText(s, font, maxW) {
	const w = textW(s, font);
	if (w <= maxW)
		return s;
	const n = Math.max(1, ((s.length * maxW / w) | 0) - 1);
	return s.slice(0, n) + ".";
}

// Kopfzeile: Station und, sobald gescrollt werden kann, die Position
function headText() {
	const name = station || "Bahn";
	const n = rowCount();
	if (!n)
		return name;
	const first = Math.min(n, Math.floor(scrollY / ROW_H) + 1);
	return name + "  " + first + "/" + n;
}

// Groesste Schrift aus der Leiter, mit der der Text noch in maxW passt.
// Reicht keine, kommt die kleinste zurueck und der Aufrufer kuerzt.
function pickFont(s, ladder, maxW) {
	for (let i = 0; i < ladder.length; i++) {
		if (textW(s, ladder[i]) <= maxW)
			return ladder[i];
	}
	return ladder[ladder.length - 1];
}

// Die Zugzeile: Linie, Sollzeit, Verspaetung. Auf dem runden Display
// zentriert, weil linksbuendig in den Ecken abgeschnitten wuerde.
// Die Verspaetung steht eine Stufe kleiner daneben - sie ist die kuerzeste
// Angabe und darf der Uhrzeit nicht die Breite wegnehmen.
function drawTrainLine(label, time, delay, y) {
	const avail = usableWidth(y, F_TRAIN[0].height);
	const font = pickFont(label + " " + time, F_TRAIN, avail);

	const wl = textW(label, font);
	const wt = textW(time, font);
	const wd = delay ? textW(delay, F_DELAY) : 0;
	const total = wl + COL_GAP + wt + (wd ? COL_GAP + wd : 0);

	// Grundlinien angleichen, damit die kleinere Verspaetung nicht oben klebt
	const dy = font.ascent - F_DELAY.ascent;

	if (IS_ROUND) {
		let x = (W - total) >> 1;
		render.drawText(label, font, C_FG, x, y);
		x += wl + COL_GAP;
		render.drawText(time, font, C_FG, x, y);
		if (wd)
			render.drawText(delay, F_DELAY, C_DELAY, x + wt + COL_GAP, y + dy);
		return;
	}

	// Rechteckig: Uhrzeit in fester Spalte, damit die Zeiten fluchten
	const labelW = Math.max(LABEL_W_SMALL, Math.min(LABEL_W_BIG, wl + COL_GAP));
	render.drawText(label, font, C_FG, PAD, y);
	render.drawText(time, font, C_FG, PAD + labelW, y);
	if (wd)
		render.drawText(delay, F_DELAY, C_DELAY,
			PAD + labelW + wt + COL_GAP, y + dy);
}

// Ausgeschriebene Ortsnamen werden schnell breit. Passt die Zeile nicht in
// die an dieser Hoehe verfuegbare Breite, wird sie eine Stufe kleiner
// gesetzt und erst danach gekuerzt.
function drawSubLineAt(s, color, y) {
	if (!s)
		return;

	const avail = usableWidth(y, F_SUB[0].height);
	if (avail <= 0)
		return;

	const font = pickFont(s, F_SUB, avail);
	const text = fitText(s, font, avail);

	if (IS_ROUND)
		drawCentered(text, font, color, y);
	else
		render.drawText(text, font, color, PAD, y);
}

function drawSubLine(s, y) {
	drawSubLineAt(s, C_DEST, y);
}

// raw ist "Linie|hh:mm|+N|Ziel|Startbahnhof". Zerlegt wird erst hier, also
// nur fuer die zwei bis drei Eintraege, die gerade zu sehen sind.
function drawRow(raw, y) {
	const p = raw.split("|");

	drawTrainLine(p[0], p[1], p[2] || "", y + 2);

	let ty = y + 2 + F_TRAIN[0].height + LINE_GAP;
	drawSubLine(p[4] ? "ab " + p[4] : "", ty);

	ty += F_SUB[0].height + LINE_GAP;
	drawSubLine(p[3] ? "nach " + p[3] : "", ty);

	render.fillRectangle(C_RULE, PAD, y + ROW_H - 1, W - 2 * PAD, 1);
}

function drawScrollbar() {
	if (maxScroll <= 0)
		return;
	const trackH = LIST_H - 8;
	const thumbH = Math.max(16, (trackH * LIST_H / (rowCount() * ROW_H)) | 0);
	const thumbY = LIST_Y + 4 + (((trackH - thumbH) * scrollY / maxScroll) | 0);
	render.fillRectangle(C_RULE, W - 3, LIST_Y + 4, 2, trackH);
	render.fillRectangle(C_FG, W - 4, thumbY, 3, thumbH);
}

function draw() {
	render.begin();
	render.fillRectangle(C_BG, 0, 0, W, H);

	render.fillRectangle(C_HEAD_BG, 0, 0, W, HEAD_H);
	drawCentered(headText(), F_HEAD, C_HEAD_FG, (HEAD_H - F_HEAD.height) >> 1);

	if (!rowCount()) {
		drawSubLineAt(status, C_FG, LIST_Y + 30);
		render.end();
		return;
	}

	render.clip(0, LIST_Y, W, LIST_H);
	const n = rowCount();
	for (let i = 0; i < n; i++) {
		const y = LIST_Y + i * ROW_H - scrollY;
		if (y + ROW_H < LIST_Y)
			continue;
		if (y > LIST_Y + LIST_H)
			break;
		drawRow(rowAt(i), y);
	}
	render.clip();

	if (!IS_ROUND)
		drawScrollbar();

	render.end();
}

// ------------------------------- Scrollen ----------------------------------

function clampScroll() {
	maxScroll = Math.max(0, rowCount() * ROW_H - LIST_H);
	if (scrollY > maxScroll)
		scrollY = maxScroll;
	if (scrollY < 0)
		scrollY = 0;
}

function setScroll(v) {
	maxScroll = Math.max(0, rowCount() * ROW_H - LIST_H);
	if (v < 0)
		v = 0;
	if (v > maxScroll)
		v = maxScroll;
	if (v !== scrollY) {
		scrollY = v;
		draw();
	}
}

// --------------------------------- Touch -----------------------------------
//
// Der Sensor liefert nur die aktuellen Kontaktpunkte, kein began/moved/ended.
// Das muss man selbst mitfuehren:
//   undefined -> kein neues Sample
//   []        -> Liftoff
//   [{x,y}]   -> Touchdown ODER Bewegung, nicht unterscheidbar
//
// Ziehen scrollt. Ein Tipper ohne Bewegung blaettert eine Seite - in die
// obere Haelfte zurueck, in die untere weiter -, im Kopf aktualisiert er.
let tStartY = undefined;
let tStartScroll = 0;
let tLastY = 0;
let tMoved = false;

function onTap(y) {
	if (y < HEAD_H)
		requestUpdate(true);
	else if (y < LIST_Y + (LIST_H >> 1))
		setScroll(scrollY - PAGE_STEP);
	else
		setScroll(scrollY + PAGE_STEP);
}

const touch = new Touch({
	onSample() {
		const points = this.sample();
		if (!points)
			return;

		if (points.length === 0) {           // Finger weg
			if (tStartY !== undefined && !tMoved)
				onTap(tLastY);
			tStartY = undefined;
			tMoved = false;
			return;
		}

		const y = points[0].y;
		tLastY = y;

		if (tStartY === undefined) {
			tStartY = y;
			tStartScroll = scrollY;
			tMoved = false;
			return;
		}

		if (!tMoved && Math.abs(y - tStartY) < TAP_SLOP)
			return;

		tMoved = true;
		setScroll(tStartScroll + (tStartY - y));
	}
});

// -------------------------------- Tasten -----------------------------------
//
// Hoch/runter blaettert zeilenweise, gedrueckt halten wiederholt und laeuft
// dadurch schnell durch. Select aktualisiert, Zurueck beendet die App.
new Button({
	types: ["up", "down", "select"],
	single: { repeat: 250 },
	onPush(down, type) {
		if (!down)
			return;
		if (type === "up")
			setScroll(scrollY - SCROLL_STEP);
		else if (type === "down")
			setScroll(scrollY + SCROLL_STEP);
		else
			requestUpdate(true);
	}
});

// ---------------------------- Telefon-Anbindung ----------------------------

function applyRows(text) {
	blob = text;
	offs = [];

	// Zeilenanfaenge einsammeln, ohne die Zeilen selbst anzulegen
	let p = 0;
	while (p < blob.length) {
		const nl = blob.indexOf("\n", p);
		const end = (nl < 0) ? blob.length : nl;
		// Mindestens Linie und Uhrzeit muessen drinstehen
		if (blob.indexOf("|", p) > p && blob.indexOf("|", p) < end)
			offs.push(p);
		if (nl < 0)
			break;
		p = nl + 1;
	}

	status = offs.length ? "" : "Nichts gefunden";
	scrollY = 0;
	clampScroll();
	draw();
}

// WICHTIG: Diese Liste muss Zeichen fuer Zeichen und in derselben Reihenfolge
// der messageKeys in package.json entsprechen. Pebble bildet die Namen
// positionsweise auf Zahlen ab - ein verschobener Eintrag vertauscht stumm die
// Werte, und beide Richtungen sind ohne jede Fehlermeldung tot.
//
// Frueher stand hier zusaetzlich ein "dummy" ganz vorn, weil die
// CloudPebble-Projekteinstellungen einen solchen Eintrag fuehrten. Er ist auf
// beiden Seiten entfallen; entscheidend ist allein, dass die Listen gleich
// bleiben.
const message = new Message({
	keys: ["REQUEST", "STATION", "STATUS", "TOTAL", "IDX", "ROWS"],
	onReadable() {
		try {
			handleMessage(this.read());
		}
		catch (e) {
			status = "Fehler: " + e;
			blob = "";
			offs = [];
			pending = null;
			draw();
		}
	},
	onWritable() {
		requestUpdate(false);
	},
	onSuspend() {
		console.log("Message suspendiert");
	}
});

function handleMessage(m) {
	if (m.has("STATION"))
		station = m.get("STATION");

	if (m.has("STATUS")) {
		const s = m.get("STATUS");
		if (s) {
			status = s;
			if (!rowCount())
				draw();
		}
	}

	if (m.has("TOTAL")) {
		gotAnswer = true;
		const total = m.get("TOTAL") | 0;
		if (total === 0) {
			blob = "";
			offs = [];
			status = "Nichts gefunden";
			scrollY = 0;
			pending = null;
			draw();
		}
		else {
			pending = { total, parts: [], got: 0 };
		}
	}

	if (m.has("ROWS") && pending) {
		const idx = m.has("IDX") ? (m.get("IDX") | 0) : 0;
		if (pending.parts[idx] === undefined) {
			pending.parts[idx] = m.get("ROWS");
			pending.got++;
		}
		if (pending.got >= pending.total) {
			applyRows(pending.parts.join("\n"));
			pending = null;
		}
	}
}

function requestUpdate(force) {
	const now = Date.now();
	const gap = force ? MIN_GAP_FORCE_MS : MIN_GAP_MS;
	if (lastReq && (now - lastReq) < gap)
		return;

	if (!rowCount()) {
		status = "Lade ...";
		draw();
	}

	try {
		message.write(new Map([["REQUEST", 1]]));
		lastReq = now;
	}
	catch (e) {
		status = "Sendefehler";
		draw();
		console.log("write fehlgeschlagen: " + e);
	}
}

watch.addEventListener("connected", function () {
	if (watch.connected.pebblekit && !gotAnswer)
		requestUpdate(true);
});

// Bis die erste Antwort vom Telefon da ist, regelmaessig nachfassen.
// Abbruch an gotAnswer, nicht an der Zeilenzahl: sonst wird bei leerer
// Trefferliste endlos weitergefragt und das Rate-Limit greift zu.
const boot = setInterval(function () {
	if (gotAnswer) {
		clearInterval(boot);
		return;
	}
	requestUpdate(true);
}, BOOT_RETRY_MS);

setInterval(() => requestUpdate(false), AUTO_REFRESH_MS);

draw();
