# Architektura aplikacji

## Przeplyw sterowania
- `App.tsx` trzyma stan pokretel, laczy ustawienia fizyki i audio, oraz
  ogranicza aktualizacje silnika do jednej na klatke.
- `components/Visualizer.tsx` rysuje scene na Canvas 2D, symuluje obiekty w 3D
  i wyzwala dzwiek przy kolizjach.
- `services/audioEngine.ts` buduje graf Web Audio (synteza lub sample, poglos,
  ping-pong delay, EQ, limiter, analyser).

## Warstwy UI
- `components/Mixer.tsx` to transport, glosnosc, EQ i VU meter.
- `components/Knob.tsx` to pokretlo z obsluga myszy i dotyku.
- `types.ts` opisuje kontrakty danych (AudioSettings, PhysicsSettings).

## Dzwiek
- Dwa tryby: SYNTH (oscylator) i SAMPLE (wczytany plik).
- Skala dzwiekowa zalezy od parametru Tone.
- Panorama i filtracja zalezna od pozycji obiektu w scenie.

## Render
- Pseudo-3D z perspektywa (`DEPTH`, `FOCAL_LENGTH`).
- Obiekty deformuja sie w czasie, a zdarzenia zapisuje log w HUD.
