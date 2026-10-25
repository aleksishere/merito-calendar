// ==UserScript==
// @name         Merito – eksport kalendarza 
// @namespace    https://github.com/aleksishere/merito-calendar
// @version      1.0.3
// @description  Dodaje na meritogo.pl/calendar przycisk, który pobiera plan zajęć jako plik .ics
// @match        https://meritogo.pl/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const API = 'https://api.meritogo.pl';
  const CATEGORIES = 'CLASS_SCHEDULE,STUDY,OFFICE_HOURS,EVENTS';
  const CHUNK_MONTHS = 3;

  const FORMS = {
    WY: 'Wykład',
    CW: 'Ćwiczenia',
    LA: 'Laboratorium',
    SE: 'Seminarium',
    LE: 'Lektorat',
    PR: 'Projekt',
    KW: 'Konwersatorium',
  };

  // --- Budowanie pliku .ics ---

  function icsEscape(text) {
    return String(text ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  // RFC 5545: linie dłuższe niż 75 bajtów zawija się, kolejne zaczynają spacją.
  function foldLine(line) {
    const bytes = new TextEncoder();
    const parts = [];
    let current = '';
    for (const ch of line) {
      const limit = parts.length === 0 ? 75 : 74;
      if (bytes.encode(current + ch).length > limit) {
        parts.push(current);
        current = ch;
      } else {
        current += ch;
      }
    }
    parts.push(current);
    return parts.join('\r\n ');
  }

  function utcStamp(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  function dateOnly(iso) {
    return iso.slice(0, 10).replace(/-/g, '');
  }

  function addDays(yyyymmdd, days) {
    const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + days));
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  }

  function eventToVevent(ev, now) {
    const form = ev.classFormShortName || '';
    const moved = ev.status === 'moveToWithoutDate';
    const otherStatus = ev.status && ev.status !== 'planned' && !moved ? ev.status : '';

    let summary = ev.name + (form ? ` (${form})` : '');
    if (moved) summary = `[Przeniesione] ${summary}`;
    else if (otherStatus) summary = `[${otherStatus}] ${summary}`;

    const rooms = (ev.rooms || []).map((r) => (typeof r === 'string' ? r : r?.name)).filter(Boolean);
    const address = ev.localization && !Array.isArray(ev.localization) ? ev.localization.address : '';
    const location = [rooms.join(', '), address].filter(Boolean).join(' – ') || (ev.isOnline ? 'Online' : '');

    const lecturers = (ev.lecturers || []).map((l) => l.fullName).filter(Boolean);
    const description = [
      form && `Forma: ${FORMS[form] || form}`,
      lecturers.length && `Prowadzący: ${lecturers.join(', ')}`,
      ev.isOnline && 'Zajęcia online',
      ev.description,
    ].filter(Boolean).join('\n');

    const lines = ['BEGIN:VEVENT', `UID:${ev.id}@meritogo.pl`, `DTSTAMP:${utcStamp(now)}`];
    if (ev.timed === false) {
      const start = dateOnly(ev.start);
      const end = dateOnly(ev.end || ev.start);
      lines.push(`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${addDays(end, 1)}`);
    } else {
      lines.push(`DTSTART:${utcStamp(new Date(ev.start))}`, `DTEND:${utcStamp(new Date(ev.end))}`);
    }
    lines.push(`SUMMARY:${icsEscape(summary)}`);
    if (location) lines.push(`LOCATION:${icsEscape(location)}`);
    if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
    if (ev.categoryName) lines.push(`CATEGORIES:${icsEscape(ev.categoryName)}`);
    if (moved) lines.push('STATUS:CANCELLED');
    lines.push('END:VEVENT');
    return lines;
  }

  function buildIcs(events, now = new Date()) {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//merito-calendar//meritogo.pl export//PL',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Merito – plan zajęć',
      'X-WR-TIMEZONE:Europe/Warsaw',
    ];
    const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));
    for (const ev of sorted) lines.push(...eventToVevent(ev, now));
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
  }

  // Rok akademicki: od 1 sierpnia do 30 września kolejnego roku.
  function academicYearRange(today = new Date()) {
    const y = today.getMonth() >= 7 ? today.getFullYear() : today.getFullYear() - 1;
    return { from: `${y}-08-01`, to: `${y + 1}-09-30` };
  }

  function monthChunks(from, to, months) {
    const chunks = [];
    let start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    while (start <= end) {
      const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, start.getUTCDate()));
      const chunkEnd = new Date(Math.min(next.getTime() - 86400000, end.getTime()));
      chunks.push({ from: start.toISOString().slice(0, 10), to: chunkEnd.toISOString().slice(0, 10) });
      start = next;
    }
    return chunks;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildIcs, academicYearRange, monthChunks, foldLine };
    return;
  }

  // --- Przeglądarka: zapytania do API w imieniu zalogowanego użytkownika ---

  let contextId = '';

  async function apiGet(path) {
    // Uwierzytelnienie przez ciasteczka sesji.
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Language': 'pl_PL',
      'Accept-Language': 'pl_PL',
      'X-Timezone': 'Europe/Warsaw',
    };
    if (contextId) headers['context-id'] = contextId;
    const res = await fetch(API + path, { credentials: 'include', headers });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${path} → HTTP ${res.status}. Sesja wygasła – odśwież stronę lub zaloguj się ponownie.`);
    }
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
  }

  async function ensureContextId() {
    if (contextId) return;
    const data = await apiGet('/v2/drupal/v1/contexts');
    const id = data?.appSettings?.defaultContext?.id;
    if (!id) throw new Error('Nie udało się ustalić context-id (czy jesteś zalogowany?)');
    contextId = id;
  }

  async function fetchSchedule(from, to) {
    await ensureContextId();
    const byId = new Map();
    for (const chunk of monthChunks(from, to, CHUNK_MONTHS)) {
      const qs = new URLSearchParams({ dateFrom: chunk.from, dateTo: chunk.to, categoryNames: CATEGORIES });
      const data = await apiGet(`/v2/class_schedule/v3/schedule/student?${qs.toString().replace(/%2C/g, ',')}`);
      for (const ev of data.events || []) byId.set(ev.id, ev);
    }
    return [...byId.values()];
  }

  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --- Przycisk ---

  let button;

  async function onExport() {
    const def = academicYearRange();
    const input = prompt('Zakres dat do eksportu (RRRR-MM-DD RRRR-MM-DD):', `${def.from} ${def.to}`);
    if (input === null) return;
    const [from, to] = input.trim().split(/\s+/);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) {
      alert('Niepoprawny zakres dat. Użyj formatu RRRR-MM-DD RRRR-MM-DD.');
      return;
    }

    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Pobieranie…';
    try {
      const events = await fetchSchedule(from, to);
      if (!events.length) {
        alert('Brak zajęć w wybranym zakresie.');
        return;
      }
      download(`merito_${from}_${to}.ics`, buildIcs(events));
      button.textContent = `Pobrano ${events.length} wydarzeń`;
      setTimeout(() => (button.textContent = label), 3000);
    } catch (err) {
      console.error('[merito-calendar]', err);
      alert(`Eksport nie powiódł się: ${err.message}`);
      button.textContent = label;
    } finally {
      button.disabled = false;
    }
  }

  function ensureButton() {
    if (!document.body) return;
    if (!button) {
      button = document.createElement('button');
      button.textContent = '📅 Eksport .ics';
      button.type = 'button';
      Object.assign(button.style, {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: 99999,
        padding: '10px 16px',
        border: 'none',
        borderRadius: '8px',
        background: '#c8102e',
        color: '#fff',
        font: '600 14px system-ui, sans-serif',
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0,0,0,.25)',
      });
      button.addEventListener('click', onExport);
    }
    // Aplikacja to SPA – przycisk pokazujemy tylko na /calendar.
    const onCalendar = location.pathname.startsWith('/calendar');
    if (onCalendar && !button.isConnected) document.body.appendChild(button);
    if (!onCalendar && button.isConnected) button.remove();
  }

  setInterval(ensureButton, 1000);
  document.addEventListener('DOMContentLoaded', ensureButton);
})();
