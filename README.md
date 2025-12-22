# Glass Room

![Glass Room](public/ici.png)

Generatywna aplikacja audio-wizualna w przegladarce. Tworzysz lodowe kulki,
ktore poruszaja sie w przestrzeni 3D i uruchamiaja dzwieki przy zderzeniach.

## O co chodzi
- Interaktywna scena Canvas z kulkami/amoebami w przestrzeni 3D.
- Dzwiek generowany przez Web Audio (synteza lub wczytany sample).
- Pokretla steruja fizyka, przestrzenia i zachowaniem obiektow.
- Mixer z transportem, glosnoscia, EQ i miernikiem VU.
- Master LO-FI na torze master (Drive/Tape/Crush + bitcrusher w AudioWorklet).
- Gyro rings steruja PAN/DEPTH/WIDTH, a lissajous pokazuje stereo.

## Muzyka i skale
- Pokretlo MUSIC przewija liste skal (snap do krokow), klik na ikone otwiera mini-picker.
- Ustawiasz ROOT (C-B), SCALE oraz opcje: Avoid Leading Tone, No Immediate Repeat, No 3rd.
- Podglad pokazuje nazwe skali, interwaly i nuty w skali.
- Biblioteka skal: Ionian, Aeolian, Dorian, Mixolydian, Phrygian, pentatoniki,
  Quartal, Sus2/Sus4, harmonic/melodic minor, whole tone, chromatic, drone.

## Uruchomienie lokalne
1. `npm install`
2. `npm run dev`
3. Otworz `http://localhost:5173`
4. Kliknij "Enter Chamber", aby odblokowac audio (wymog przegladarek).

## Dokumentacja
- [docs/STEROWANIE.md](docs/STEROWANIE.md) - opis kontrolek i gestow.
- [docs/ARCHITEKTURA.md](docs/ARCHITEKTURA.md) - struktura kodu i modulow.

## Technologie
- React 19, TypeScript, Vite
- Web Audio API, AudioWorklet, Canvas 2D
- Tailwind (CDN)
