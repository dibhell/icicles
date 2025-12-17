# Icicles Chamber

![Icicles Chamber](public/ici.png)

Generatywna aplikacja audio-wizualna w przegladarce. Tworzysz lodowe kulki,
ktore poruszaja sie w przestrzeni 3D i uruchamiaja dzwieki przy zderzeniach.

## O co chodzi
- Interaktywna scena Canvas z kulkami/amoebami w przestrzeni 3D.
- Dzwiek generowany przez Web Audio (synteza lub wczytany sample).
- Pokretla steruja fizyka, przestrzenia i zachowaniem obiektow.
- Mixer z transportem, glosnoscia, EQ i miernikiem VU.

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
- Web Audio API, Canvas 2D
- Tailwind (CDN)
