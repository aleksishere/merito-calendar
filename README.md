# merito-calendar

Skrypt Tampermonkey, który eksportuje plan zajęć z [meritogo.pl/calendar](https://meritogo.pl/calendar) do pliku `.ics` (Google Calendar, Apple Calendar, Outlook).

## Instalacja

1. Zainstaluj rozszerzenie [Tampermonkey](https://www.tampermonkey.net/).
2. Otwórz panel Tampermonkey → „Utwórz nowy skrypt”, wklej zawartość `merito-calendar.user.js` i zapisz.
3. Wejdź na https://meritogo.pl/calendar (zalogowany) i odśwież stronę.

## Użycie

W prawym dolnym rogu kalendarza pojawi się przycisk **📅 Eksport .ics**. Po kliknięciu podajesz zakres dat, a skrypt pobiera plik `merito_<od>_<do>.ics`.

## Jak to działa

- Skrypt odpytuje to samo API co strona: `GET https://api.meritogo.pl/v2/class_schedule/v3/schedule/student`, w kawałkach po 3 miesiące.
- Autoryzacja: tak jak strona – ciasteczka sesji, a jeśli w localStorage jest ważny token (klucze `_t`, `_sk`, `_t_exp`), także nagłówek `Authorization`. `context-id` skrypt pobiera z `/v2/drupal/v1/contexts`.
- Godziny są zapisane w UTC, więc kalendarz pokaże je w Twojej strefie czasowej.
- Zajęcia o statusie `moveToWithoutDate` trafiają do pliku jako `[Przeniesione]` ze statusem `CANCELLED`.
- Każde wydarzenie ma stałe `UID`, więc ponowny import aktualizuje istniejące wpisy zamiast je dublować (w kalendarzach, które to wspierają).
