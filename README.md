# Transit & Air Planner

A static web app that plans public transport trips between a start and a destination, shows live air quality, and tells you whether to wear a mask for the walking parts of the trip.

**Live site:** https://cleoncheng2000.github.io/project2/

## Features
- Start / destination search with autocomplete (or 📍 to use your current location)
- Public transport routes with departure/arrival times, transfers, and walking time
- Real-time data (with a **Live** badge and delays) wherever the transit agency publishes it
- Current US AQI, PM2.5, and PM10 at the start and at the destination
- Mask advice based on the worse AQI, minutes of walking on the selected route, and whether you're in a sensitive group
- Route map

## Data sources (free, no API keys)
- [Transitous](https://transitous.org): geocoding and transit routing (MOTIS)
- [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api)
- [OpenStreetMap](https://www.openstreetmap.org) tiles via [Leaflet](https://leafletjs.com)

## Run locally
There's no build step. Serve the folder, for example:
```
python -m http.server 8000
```
Then open http://localhost:8000.
